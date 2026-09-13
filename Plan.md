# Plano de Migração — Motor ReAct (estudo) → OllamaTask

> Documento único de referência para a migração. Todo o detalhamento necessário
> está aqui; nenhuma decisão adicional deve ser tomada sem antes ler este plano.
>
> **Origem**: `/data/data/com.termux/files/home/Projetos/estudo` (harness ReAct v1, validado com 56 testes offline + E2E contra Ollama local).
> **Destino**: `/data/data/com.termux/files/home/Projetos/OllamaTask`.
> **Repositório origem**: permanece intacto como referência (`AGENTS.md`, `spec.md`, `suggests.md`, código).

---

## 1. Objetivo

Fazer o OllamaTask passar a usar o **motor (loop ReAct)** do estudo como seu
núcleo, mantendo a API pública atual (`ollamaTask` fluent builder, `StreamEvent`,
`ExecutionResult`, `ToolDefinition`/`ToolHandler`, MCP, RAG, pipeline) funcionando
como uma **fachada** sobre o novo motor.

O motor novo entrega, de graça, capacidades que o OllamaTask não tinha:

- Loop async-generator com eventos em tempo real (`run()`).
- Self-healing de tool calls (erro volta ao contexto, nunca quebra).
- Gestão de contexto: poda determinística + sumarização por LLM opt-in + trigger por tokens.
- HITL (ferramentas `sensitive` com `tool_interrupt`/`resume`).
- Execução paralela orquestrada de tool calls.
- Provider injetável → suíte de testes 100% offline.

---

## 2. Decisões consolidadas (fechadas com o usuário)

| # | Decisão |
|---|---|
| 1 | `ollamaTask` vira **fachada** sobre `ReAct`. API fluent e tipos públicos preservados. |
| 2 | Params Ollama-nativos via **`extra_body`** do SDK OpenAI v7. |
| 3 | **`format`** (structured output) entra em `ReActOptions`. |
| 4 | Módulos do harness em **`src/engine/`**. |
| 5 | Manter dependência `zod-to-json-schema` (exemplos usam para `format`). |
| 6 | **`ReAct` estendido para multimodal** (imagens/visão). |
| 7 | **`ReActOptions.initialMessages`** para semear histórico (múltiplas `system`/`user`). |
| 8 | `npm:ollama` permanece **apenas** para `src/memories/providers/ollama.ts` (embeddings/chat/pull — domínio RAG, fora do loop). |
| 9 | Trazer **suíte offline** do estudo (events/tools/loop/config/tokens/summarizer/env). |
| 10 | Trazer **`tests/integration`** como `test:int`. |

---

## 3. Arquitetura-alvo

```
src/
├── engine/                     ← NOVO núcleo (adaptado de estudo/src/, com extensões)
│   ├── react.ts                ReAct + ReActOptions (novos campos — ver §4)
│   ├── types.ts                Tool (+ parametersJsonSchema), PromptPart, TAgent, ...
│   ├── events.ts               mapResponseStream / RoundOutcome / mapUsage
│   ├── tools.ts                ToolRegistry / toOpenAITool / executeSafe
│   ├── tokens.ts               estimateTokens / TokenEstimator
│   ├── summarizer.ts           createLLMSummarizer / Summarizer
│   ├── config.ts               loadRuntimeConfig (env OPENAI_*)
│   ├── client.ts               createClient (openai SDK)
│   ├── env.ts                  Workspace / createRunWorkspace / appendLineLocked
│   └── mod.ts                  barrel do engine
│
├── ollamaTask.ts               REESCRITO como fachada fluent sobre ReAct (§5)
├── ollamaPipeline.ts           INTACTO salvo troca/validação de tipos (§6)
├── cachedRun.ts                INTACTO (usa fachada — contrato igual) (§6)
├── ragIntegration.ts           INTACTO (produz ToolDefinition/ToolHandler) (§6)
├── mcp/client.ts               INTACTO (produz ToolDefinition/ToolHandler) (§6)
├── mcp/server.ts               INTACTO (revisar zod v4 — §7)
├── memories/…                  INTACTO (mantém npm:ollama)
└── tools/…                     INTACTO (funções puras; adaptador na fachada)
```

Nenhum arquivo é apagado. O único módulo "reescrito" é `src/ollamaTask.ts`.

---

## 4. Extensões do harness (mínimas, decididas)

### 4.1 `src/engine/types.ts`

