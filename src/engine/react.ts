/**
 * Classe principal do harness ReAct (spec §5) com a API de gerador do
 * suggests.md §3A: `run()` é `async *run(prompt)` que emite `AgentEvent` em
 * tempo real e retorna `TExecutionResult` ao final.
 *
 * - Loop ReAct: pensamento/ação/observação via stream (spec §4).
 * - Tool calling: itens `function_call` do round são executados e devolvidos
 *   como `function_call_output` no histórico (self-healing incluso, §C).
 * - Gestão de contexto (§B): poda determinística por padrão; com um
 *   `summarizer` opt-in, o prefixo antigo é condensado por LLM mantendo as
 *   últimas interações intactas (fallback determinístico como safety net).
 * - `cancel()` via AbortSignal habilita graceful shutdown (spec §4).
 * - HITL (§D): ferramentas `sensitive` pausam o loop para aprovação humana.
 *
 * O transport é injetável (`responses`): testes offline usam um provider fake;
 * o default chama `client.responses.create({ stream:true })` contra o Ollama.
 *
 * @example Mecanismo completo de uma execução:
 * ```ts
 * import { ReAct, createLLMSummarizer } from "./engine/mod.ts";
 *
 * const agent = new ReAct(
 *   {
 *     model: "qwen3:4b",
 *     system_prompt: "Você é um assistente que transforma textos.",
 *     maxRounds: 6,
 *   },
 *   {
 *     approvalTimeoutMs: 30_000,          // HITL: auto-recusa se sumir
 *     summarizer: createLLMSummarizer(callLLM), // poda por LLM (§B)
 *   },
 * );
 * agent.registryTool(uppercaseTool);
 *
 * for await (const event of agent.run("Converte 'oi' para maiúsculas")) {
 *   switch (event.type) {
 *     case "reasoning":  process.stdout.write(event.token); break;
 *     case "tool_call":  console.log(`\n[chama ${event.tool}]`); break;
 *     case "tool_interrupt":
 *       agent.resume(confirm(`Permitir ${event.tool}?`));
 *       break;
 *     case "tool_result": console.log(`[${event.ok ? "ok" : "erro"}] ${event.output}`); break;
 *   }
 * }
 * ```
 * @module react
 */
import type OpenAI from "openai";
import type { Responses } from "openai/resources/responses";
import type {
  AgentEvent,
  PromptPart,
  TAgent,
  TExecutionResult,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolResult,
} from "./types.ts";
import { mapResponseStream, type RoundOutcome } from "./events.ts";
import { ToolRegistry, toOpenAITool } from "./tools.ts";
import { estimateTokens, type TokenEstimator } from "./tokens.ts";
import type { Summarizer } from "./summarizer.ts";
import { createClient } from "./client.ts";
import { loadRuntimeConfig } from "./config.ts";
import { appendLineLocked, createRunWorkspace, type Workspace } from "./env.ts";

const DEFAULT_MAX_CONTEXT_ITEMS = 40;
const DEFAULT_MAX_CONTEXT_CHARS = 120_000;
const DEFAULT_SUMMARIZE_KEEP_RECENT = 6;
const DEFAULT_CONTEXT_TOKEN_RATIO = 0.8;

/**
 * Requisição de um único round ao provider (modelo de baixo nível).
 *
 * É o que o harness monta a cada iteração do loop e entrega ao `ResponsesCall`
 * injetado (ou ao default que chama `client.responses.create`).
 *
 * @example
 * ```ts
 * const request: ResponsesCallRequest = {
 *   model: "qwen3:4b",
 *   instructions: "Você é um assistente.",
 *   input: [{ role: "user", content: [{ type: "input_text", text: "oi" }] }],
 *   tools: [toOpenAITool(uppercaseTool)],
 *   reasoning: { effort: "high" },
 *   signal,
 * };
 * ```
 */
export interface ResponsesCallRequest {
  /** Modelo para este round. */
  model: string;
  /** Instruções de sistema (fora do histórico). */
  instructions: string;
  /** Histórico acumulado (mensagens + function_call/output). */
  input: Responses.ResponseInputItem[];
  /** Ferramentas registradas, convertidas para o formato do SDK. */
  tools: Responses.Tool[];
  /** Nível de raciocínio (passthrough; presente apenas se configurado). */
  reasoning?: { effort?: ThinkingLevel | null };
  /** Chamadas simultâneas (`parallel_tool_calls` no request do round). */
  parallelToolCalls?: boolean;
  /** Structured output (passthrough): injetado no body como `format`. */
  format?: string | object;
  /** Params do modelo (Ollama-nativos: num_ctx, keep_alive, ...) — `extra_body`. */
  modelParams?: Record<string, unknown>;
  /** Signal da execução — `cancel()` aborta o stream do round. */
  signal: AbortSignal;
}

