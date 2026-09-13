/**
 * Tipos públicos do harness ReAct (futuro core do OllamaTask).
 * Fonte: spec.md (§1–§3) e suggests.md (§3A — eventos via geradores assíncronos).
 *
 * Desvios documentados em relação à spec:
 * - {@link TExecutionResult} ganha os campos aditivos `rounds`, `toolCalls` e `summaries`.
 * - `TAgent.thinking` é opcional: valores fora do suporte do modelo são
 *   simplesmente ignorados pelo provider (passthrough de `reasoning.effort`).
 * - `Tool.execute` recebe os parâmetros já parseados (objeto), não a string JSON.
 * - A validação de `Tool.parameters` usa **Zod** (schema tipado); o harness
 *   converte para JSON Schema via `z.toJSONSchema` ao anunciar ao modelo.
 *
 * @module types
 */
import type { z } from "zod";

/**
 * Parte de conteúdo multimodal de uma mensagem do usuário.
 * Permitida em `runParts()` e no prompt da fachada (`ollamaTask`) com imagens.
 *
 * @example
 * ```ts
 * const parts: PromptPart[] = [
 *   { type: "input_text", text: "O que tem nesta imagem?" },
 *   { type: "input_image", image_url: "data:image/jpeg;base64,..." },
 * ];
 * ```
 */
export type PromptPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string };

/**
 * Resposta final do modelo, separando conteúdo e raciocínio.
 *
 * O harness acumula os deltas emitidos pelo stream: `content` é a resposta
 * visível ao usuário; `reasoning` é o "raciocínio" (quando o modelo expõe).
 *
 * @example
 * ```ts
 * const content: TContent = {
 *   content: "O resultado da soma é 7.",
 *   reasoning: "Vou somar 3+4 e devolver 7.",
 * };
 * ```
 */
export interface TContent {
  /** Texto de resposta final (visível ao usuário). */
  content: string;
  /** Texto de raciocínio acumulado (pode ser vazio se o modelo não expõe). */
  reasoning: string;
}

/**
 * Token de uso de uma execução (mapeado de `ResponseUsage`).
 *
 * @example
 * ```ts
 * { inputTokens: 1024, outputTokens: 512, totalTokens: 1536 }
 * ```
 */
export interface TokenUsage {
  /** Tokens de entrada (prompt + histórico). */
  inputTokens: number;
  /** Tokens gerados pelo modelo. */
  outputTokens: number;
  /** Total (`input + output` quando o SDK não informa). */
  totalTokens: number;
}

/**
 * Resultado consolidado de uma execução completa do agente (spec §3).
 *
 * É o valor de retorno do gerador `ReAct.run()` (ao lado dos eventos). Os
 * campos `rounds`, `toolCalls`, `summaries` e `workspace` são aditivos do
 * harness.
 *
 * @example
 * ```ts
 * const result: TExecutionResult = {
 *   inputTokens: 2048,
 *   outputTokens: 640,
 *   totalTokens: 2688,
 *   timeExecution: 1234.5, // ms
 *   content: { content: "Pronto!", reasoning: "" },
 *   rounds: 2,
 *   toolCalls: 3,
 *   summaries: 1,
 *   workspace: "/tmp/agentcore/run-1a2b3c", // quando workspaceDir está ativo
 * };
 * ```
 */
export interface TExecutionResult {
  /** Tokens de entrada somados de todos os rounds. */
  inputTokens: number;
  /** Tokens de saida somados de todos os rounds. */
  outputTokens: number;
  /** Tokens totais somados de todos os rounds. */
  totalTokens: number;
  /** Tempo total em milissegundos. */
  timeExecution: number;
  /** Conteúdo e raciocínio finais acumulados. */
  content: TContent;
  /** Quantidade de rounds executados até o fim. */
  rounds: number;
  /** Quantidade de chamadas de ferramenta realmente executadas. */
  toolCalls: number;
  /** Quantas vezes o histórico foi condensado por LLM (§B). */
  summaries: number;
  /** Caminho do workspace do run (run log), quando `workspaceDir` está ativo. */
  workspace?: string;
}

/**
 * Nível de raciocínio (spec §3) — passthrough de `reasoning.effort`.
 *
 * Repassa a configuração tal qual para o provider; modelos que não suportam
 * ignoram o campo silenciosamente.
 *
 * @example `thinking: "high"` pede mais etapa de raciocínio ao modelo.
 */
export type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * Configuração primária do motor (spec §3).
 *
 * Entrada do construtor de {@link ReAct}. `system_prompt` é enviada como
 * `instructions` da chamada (fica fora do histórico de mensagens).
 *
 * @example
 * ```ts
 * const config: TAgent = {
 *   model: "qwen3:4b",
 *   thinking: "high",
 *   system_prompt: "Você é um assistente que só responde em português.",
 *   maxRounds: 6,
 * };
 * ```
 */
export interface TAgent {
  /** Modelo usado em cada round (ex.: `qwen3:4b`, `llama3.1:8b`). */
  model: string;
  /** Nível de raciocínio (passthrough; opcional, default: ausente). */
  thinking?: ThinkingLevel;
  /** Instrução de sistema enviada como `instructions` em todos os rounds. */
  system_prompt: string;
  /** Limite de rounds da execução — evita loops infinitos. */
  maxRounds: number;
}