Além de todo o conteúdo atual de `estudo/src/types.ts`, adicionar:

```ts
/**
 * Parte de conteúdo multimodal de uma mensagem do usuário.
 * Permitida em `runParts()` e em `TAgent`/prompt da fachada (imagens).
 */
export type PromptPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string };

export interface Tool {
  // ... campos atuais (name, description, parameters?, execute, sensitive)

  /**
   * JSON Schema MANUAL alternativo a `parameters` (zod).
   * Quando presente, `toOpenAITool` anuncia este schema diretamente
   * (sem conversão zod) e `executeSafe` valida apenas parse + objeto.
   * Usado pelo adaptador ToolDefinition→Tool da fachada.
   */
  parametersJsonSchema?: Record<string, unknown>;
}
```

### 4.2 `src/engine/react.ts`

Novos campos em `ReActOptions`:

```ts
export interface ReActOptions {
  // ... campos atuais

  /**
   * Structured output: passthrough no request do round.
   * Usado por `ReActOptions.format` e injetado no body da chamada.
   */
  format?: string | object;

  /**
   * Params do modelo comuns a todos os rounds (Ollama-nativos: num_ctx,
   * keep_alive, seed, temperature, num_predict, stop, ...). Repassados como
   * `extra_body` no `client.responses.create` (cast no defaultResponsesCall).
   */
  modelParams?: Record<string, unknown>;

  /**
   * Histórico inicial sem já incluído na conversa antes do 1º round.
   * A fachada semeia system/user prévias; `run()` apenda só o prompt novo.
   */
  initialMessages?: Responses.ResponseInputItem[];
}
```

`ResponsesCallRequest` ganha `format?: string | object` e
`modelParams?: Record<string, unknown>`.

`defaultResponsesCall` passa a incluir, no body do `client.responses.create`:

```ts
const body = {
  model: request.model,
  instructions: request.instructions,
  input: request.input as unknown as Responses.ResponseInput,
  tools: request.tools,
  reasoning: request.reasoning ?? undefined,
  parallel_tool_calls: request.parallelToolCalls,
  stream: true,
  ...(request.format !== undefined && { format: request.format }),
};
const stream = await client.responses.create(
  body as unknown as Parameters<typeof client.responses.create>[0],
  { signal: request.signal },
);
```

e `modelParams` entra no mesmo objeto (já incluído no `body` acima via spread,
seguindo o mesmo padrão de cast). **Validar no SDK instalado** (risco §10.1).

Novo método público (multimodal), além do `run(prompt: string)` atual:

```ts
public async *runParts(parts: PromptPart[]): AsyncGenerator<AgentEvent, TExecutionResult, void>
```

Implementação: em vez de `toUserItem(prompt)` (`input_text` puro), monta
`{ role: "user", content: parts }`. Compartilha todo o resto do loop com `run()`.

`initialMessages` são anexados ao `_messages` no **início do `run()`/`runParts()`**
(antes do `toUserItem`), e respeitam `maxContextItems`/`maxContextChars`
(a poda/sumarização continua valendo para o histórico semeado).

### 4.3 `src/engine/tools.ts`

`toOpenAITool(tool)` passa a ter esta precedência:

1. `tool.parametersJsonSchema` → usa direto (remove `$schema` keyword).
2. `tool.parameters` (zod) → `z.toJSONSchema` (comportamento atual).
3. nenhum → `parameters: null`.

`executeSafe` quando a tool tem `parametersJsonSchema` (sem zod): valida apenas
JSON parseável + objeto (igual ao fluxo atual, sem a etapa de `safeParse`).
**Nunca lança** — mantém o contrato `{ ok:false, error }`.

### 4.4 Sem alterações

`events.ts`, `tokens.ts`, `summarizer.ts`, `config.ts`, `client.ts`, `env.ts`:
copiados de `estudo/src/` como estão (sem mudanças de comportamento).

---

## 5. Fachada `src/ollamaTask.ts` (reescrita)

### 5.1 Tipos públicos preservados (exportação inalterada)

- `ExecutionResult` (com `parse<T>()`)
- `ToolArgs`
- `ToolDefinition` (repositada — continua documentada no README)
- `ToolHandler`
- `ToolCallResult`
- `StreamEvent` (mantém `ToolCall` importado de `npm:ollama` — **type-only**,
  `import type { ToolCall } from "ollama"`; a dep continua no projeto para memories)
- `Thinking` (`true | "low" | "medium" | "high" | undefined`)