/**
 * Provider do transport: retorna o iterável de eventos do stream.
 *
 * O default usa `client.responses.create({ stream: true })`. Em testes,
 * injeta-se um provider fake que devolve eventos sintéticos — permitindo a
 * suíte offline (sem rede).
 *
 * @example
 * ```ts
 * const fakeLLM: ResponsesCall = async ({ signal }) => {
 *   const events: Responses.ResponseStreamEvent[] = [
 *     { type: "response.output_text.delta", delta: "Olá", ... },
 *   ];
 *   const controller = new AbortController();
 *   signal.addEventListener("abort", () => controller.abort());
 *   return asyncIterable(events, controller.signal); // helper de teste
 * };
 * ```
 */
export type ResponsesCall = (
  request: ResponsesCallRequest,
) => Promise<AsyncIterable<Responses.ResponseStreamEvent>>;

export function defaultResponsesCall(client: OpenAI): ResponsesCall {
  return async (request) => {
    const body = {
      model: request.model,
      instructions: request.instructions,
      input: request.input as unknown as Responses.ResponseInput,
      tools: request.tools,
      reasoning: request.reasoning ?? undefined,
      parallel_tool_calls: request.parallelToolCalls,
      stream: true,
      ...(request.format !== undefined && { format: request.format }),
      ...(request.modelParams ?? {}),
    };
    const stream = await client.responses.create(
      body as unknown as Parameters<typeof client.responses.create>[0],
      { signal: request.signal },
    ) as unknown as AsyncIterable<Responses.ResponseStreamEvent>;
    return stream;
  };
}

/**
 * Opções opcionais do construtor de {@link ReAct}.
 *
 * Tudo aqui é opcional; os defaults cobrem o uso mais comum (Ollama local).
 *
 * @example
 * ```ts
 * const options: ReActOptions = {
 *   responses: fakeLLM,              // testes offline (default: cliente real)
 *   maxContextItems: 40,             // default 40
 *   maxContextChars: 120_000,        // default 120k chars
 *   summarizer: createLLMSummarizer(fakeLLM), // opt-in (§B)
 *   summarizeKeepRecent: 6,          // 2 interações intactas
 *   approvalTimeoutMs: 0,            // HITL sem deadline (default)
 * };
 * ```
 */