/**
 * Contrato de ferramenta (spec §6.3): nome + descrição + schema Zod.
 *
 * `execute` recebe os parâmetros **já parseados e validados** (objeto) e
 * devolve o resultado como string — normalmente JSON serializado para o
 * modelo interpretar. A validação usa Zod (`parameters`), e o harness
 * converte o schema para JSON Schema (`z.toJSONSchema`) ao anunciar a tool.
 *
 * Com `sensitive: true` (HITL §D), o harness emite `tool_interrupt` e pausa
 * até o consumidor chamar `resume(true|false)`.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 *
 * const uppercaseTool: Tool = {
 *   name: "uppercase",
 *   description: "Converte texto para maiúsculas.",
 *   parameters: z.object({
 *     text: z.string().describe("Texto de entrada"),
 *   }).strict(),
 *   execute: ({ text }) => String(text).toUpperCase(),
 * };
 *
 * const deleteTool: Tool = {
 *   name: "delete_record",
 *   description: "Apaga um registro (requer aprovação humana).",
 *   parameters: z.object({ id: z.number().int() }).strict(),
 *   execute: ({ id }) => `Registro ${id} apagado`,
 *   sensitive: true,
 * };
 * ```
 */
export interface Tool {
  /** Nome único da ferramenta (é o que o modelo chama). */
  name: string;
  /** Descrição para o modelo decidir quando usar. */
  description: string;
  /** Schema Zod dos argumentos (`execute` recebe o objeto validado). */
  parameters?: z.ZodTypeAny;
  /**
   * JSON Schema MANUAL alternativo a `parameters` (zod).
   * Quando presente, `toOpenAITool` anuncia este schema diretamente (sem
   * conversão zod) e `executeSafe` valida apenas parse + objeto. Usado pelo
   * adaptador ToolDefinition→Tool da fachada `ollamaTask`.
   */
  parametersJsonSchema?: Record<string, unknown>;
  /** Implementação: recebe objeto de params → devolve string (JSON ideal). */
  execute: (params: Record<string, unknown>) => string | Promise<string>;
  /** HITL (suggests.md §D): exige aprovação humana via `resume(true|false)`. */
  sensitive?: boolean;
}

/**
 * Resultado de uma execução de ferramenta (`ok=false` alimenta o self-healing).
 *
 * `executeSafe` **nunca lança**: todo erro (tool desconhecida, JSON inválido,
 * schema violado ou exceção interna) vira `{ ok: false, error }`.
 *
 * @example
 * ```ts
 * const ok: ToolResult = { ok: true, output: '{"total": 7}' };
 * const fail: ToolResult = { ok: false, error: "$.text: Invalid input: expected string, received number" };
 * ```
 */
export interface ToolResult {
  /** `true` quando executou; `false` quando falhou (consulte `error`). */
  ok: boolean;
  /** Resultado da execução (presente quando `ok: true`). */
  output?: string;
  /** Mensagem de erro (presente quando `ok: false`). */
  error?: string;
}

/**
 * Chamada de ferramenta detectada no stream.
 *
 * Extraída do item `function_call` do SDK: `call_id` vincula a chamada ao
 * `function_call_output` reenviado no histórico do próximo round.
 *
 * @example
 * ```ts
 * { id: "fc_123", call_id: "call_789", name: "uppercase", args: '{"text":"oi"}' }
 * ```
 */
export interface ToolCall {
  /** ID do item no stream. */
  id: string;
  /** ID da chamada (referenciada pelo `function_call_output`). */
  call_id: string;
  /** Nome da ferramenta chamada. */
  name: string;
  /** Argumentos em JSON string (ainda não parseados pelo harness). */
  args: string;
}

/**
 * Eventos emitidos pelo `run()` (gera a API de run gerador do suggests.md §3A).
 *
 * `reasoning`/`content` transportam deltas em tempo real; `reasoning.done`/
 * `content.done` são marcadores de fim (spec §4 pensava em `thinking.end`/
 * `content.end` emitindo `\n` — agora é decisão do consumidor).
 *
 * `tool_call` anuncia uma chamada detectada; `tool_result` entrega o
 * resultado (inclui `ok:false` com o erro — self-healing §C).
 *
 * `tool_interrupt` (HITL §D): o agente aguarda `resume(true|false)` antes de
 * executar uma tool sensível; `tool_denied` sinaliza a recusa do usuário
 * (`reason: "timeout"` quando `approvalTimeoutMs` esgotar sem decisão).
 *
 * `error` carrega qualquer falha de stream/loop; `aborted` é emitido quando
 * `cancel()` interrompe a execução vigente.
 *
 * @example
 * ```ts
 * // Fluxo típico ao iterar os eventos:
 * // { type: "reasoning", token: "Vou " }
 * // { type: "reasoning", token: "somar." }
 * // { type: "reasoning.done" }
 * // { type: "tool_call", tool: "uppercase", args: '{"text":"oi"}' }
 * // { type: "tool_result", tool: "uppercase", ok: true, output: "OI" }
 * // { type: "content", token: "Pronto!" }
 * // { type: "content.done" }
 * ```
 */
export type AgentEvent =
  | { type: "reasoning"; token: string }
  | { type: "reasoning.done" }
  | { type: "content"; token: string }
  | { type: "content.done" }
  | { type: "tool_call"; tool: string; args: string }
  | { type: "tool_result"; tool: string; ok: boolean; output: string }
  | { type: "tool_interrupt"; tool: string; args: string; call_id: string }
  | {
    type: "tool_denied";
    tool: string;
    args: string;
    reason: "user" | "timeout";
  }
  | { type: "error"; error: unknown }
  | { type: "aborted" };