### 5.2 Estado e builder (inalterados)

`_messages`, `_model`, `_tools`, `_handlers`, `_format`, `_maxIterations`,
`_resoaning`, `_ragConfig`, callbacks (`onThinking/onContent/onToolCall/onToolResult`),
params de modelo (`numCtx`, `temperature`, `keepAlive`, `stop`, `numPredict`,
`seed`, `options`) — **todos os setters fluent continuam iguais**.

### 5.3 Adaptador `ToolDefinition/ToolHandler → engine.Tool`

```ts
function toEngineTool(def: ToolDefinition, handler?: ToolHandler): Tool {
  return {
    name: def.function.name,
    description: def.function.description,
    parametersJsonSchema: def.function.parameters,
    execute: async (params) => {
      const raw: unknown = handler
        ? await handler.execute(params)
        : { error: `No handler for tool: ${def.function.name}` };
      lastRawResults.set(def.function.name, raw);   // p/ tool_result estruturado
      return typeof raw === "string" ? raw : JSON.stringify(raw);
    },
  };
}
```

`lastRawResults` é um `Map<string, unknown>` do escopo da execução: a fachada
usa o valor "estruturado" para montar o `StreamEvent.tool_result` (preserva o
`ToolCallResult.result: unknown` atual, em vez do JSON string do engine).

### 5.4 `_streamEvents()` — tradução `AgentEvent → StreamEvent`

A fachada monta, a cada `execute()`/`_streamEvents()`, um `ReAct` novo:

```ts
const config: TAgent = {
  model: this._model,
  system_prompt: /* última (ou concatenadas) mensagens system */,
  maxRounds: this._maxIterations,
  thinking: mapThinking(this._resoaning),   // ver §5.6
};

const options: ReActOptions = {
  initialMessages: /* _messages anteriores (system/user prévias) */,
  format: this._format,
  modelParams: { ...this._options, ...mapeados (num_ctx, keep_alive, temperature,
                stop, num_predict, seed -> modelParams do engine) },
  responses: /* defaultResponsesCall(createClient(loadRuntimeConfig())) */,
};

const agent = new ReAct(config, options);
for (const t of adaptTools(this._tools, this._handlers)) agent.registryTool(t);
```

O histórico a semear: todas as `_messages` **exceto a última `user`** (essa vira o
`prompt` de `run()`). Se a última for `user` com imagens → `runParts(parts)`.

Tradução de eventos do gerador (substitui o parsing manual de tags `think` —
o `events.ts` já separa reasoning real):

| `AgentEvent` (engine) | `StreamEvent` (fachada) |
|---|---|
| `reasoning { token }` | `{ type: "thinking", data: token }` |
| `content { token }` | `{ type: "content", data: token }` |
| `tool_call { tool, args }` | `{ type: "tool_call", data: { function: { name: tool, arguments: args } } }` |
| `tool_result { tool, output }` | `{ type: "tool_result", data: { name: tool, arguments: /* args do round */, result: lastRawResults.get(tool) ?? output } }` |
| `tool_denied { tool, … }` | `{ type: "tool_result", data: { name, arguments, result: { error: "denied by user" } } }` |
| `error { error }` | **throw** `error` (propaga; `execute()` rejeita — mesmo comportamento atual) |
| `aborted` | encerra o gerador (sem `done` adicional; `cancel()` não é público no `ollamaTask`) |
| fim do loop | `{ type: "done", data: { inputTokens, outputTokens } }` (totais do `TExecutionResult`) |

Em `tool_call`/`tool_result`, os `arguments` correspondentes saem do mesmo round
(a fachada guarda o `call.args` por nome durante o round).

### 5.5 `execute()` e `toReadableStream()`

**Inalterados** (colecionam eventos já traduzidos). `done` agora vem único no
final com os totais — o somatório de `execute()` continua correto.

### 5.6 Mapeamento `Thinking → ThinkingLevel`