export interface ReActOptions {
  /** Provider injetado (tests offline). Default: cliente OpenAI real. */
  responses?: ResponsesCall;
  /** Cliente OpenAI injetado (alternativa ao provider). Default: criado de env. */
  client?: OpenAI;
  /** Máx. de itens no histórico antes da poda/sumarização (§B). Default: 40. */
  maxContextItems?: number;
  /** Máx. de caracteres do JSON do histórico (§B). Default: 120_000. */
  maxContextChars?: number;
  /**
   * Janela de contexto do modelo em tokens (§B). `0` (default) = desligado.
   *
   * Ao configurar, o harness dispara a poda/sumarização quando a medição de
   * tokens do contexto ultrapassa `contextTokenRatio` desta janela. A medição
   * usa o `usage.input_tokens` real do round anterior (mais preciso) e, sem
   * esse dado, cai na estimativa de {@link estimateTokens} (ou num
   * `tokenEstimator` injetado).
   *
   * @example `maxContextTokens: 32_768` para uma janela de 32k do modelo.
   */
  maxContextTokens?: number;
  /**
   * Fração da janela usada como gatilho de condensação (§B). Default: `0.8`
   * (80% — valor da suggests.md). Clampado em `(0.01, 1]`.
   *
   * @example `contextTokenRatio: 0.9` condensa só perto do estouro real.
   */
  contextTokenRatio?: number;
  /**
   * Medidor de tokens injetável (§B). Default: {@link estimateTokens}
   * (~4 chars/token). Use para plugar um tokenizador real.
   */
  tokenEstimator?: TokenEstimator;
  /**
   * Condensa o histórico antigo por LLM (§B). Opt-in: sem ele, a poda
   * determinística (splice + limite por chars) é a única ativa.
   *
   * @example `summarizer: createLLMSummarizer(responses)` reusa o provider.
   */
  summarizer?: Summarizer;
  /** Quantos itens finais do histórico ficam intactos na sumarização (§B). Default: 6. */
  summarizeKeepRecent?: number;
  /**
   * Tempo máximo (ms) para a decisão HITL (§D). `0` (default) = sem limite.
   * Ao vencer sem `resume()`, a tool é auto-recusada (`tool_denied` com
   * `reason: "timeout"`), evitando deadlock quando o consumidor some.
   *
   * @example `approvalTimeoutMs: 5_000` recusa automaticamente após 5s.
   */
  approvalTimeoutMs?: number;
  /**
   * Chamadas de ferramenta simultâneas no round. Default: `true`.
   *
   * Com `true`, o harness envia `parallel_tool_calls` no request e executa as
   * ferramentas **não sensíveis** do mesmo round de forma **concorrente**
   * (`Promise.all`), preservando a ordem determinística do histórico. Com
   * `false`, o modelo pede uma tool por vez e a execução é sequencial —
   * útil para ferramentas com efeitos colaterais ou ordem dependente.
   *
   * @example `parallelToolCalls: false` desliga o lote simultâneo.
   */
  parallelToolCalls?: boolean;
  /**
   * Diretório base dos artefatos de execução (run log) — **opt-in**.
   *
   * Quando definido, cada `run()` cria um workspace persistente (subdiretório
   * `run-*` com modo `0o700`, via `Deno.makeTempDir`) e grava `run.log` — uma
   * linha JSON por ferramenta executada, anexada **sob flock** (ordem = ordem
   * das chamadas). O caminho do workspace volta em `TExecutionResult.workspace`.
   *
   * Sem essa opção (default), nenhum artefato é criado e o comportamento é
   * idêntico ao atual.
   *
   * @example `workspaceDir: ".agentcore"` persiste o run log para inspeção.
   */
  workspaceDir?: string;
  /**
   * Structured output: passthrough no request do round.
   * Injetado no body da chamada como `format`. Aceita schema JSON ou string
   * arbitrária (ex.: `"json"` para o Ollama).
   */
  format?: string | object;
  /**
   * Params do modelo comuns a todos os rounds (Ollama-nativos: `num_ctx`,
   * `keep_alive`, `seed`, `temperature`, `num_predict`, `stop`, ...).
   * Repassados como `extra_body` no `client.responses.create`.
   */
  modelParams?: Record<string, unknown>;
  /**
   * Histórico inicial semeado no `_messages` antes do 1º round
   * (múltiplas `system`/`user` prévias). `run()`/`runParts()` apenda só o
   * prompt novo. Respeita `maxContextItems`/`maxContextChars` (a poda e a
   * sumarização continuam valendo para o histórico semeado).
   */
  initialMessages?: Responses.ResponseInputItem[];
}

/**
 * Harness ReAct (spec §5).
 *
 * Estado interno: histórico `_messages`, instruções, rounds/calls contados,
 * máximo de rounds, nível de `thinking`, modelo, registro de ferramentas e o
 * transport injetável. Toda execução cria um `AbortController` próprio.
 *
 * Uso básico:
 * @example
 * ```ts
 * const agent = new ReAct({
 *   model: "qwen3:4b",
 *   system_prompt: "Você é um assistente.",
 *   maxRounds: 6,
 * });
 * agent.registryTool(uppercaseTool);
 *
 * const result = await collect(agent.run("Olá!"));
 * console.log(result.content.content, result.toolCalls);
 * ```
 *
 * Com HITL (aprovação humana) e poda por LLM:
 * @example
 * ```ts
 * const agent = new ReAct(
 *   { model: "qwen3:4b", system_prompt: "Pode deletar dados se o usuário aprovar.", maxRounds: 8 },
 *   { approvalTimeoutMs: 15_000, summarizer: createLLMSummarizer(responses) },
 * );
 * agent.registryTool(deleteTool); // sensitive: true
 *
 * for await (const event of agent.run("Deleta o registro 42")) {
 *   if (event.type === "tool_interrupt") {
 *     agent.resume(confirm(`Permitir ${event.tool}?`));
 *   }
 * }
 * ```
 */
export class ReAct {
  private _messages: Array<
    Responses.ResponseInputItem | Responses.ResponseOutputItem
  > = [];
  private readonly _system_prompt: string;
  private _rounds = 0;
  private _callings = 0;
  private readonly _maxRounds: number;
  private readonly _think_level?: ThinkingLevel;
  private readonly _model: string;
  private readonly _registry = new ToolRegistry();
  private readonly _responses: ResponsesCall;
  private readonly _maxContextItems: number;
  private readonly _maxContextChars: number;
  private readonly _maxContextTokens: number;
  private readonly _contextTokenRatio: number;
  private readonly _tokenEstimator: TokenEstimator;
  private readonly _summarizer?: Summarizer;
  private readonly _summarizeKeepRecent: number;
  private readonly _approvalTimeoutMs: number;
  private readonly _parallelToolCalls: boolean;
  private readonly _workspaceDir?: string;
  private readonly _format?: string | object;
  private readonly _modelParams?: Record<string, unknown>;
  private readonly _initialMessages?: Responses.ResponseInputItem[];
  private _workspace: Workspace | null = null;
  private _summaries = 0;
  private _ac: AbortController | null = null;
  /** Uso real de entrada do último round (null antes do 1º round / sem usage). */
  private _lastInputTokens: number | null = null;
  private _state: "idle" | "running" | "paused" = "idle";
  private _pendingApproval: {
    call_id: string;
    resolve: (approved: boolean, params?: Record<string, unknown>) => void;
  } | null = null;

  private get pendingApproval(): {
    call_id: string;
    resolve: (approved: boolean, params?: Record<string, unknown>) => void;
  } | null {
    return this._pendingApproval;
  }

  // Callbacks da spec §5 (façade sobre o fluxo de eventos do generator).
  private _toolCallingCb?: (name: string, params: string) => void;
  private _toolResponseCb?: (name: string, response: string) => void;
  private _reasoningCb?: (token: string) => void;
  private _contentCb?: (token: string) => void;

  /**
   * Cria o agente.
   *
   * @param config Configuração primária (modelo, prompt, rounds) — veja {@link TAgent}.
   * @param options Opções adicionais — veja {@link ReActOptions}.
   * @example
   * ```ts
   * const agent = new ReAct(
   *   { model: "qwen3:4b", thinking: "high", system_prompt: "...", maxRounds: 6 },
   *   { /* opcional: responses, client, summarizer, approvalTimeoutMs... *\/ },
   * );
   * ```
   */
  constructor(config: TAgent, options: ReActOptions = {}) {
    this._model = config.model;
    this._system_prompt = config.system_prompt;
    this._maxRounds = config.maxRounds;
    this._think_level = config.thinking;
    this._responses = options.responses ??
      defaultResponsesCall(options.client ?? createClient(loadRuntimeConfig()));
    this._maxContextItems = options.maxContextItems ??
      DEFAULT_MAX_CONTEXT_ITEMS;
    this._maxContextChars = options.maxContextChars ??
      DEFAULT_MAX_CONTEXT_CHARS;
    this._maxContextTokens = options.maxContextTokens ?? 0;
    this._contextTokenRatio = Math.min(
      1,
      Math.max(options.contextTokenRatio ?? DEFAULT_CONTEXT_TOKEN_RATIO, 0.01),
    );
    this._tokenEstimator = options.tokenEstimator ?? estimateTokens;
    this._summarizer = options.summarizer;
    this._summarizeKeepRecent = options.summarizeKeepRecent ??
      DEFAULT_SUMMARIZE_KEEP_RECENT;
    this._approvalTimeoutMs = options.approvalTimeoutMs ?? 0;
    this._parallelToolCalls = options.parallelToolCalls ?? true;
    this._workspaceDir = options.workspaceDir;
    this._format = options.format;
    this._modelParams = options.modelParams;
    this._initialMessages = options.initialMessages;
  }

  // ---- Event listeners (spec §5) -----------------------------------------

  /**
   * Callback de chamada de ferramenta (espec §5 `onToolCalling`).
   *
   * Alternativa ao evento `tool_call`. Chamado quando um `function_call` é
   * detectado no stream do round.
   *
   * @param cb Recebe o nome da tool e os argumentos em JSON string.
   * @example
   * ```ts
   * agent.onToolCalling((name, args) => console.log(`→ ${name}(${args})`));
   * ```
   */
  public onToolCalling(cb: (name: string, params: string) => void): void {
    this._toolCallingCb = cb;
  }