`ThinkingLevel` do engine = `"minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.

| `this._resoaning` (fachada) | `TAgent.thinking` |
|---|---|
| `undefined` | ausente |
| `"low"` | `"low"` |
| `"medium"` | `"medium"` |
| `"high"` | `"high"` |
| `true` | ausente (deixa o default do provider; validar contra Ollama no `test:int`) |

### 5.7 `rag(config)` — mudança de comportamento documentada

- Mantém: registra `rag_search` como `engine.Tool` via adaptador (se `autoIndex`
  ou sempre que configurado, como hoje).
- **Mudança**: a pré-injeção de contexto acontece no **seed da execução** (uma vez
  por `execute()`, montando o `system_prompt` = `Contexto relevante:\n${context}\n\n---\n\n${ragPrompt}`),
  não mais a cada round. Motivo: o histórico agora é gerido internamente pelo motor.
  Impacto: em execuções multi-round longas, o contexto RAG não é re-buscado por round
  (aceitável; o `rag_search` tool continua disponível para o modelo re-buscar).

### 5.8 `useMCP` / `useMCPServers`

Inalterados: adicionam `ToolDefinition`/`ToolHandler`→ via adaptador §5.3. Nada
de `sensitive` é inferido (tools MCP executam direto, como hoje).

---

## 6. Pipeline / cachedRun / ragIntegration / MCP — verificação

- `ollamaPipeline.ts`: **sem mudança de lógica**. Continua construindo `ollamaTask`
  (agora fachada). Conferir type-check dos tipos trocados (`ToolCallResult`, etc.).
- `cachedRun.ts`: **sem mudança** — usa `ollamaTask` + `RAG`.
- `ragIntegration.ts`: **sem mudança** — continua produzindo `ToolDefinition`/`ToolHandler`.
- `mcp/client.ts`: **sem mudança**.
- `mcp/server.ts`: revisar se `zod@4` mantém `z.object`/`z.literal`/`z.record(z.unknown())`
  (é compatível; confirmar no `deno check`).

---

## 7. Dependências — `deno.json`

```jsonc
{
  "tasks": {
    "dev": "deno run --watch examples/basic-chat.ts",
    "news": "deno run --allow-net --allow-read --allow-write --allow-env examples/news-digest.ts",
    "lint": "deno lint",
    "fmt": "deno fmt --check",
    "check": "deno lint && deno fmt --check",
    "test": "deno test --allow-ffi --allow-net --allow-read --allow-write --allow-env --allow-sys",
    "test:int": "deno test --allow-net=localhost:11434 --allow-env tests/integration/"
  },
  "imports": {
    "ollama": "npm:ollama@^0.6.3",
    "@modelcontextprotocol/sdk/server": "npm:@modelcontextprotocol/sdk@^1.12.1/server",
    "@modelcontextprotocol/sdk/client": "npm:@modelcontextprotocol/sdk@^1.12.1/client",
    "zod": "npm:zod@^4",                                  // v3 → v4 (decisão 3/5)
    "zod-to-json-schema": "npm:zod-to-json-schema@^3.24.0",
    "@std/assert": "jsr:@std/assert@^1.0.19",
    "better-sqlite3-multiple-ciphers": "npm:better-sqlite3-multiple-ciphers@^13.0.3",
    "openai": "npm:openai@^7.15.0"                        // NOVO (engine)
  }
}
```

`npm:ollama` continua (memories). `deno.lock` é gitignored e se regenera localmente.

---

## 8. Testes

### 8.1 Suíte offline → `src/engine/`

Copiar de `estudo/src/` e adaptar:

| Arquivo | Adaptação |
|---|---|
| `events_test.ts` | import `jsr:@std/assert@1` → `@std/assert` |
| `tools_test.ts` | idem + casos novos p/ `parametersJsonSchema` em `toOpenAITool`/`executeSafe` |
| `react_test.ts` | idem + casos novos p/ `initialMessages`, `modelParams`, `runParts`, `format` |
| `tokens_test.ts` | idem |
| `config_test.ts` | idem |
| `summarizer_test.ts` | idem |
| `env_test.ts` | idem |

### 8.2 Integração → `tests/integration/`

Copiar `helpers.ts` + `integration_test.ts` de `estudo/tests/integration/`,
ajustando:
- imports `../../src/mod.ts` → `../src/engine/mod.ts`
- `makeResponses()` usa `defaultResponsesCall` (ou repete o wiring) — passando a
  propagar `format`/`modelParams` quando o engine os enviar.
- default `OPENAI_MODEL` = `nemotron-3-nano:30b-cloud`, igual ao estudo.

### 8.3 Pré-existentes

Corrigir os bloqueios que impedem `deno task test` verde hoje (AGENTS.md):
- `tests/store.test.ts` com erros strict-null (revisar e corrigir).
- Qualquer outro erro apontado pelo `deno check`/`deno test` após a migração.
- `deno fmt` nos arquivos tocados (não "varrer" o repositório inteiro de uma vez).

---

## 9. Documentação

### 9.1 `README.md`

- Páginas atuais da API fluent continuam válidas (fachada). Não remover seções
  existentes de visão/structured output/pipeline/MCP/RAG.
- Adicionar seção **"Engine: ReAct"** (em pt-BR, títulos seguindo o padrão atual):
  - `ReAct` + `run()`/`runParts()` async generator + `AgentEvent`.
  - Health features: self-healing, context management (`maxContextItems`/`Chars`/`Tokens`),
    summarizer opt-in, HITL (`sensitive` + `resume`), parallel tool calls, workspace.
  - Nota de migração explicando a fachada (`ollamaTask` = `ReAct` por baixo).
- Atualizar a tabela de métodos se necessário (ex.: `format` repassado ao engine).
- **Não** escrever texto em Rioplatense/slang; documentos técnicos em pt-BR neutro.

### 9.2 `AGENTS.md` (OllamaTask)

- Novos módulos de `src/engine/` no layout & entrypoints.
- Remover a seção "Current Broken State" se o estado ficar verde (ou atualizá-la).
- Registrar as extensões do harness (§4) e as mudanças de comportamento (§5.7).
- Registrar que a suíte offline existe e não requer rede.

---

## 10. Riscos e pontos de atenção

1. **`extra_body` no openai SDK v7**: chaves extras (`format`, `num_ctx`, …)
   sobrevivem no body apenas com **cast** de tipo. Verificar na fonte do SDK
   instalado que o body é serializado com as chaves extras (o SDK envia o objeto
   `params` como JSON do request). Mitigação: teste offline com
   `client.responses.create` capturando o body via mock, + `test:int` real.
2. **`zod` v3→v4**: `mcp/server.ts` e exemplos (`zodToJsonSchema`) precisam do
   `deno check` verde. `zod-to-json-schema@^3.24.x` suporta v4.
3. **`thinking: true`**: mapeado para "ausente" (default do provider). Validar no
   `test:int` / exemplo `thinking` — se o Ollama exigir um effort, ajustar o mapa.
4. **RAG pré-injeção** mudou de "por round" para "por execução" (§5.7) — documentar
   no README/AGENTS.
5. **`tool_result.result` estruturado**: preservado via `lastRawResults` (§5.3) —
   caso o handler retorne string, o valor string é usado direto.
6. **Exemplos**: rodar os que mais exercitam a fachada (basic-chat,
   structured-output, vision, tool-calling, web-stream, mcp-remote, rag-*, pipeline-*)
   contra o Ollama local. Falha em algum = contrato público quebrado.

---

## 11. Ordem de execução

1. Scaffold `src/engine/` — copiar os 8 módulos do estudo + barrel, ajustando imports (comentários JSDoc se referem a `./src/mod.ts` → atualizar para `engine/`).
2. Aplicar extensões §4 (`types.ts`, `react.ts`, `tools.ts`).
3. Reescrever `src/ollamaTask.ts` como fachada (§5).
4. `deno.json`: subir `zod@^4`, adicionar `openai@^7.15.0`, task `test:int`.
5. Copiar+adaptar suíte offline (§8.1) e integração (§8.2).
6. Corrigir bloqueios pré-existentes (§8.3).
7. `deno check src/` e `deno task lint`/`deno task fmt` nos arquivos tocados.
8. `deno task test` (offline verde) → `deno task test:int` (Ollama local).
9. Executar os exemplos-chave (§10.6).
10. Atualizar `README.md` e `AGENTS.md` (§9).
11. Commit único (conventional commit, pt-BR/EN neutro) — **apenas se o usuário pedir**.

## 12. Critérios de aceite

- [ ] `deno check` limpo no `src/` (engine + fachada + pipeline + mcp + memories).
- [ ] `deno task test` verde **sem rede** (suíte offline incluída).
- [ ] `deno task test:int` verde com Ollama local (modelo `nemotron-3-nano:30b-cloud` ou `OPENAI_MODEL`).
- [ ] Exemplos-chave rodam com o mesmo comportamento observável de antes (mesmos `StreamEvent`, `ExecutionResult`, tokens).
- [ ] Nenhum arquivo fora de `src/engine/*` + `src/ollamaTask.ts` + testes + docs sofreu mudança de lógica.
- [ ] `README.md` e `AGENTS.md` refletem o novo estado (motor, suíte offline, mudança do RAG).
- [ ] `estudo/` intocado.