  /**
   * Callback de resposta da ferramenta (spec §5 `onToolResponse`).
   *
   * Chamado após cada execução, com o resultado (ou o erro, quando `ok:false`).
   *
   * @param cb Recebe o nome da tool e a string de saída (ou erro).
   * @example
   * ```ts
   * agent.onToolResponse((name, response) => console.log(`← ${name}: ${response}`));
   * ```
   */
  public onToolResponse(cb: (name: string, response: string) => void): void {
    this._toolResponseCb = cb;
  }

  /**
   * Callback de raciocínio (spec §5 `onReasoning`).
   *
   * Recebe cada delta de raciocínio conforme chega no stream.
   *
   * @param cb Recebe o token/delta de raciocínio.
   * @example
   * ```ts
   * agent.onReasoning((token) => process.stdout.write(token));
   * ```
   */
  public onReasoning(cb: (token: string) => void): void {
    this._reasoningCb = cb;
  }

  /**
   * Callback de conteúdo (spec §5 `onContent`).
   *
   * Recebe cada delta do texto de resposta visível ao usuário.
   *
   * @param cb Recebe o token/delta de texto.
   * @example
   * ```ts
   * agent.onContent((token) => process.stdout.write(token));
   * ```
   */
  public onContent(cb: (token: string) => void): void {
    this._contentCb = cb;
  }

  /**
   * Injeção de ferramentas (spec §5 `registryTool`).
   *
   * @param tool Ferramenta a registrar — veja {@link Tool}.
   * @throws {Error} Se o nome já estiver registrado.
   * @example
   * ```ts
   * agent.registryTool({ name: "uppercase", description: "...", execute: () => "OI" });
   * ```
   */
  public registryTool(tool: Tool): void {
    this._registry.register(tool);
  }

  /**
   * Encerramento gracioso do round em curso (spec §4 `cancel()`).
   *
   * Aborta o `AbortSignal` do round. Se houver aprovação HITL pendente
   * (`tool_interrupt`), ela é resolvida como **recusada** — o gerador termina
   * com evento `aborted`, sem deadlock.
   *
   * @example
   * ```ts
   * setTimeout(() => agent.cancel(), 3_000); // timeout do consumidor
   * ```
   */
  public cancel(): void {
    const pending = this._pendingApproval;
    if (pending) {
      this._pendingApproval = null;
      pending.resolve(false);
    }
    this._ac?.abort();
  }

  /**
   * Estado do motor: `paused` significa aguardando `resume(...)` (§D).
   *
   * `idle` (sem execução), `running` (executando um `run()`) ou `paused`
   * (parado num `tool_interrupt` aguardando decisão).
   *
   * @example
   * ```ts
   * if (agent.state === "paused") { /* consumidor reagiu tarde *\/ }
   * ```
   */
  public get state(): "idle" | "running" | "paused" {
    return this._state;
  }

  /**
   * HITL (suggests.md §D): decide a aprovação pendente emitida via
   * `tool_interrupt`. `true` executa a tool sensível — com `params`, executa
   * com os parâmetros ajustados pelo usuário (override, revalidado pelo
   * `executeSafe`). `false` injeta a recusa do usuário no contexto e emite
   * `tool_denied` (params são ignorados na recusa).
   *
   * @param approved `true` executa; `false` recusa (emite `tool_denied`).
   * @param params Override opcional dos argumentos (valores ajustados pelo
   *               usuário); revalidado pelo schema da tool.
   * @throws {Error} Se não houver aprovação pendente.
   * @example
   * ```ts
   * if (event.type === "tool_interrupt") {
   *   if (event.tool === "delete_record") {
   *     const id = prompt("Qual registro?") ?? "";
   *     agent.resume(true, { id: Number(id) }); // override do alvo
   *   } else {
   *     agent.resume(confirm(`Permitir ${event.tool}?`));
   *   }
   * }
   * ```
   */
  public resume(approved: boolean, params?: Record<string, unknown>): void {
    if (!this._pendingApproval) {
      throw new Error("resume() sem tool_interrupt pendente.");
    }
    const { resolve } = this._pendingApproval;
    this._pendingApproval = null;
    resolve(approved, params);
    if (this._state === "paused") this._state = "running";
  }

  /** Rounds executados na última (ou atual) execução. */
  public get rounds(): number {
    return this._rounds;
  }

  /** Chamadas de ferramenta executadas na última (ou atual) execução. */
  public get toolCalls(): number {
    return this._callings;
  }

  /** Quantidade de condensações de histórico por LLM nesta execução (§B). */
  public get summaries(): number {
    return this._summaries;
  }

  /**
   * Limpa o histórico da conversa (nova sessão no mesmo motor).
   *
   * Zera histórico, contadores de rounds/calls e summaries — útil para
   * reusar o mesmo agente/ferramentas com um novo usuário.
   *
   * @example
   * ```ts
   * const agent = new ReAct(config);
   * await collect(agent.run("primeira pergunta"));
   * agent.reset();
   * await collect(agent.run("outra pergunta")); // contexto zerado
   * ```
   */
  public reset(): void {
    this._messages = [];
    this._rounds = 0;
    this._callings = 0;
    this._summaries = 0;
    this._lastInputTokens = null;
  }

  private toUserItem(prompt: string): Responses.ResponseInputItem {
    return { role: "user", content: [{ type: "input_text", text: prompt }] };
  }

  /** Poda determinística simple (§B): descarta os itens mais antigos primeiro. */
  private prune(): void {
    const excess = this._messages.length - this._maxContextItems;
    if (excess > 0) this._messages.splice(0, excess);
    if (this._maxContextChars > 0) {
      while (
        JSON.stringify(this._messages).length > this._maxContextChars &&
        this._messages.length > 2
      ) {
        this._messages.shift();
      }
    }
  }

  /** Projeção de tokens do contexto: uso real do último round, senão estimativa. */
  private contextTokens(): number {
    const measured = this._lastInputTokens;
    if (measured !== null) return measured;
    return this._tokenEstimator(JSON.stringify(this._messages));
  }

  /** Trigger por tokens (§B): contexto acima de `ratio` da janela do modelo. */
  private overTokens(): boolean {
    if (this._maxContextTokens <= 0) return false;
    const budget = this._maxContextTokens * this._contextTokenRatio;
    return this.contextTokens() > budget;
  }

  /**
   * Run log do workspace persistente (`ReActOptions.workspaceDir`): uma linha
   * JSON por ferramenta executada, anexada **sob flock** (`appendLineLocked`).
   *
   * A chamada é aguardada na passada sequencial do loop, então a ordem das
   * linhas espelha a ordem das chamadas — mesmo com execução concorrente no
   * lote paralelo (§C paralelo). Sem workspace, não faz nada.
   */
  private async logExecution(call: ToolCall, res: ToolResult): Promise<void> {
    if (!this._workspace) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool: call.name,
      call_id: call.call_id,
      args: call.args,
      ok: res.ok,
      output: res.ok ? (res.output as string) : (res.error as string),
    });
    await appendLineLocked(this._workspace.file("run.log"), line);
  }

  /**
   * Gestão de contexto (§B): com `summarizer` configurado, o prefixo antigo
   * (tudo antes das últimas `summarizeKeepRecent` mensagens) é condensado em um
   * único item de sistema. Falha ou resumo vazio caem na poda determinística.
   */
  private async manageContext(signal: AbortSignal): Promise<void> {
    const overItems = this._messages.length > this._maxContextItems;
    const overChars = this._maxContextChars > 0 &&
      JSON.stringify(this._messages).length > this._maxContextChars;
    const overTokens = this.overTokens();
    if (!overItems && !overChars && !overTokens) return;

    const keepFrom = this._messages.length - this._summarizeKeepRecent;
    if (this._summarizer && keepFrom > 0) {
      const prefix = this._messages.slice(0, keepFrom);
      try {
        const summary = await this._summarizer({
          messages: prefix as Responses.ResponseInputItem[],
          instructions: this._system_prompt,
          model: this._model,
          signal,
        });
        if (summary.trim()) {
          this._messages.splice(0, keepFrom, {
            role: "system",
            content: `Resumo do contexto anterior:\n${summary}`,
          });
          this._summaries++;
          return;
        }
      } catch {
        // fallback determinístico abaixo
      }
    }
    this.prune();
  }

  /**
   * Loop ReAct (spec §5 `run`, redefinido como gerador pelo suggests.md §3A):
   * emite eventos em tempo real e retorna o `TExecutionResult` no final.
   *
   * O gerador pausa entre eventos: cada `yield` devolve um {@link AgentEvent};
   * quando o loop termina (resposta final, erros, `aborted` ou `maxRounds`),
   * o `return` entrega o {@link TExecutionResult} com tokens/time/rounds.
   *
   * @param prompt Prompt do usuário (vira o primeiro item do histórico).
   * @returns `AsyncGenerator` — consuma com `for await` ou manualmente via
   *          `.next()`. O valor de `done` é o `TExecutionResult`.
   * @example
   * ```ts
   * const generator = agent.run("Some 3 + 4");
   * let result: TExecutionResult | undefined;
   * for (;;) {
   *   const { done, value } = await generator.next();
   *   if (done) { result = value; break; }
   *   if (value.type === "content") process.stdout.write(value.token);
   * }
   * console.log(`rounds=${result!.rounds} calls=${result!.toolCalls}`);
   * ```
   *
   * @example Com `for await`, pausando em aprovações HITL:
   * ```ts
   * for await (const event of agent.run("Apague o registro 42")) {
   *   if (event.type === "tool_interrupt") {
   *     agent.resume(confirm(`Permitir ${event.tool}(${event.args})?`));
   *   }
   * }
   * console.log(agent.state); // "idle" ao final
   * ```
   */
  public async *run(
    prompt: string,
  ): AsyncGenerator<AgentEvent, TExecutionResult, void> {
    return yield* this._runWithFirstItem(this.toUserItem(prompt));
  }

  /**
   * Variante multimodal de {@link run}: aceita `PromptPart[]` (texto + imagem)
   * como primeiro item do usuário. Compartilha todo o resto do loop —
   * incluindo `initialMessages` e a gestão de contexto.
   *
   * @param parts Partes multimodais do prompt (`input_text`/`input_image`).
   * @returns A mesma `AsyncGenerator` de {@link run}.
   * @example
   * ```ts
   * for await (const event of agent.runParts([
   *   { type: "input_text", text: "O que tem nesta imagem?" },
   *   { type: "input_image", image_url: "data:image/jpeg;base64,..." },
   * ])) { ... }
   * ```
   */
  public async *runParts(
    parts: PromptPart[],
  ): AsyncGenerator<AgentEvent, TExecutionResult, void> {
    return yield* this._runWithFirstItem({
      role: "user",
      content: parts as unknown as Responses.ResponseInputContent[],
    });
  }

  private async *_runWithFirstItem(
    firstItem: Responses.ResponseInputItem,
  ): AsyncGenerator<AgentEvent, TExecutionResult, void> {
    const started = performance.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let finalReasoning = "";
    let finalContent = "";
    this._rounds = 0;
    this._ac = new AbortController();
    this._lastInputTokens = null;
    const signal = this._ac.signal;
    this._state = "running";
    this._pendingApproval = null;
    this._workspace = null;
    this._messages.push(...(this._initialMessages ?? []), firstItem);

    const finish = (): TExecutionResult => ({
      inputTokens,
      outputTokens,
      totalTokens,
      timeExecution: performance.now() - started,
      content: { content: finalContent, reasoning: finalReasoning },
      rounds: this._rounds,
      toolCalls: this._callings,
      summaries: this._summaries,
      workspace: this._workspace?.path,
    });

    try {
      // Workspace persistente (opt-in): cria o subdiretório do run antes do 1º
      // round. Falha aqui vira evento `error` (sem artefatos parciais do loop).
      if (this._workspaceDir) {
        this._workspace = await createRunWorkspace({
          baseDir: this._workspaceDir,
        });
      }
      for (;;) {
        if (this._rounds >= this._maxRounds) break;
        this._rounds++;
        await this.manageContext(signal);

        const stream = await this._responses({
          model: this._model,
          instructions: this._system_prompt,
          input: this._messages as Responses.ResponseInputItem[],
          tools: this._registry.list().map(toOpenAITool),
          reasoning: this._think_level
            ? { effort: this._think_level }
            : undefined,
          format: this._format,
          modelParams: this._modelParams,
          signal,
        });

        const mapper = mapResponseStream(stream, signal);
        let outcome: RoundOutcome;
        for (;;) {
          const { done, value } = await mapper.next();
          if (done) {
            outcome = value;
            break;
          }
          switch (value.type) {
            case "reasoning":
              finalReasoning += value.token;
              this._reasoningCb?.(value.token);
              break;
            case "content":
              finalContent += value.token;
              this._contentCb?.(value.token);
              break;
            case "tool_call":
              this._toolCallingCb?.(value.tool, value.args);
              break;
            case "reasoning.done":
            case "content.done":
            case "tool_result":
            case "error":
            case "aborted":
              break;
          }
          yield value;
        }

        if (outcome.usage) {
          inputTokens += outcome.usage.inputTokens;
          outputTokens += outcome.usage.outputTokens;
          totalTokens += outcome.usage.totalTokens;
          this._lastInputTokens = outcome.usage.inputTokens;
        } else {
          this._lastInputTokens = null;
        }
        if (outcome.aborted) {
          yield { type: "aborted" };
          return finish();
        }
        if (outcome.errored) {
          yield { type: "error", error: outcome.errored };
          return finish();
        }

        this._messages.push(
          ...outcome.items as Responses.ResponseInputItem[],
        );

        if (outcome.calls.length === 0) break;

        // Execução concorrente (§C paralelo): as tools **não sensíveis** do
        // round rodam em paralelo (`Promise.all`), os resultados ficam
        // cacheados por call_id e são aplicados na passada sequencial abaixo —
        // preservando ordem determinística de eventos, histórico e run log.
        const plainResults = new Map<string, ToolResult>();
        if (this._parallelToolCalls && outcome.calls.length > 1) {
          const plain = outcome.calls.filter(
            (call) => !this._registry.get(call.name)?.sensitive,
          );
          if (plain.length > 1) {
            const results = await Promise.all(
              plain.map((call) =>
                this._registry.executeSafe(call.name, call.args)
              ),
            );
            plain.forEach((call, i) =>
              plainResults.set(call.call_id, results[i])
            );
          }
        }

        for (const call of outcome.calls) {
          const tool = this._registry.get(call.name);
          if (tool?.sensitive) {
            // HITL (§D): pausa e aguarda decisão humana via resume().
            this._state = "paused";
            let timedOut = false;
            let resolveApproval!: (
              decision: { approved: boolean; params?: Record<string, unknown> },
            ) => void;
            const approval = new Promise<{
              approved: boolean;
              params?: Record<string, unknown>;
            }>((resolve) => {
              resolveApproval = resolve;
            });
            this._pendingApproval = {
              call_id: call.call_id,
              resolve: (approved, params) =>
                resolveApproval({ approved, params }),
            };
            let timer: ReturnType<typeof setTimeout> | undefined;
            if (this._approvalTimeoutMs > 0) {
              timer = setTimeout(() => {
                if (this._pendingApproval) {
                  this._pendingApproval = null;
                  timedOut = true;
                  resolveApproval({ approved: false });
                }
              }, this._approvalTimeoutMs);
            }
            yield {
              type: "tool_interrupt",
              tool: call.name,
              args: call.args,
              call_id: call.call_id,
            };
            const { approved, params } = await approval;
            if (timer !== undefined) clearTimeout(timer);
            if (signal.aborted) {
              yield { type: "aborted" };
              return finish();
            }
            this._state = "running";
            if (!approved) {
              const output =
                `Ação recusada pelo usuário. Não execute a ferramenta "${call.name}".`;
              this._messages.push({
                type: "function_call_output",
                call_id: call.call_id,
                output,
              });
              yield {
                type: "tool_denied",
                tool: call.name,
                args: call.args,
                reason: timedOut ? "timeout" : "user",
              };
              continue;
            }

            if (params) {
              // Override (§D avançado): o modelo precisa saber que os args mudaram.
              call.args = JSON.stringify(params);
              this._messages.push({
                role: "system",
                content:
                  `A ferramenta "${call.name}" foi aprovada com parâmetros ` +
                  "ajustados pelo usuário.",
              });
            }
          }

          const res = plainResults.get(call.call_id) ??
            (await this._registry.executeSafe(call.name, call.args));
          const output = res.ok
            ? (res.output as string)
            : (res.error as string);
          this._messages.push({
            type: "function_call_output",
            call_id: call.call_id,
            output,
          });
          this._callings++;
          this._toolResponseCb?.(call.name, output);
          await this.logExecution(call, res);
          yield { type: "tool_result", tool: call.name, ok: res.ok, output };

          if (!res.ok) {
            // Self-healing (§C): o erro volta ao contexto para o modelo corrigir.
            this._messages.push({
              role: "system",
              content: `Erro na ferramenta "${call.name}": ${res.error}. ` +
                "Corrija os parâmetros e tente novamente.",
            });
          }
        }
      }
    } catch (cause) {
      if (signal.aborted) {
        yield { type: "aborted" };
      } else {
        yield { type: "error", error: cause };
      }
    } finally {
      this.pendingApproval?.resolve(false);
      this._pendingApproval = null;
      this._ac = null;
      this._state = "idle";
    }

    return finish();
  }
}
