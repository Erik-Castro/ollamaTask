# ollamaTask

A fluent, type-safe TypeScript client for [Ollama](https://ollama.com) that
wraps the streaming chat API with support for **thinking models**, **tool
calling**, **structured outputs**, and **WebStreams** — all built on the
[ollama-js](https://github.com/ollama/ollama-js) SDK.

## Features

- **Fluent builder API** — chain `.system()`, `.user()`, `.tools()`,
  `.format()`, etc.
- **Thinking model support** — parses `<think>` tags and `message.thinking`
  fields, routes them to a dedicated callback
- **Tool calling pipeline** — automatic agentic loop: model calls tools →
  handlers execute → results fed back → model continues
- **Structured outputs** — constrain model responses to a JSON schema with
  `.format()` + `.parse<T>()`
- **WebStreams** — `toReadableStream()` returns a standard
  `ReadableStream<StreamEvent>` for piping, teeing, or progressive consumption
- **Callbacks** — `onThinking`, `onContent`, `onToolCall`, `onToolResult` for
  full observability
- **Tool suite** — `src/tools/` ships ready-to-use, zero-dependency tools
  (search, web, filesystem, calculator, state, command execution) built for
  tool-calling pipelines
- **RAG & Semantic Memory** — built-in via `src/memories/`: encrypted SQLite
  (SQLCipher), vector KNN search (sqlite-vector), semantic chunking, and
  multi-provider support (Ollama + OpenAI-compatible)

## Requirements

- [Deno](https://deno.com) 2.x or Node.js 18+ with `npm:` specifier
- [Ollama](https://ollama.com) running locally (default:
  `http://127.0.0.1:11434`)

## Setup

```bash
# Copy src/ollamaTask.ts into your project
# Add the ollama dependency
deno add npm:ollama@^0.6.3
```

## Quick Start

```ts
import { ollamaTask } from "./src/ollamaTask.ts";

const result = await new ollamaTask("qwen3.5:2b")
  .system("You are a helpful assistant.")
  .user("What is the capital of France?")
  .execute();

console.log(result.content);
// "The capital of France is Paris."
```

## API Reference

### Constructor

```ts
new ollamaTask(model: string)
```

| Param   | Type     | Description                                                         |
| ------- | -------- | ------------------------------------------------------------------- |
| `model` | `string` | Ollama model name (e.g. `"qwen3.5:2b"`, `"lfm2.5-thinking:latest"`) |

### Builder Methods

All builder methods return `this` for chaining.

| Method             | Signature                                    | Description                                     |
| ------------------ | -------------------------------------------- | ----------------------------------------------- |
| `.system()`        | `(content: string) => this`                  | Add a system message                            |
| `.user()`          | `(content: string, opts?) => this`           | Add a user message (optional `images`)          |
| `.tools()`         | `(defs: ToolDefinition[]) => this`           | Register tool schemas for the model             |
| `.toolHandlers()`  | `(handlers: ToolHandler[]) => this`          | Register tool executor functions                |
| `.format()`        | `(schema: string \| object) => this`         | Set response format (`"json"` or JSON schema)   |
| `.maxIterations()` | `(n: number) => this`                        | Cap tool-calling pipeline loops (default: `10`) |
| `.numCtx()`        | `(n: number) => this`                        | Set context window size (Ollama `num_ctx`)      |
| `.temperature()`   | `(t: number) => this`                        | Set sampling temperature (0.0–2.0)              |
| `.keepAlive()`     | `(duration: string \| number) => this`       | How long to keep model loaded (`"5m"`, `300`)   |
| `.stop()`          | `(sequences: string[]) => this`              | Stop sequences to halt generation               |
| `.numPredict()`    | `(n: number) => this`                        | Max tokens to generate                          |
| `.seed()`          | `(n: number) => this`                        | Random seed for reproducibility                 |
| `.options()`       | `(opts: Record<string, unknown>) => this`    | Pass any Ollama runtime option                  |
| `.onThinking()`    | `(cb: (chunk: string) => void) => this`      | Callback for thinking/reasoning tokens          |
| `.onContent()`     | `(cb: (chunk: string) => void) => this`      | Callback for response content tokens            |
| `.onToolCall()`    | `(cb: (name, args) => void) => this`         | Callback when model requests a tool             |
| `.onToolResult()`  | `(cb: (name, args, result) => void) => this` | Callback after a tool handler returns           |

### Execution

#### `execute(): Promise<ExecutionResult>`

Consumes the full stream and returns the accumulated result.

```ts
const result = await task.execute();

result.content; // string — raw model output
result.inputTokens; // number
result.outputTokens; // number
result.toolCalls; // ToolCallResult[]
result.parse<T>(); // T — JSON.parse(content) as T
```

#### `toReadableStream(): ReadableStream<StreamEvent>`

Returns a Web `ReadableStream` for progressive consumption. Useful for piping to
HTTP responses, teeing for multiple consumers, or using `TransformStream`
middleware.

```ts
const stream = task.toReadableStream();
const reader = stream.getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // value.type: "thinking" | "content" | "tool_call" | "tool_result" | "done"
}
```

## Features

### Basic Chat

```ts
import { ollamaTask } from "./src/ollamaTask.ts";

const result = await new ollamaTask("qwen3.5:2b")
  .system("You are a concise assistant.")
  .user("Explain what a closure is in JavaScript.")
  .onContent((chunk) => process.stdout.write(chunk))
  .execute();

console.log(`\nTokens: ${result.inputTokens} in / ${result.outputTokens} out`);
```

### Thinking Models

Models like `lfm2.5-thinking:latest` emit reasoning tokens before the final
answer. `ollamaTask` parses both the native `message.thinking` field and
`<think>` tags embedded in content.

```ts
const result = await new ollamaTask("lfm2.5-thinking:latest")
  .system("Think step by step.")
  .user("What is 137 * 482?")
  .onThinking((chunk) => {
    // reasoning tokens — stream in gray
    process.stdout.write(`\x1b[90m${chunk}\x1b[0m`);
  })
  .onContent((chunk) => {
    // final answer
    process.stdout.write(chunk);
  })
  .execute();
```

### Tool Calling

Define tools as JSON schemas, register handlers, and the pipeline runs
automatically.

```ts
import {
  ollamaTask,
  type ToolDefinition,
  type ToolHandler,
} from "./src/ollamaTask.ts";

const weatherTool: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
};

const weatherHandler: ToolHandler = {
  name: "get_weather",
  execute: async (args) => {
    // In production, call a real weather API
    return {
      temperature: 22,
      condition: "sunny",
      location: args.location,
    };
  },
};

const result = await new ollamaTask("qwen3.5:2b")
  .system("You are a helpful assistant. Use tools when you need data.")
  .user("What's the weather in Paris?")
  .tools([weatherTool])
  .toolHandlers([weatherHandler])
  .onToolCall((name, args) => {
    console.log(`\n🔧 Calling: ${name}(${JSON.stringify(args)})`);
  })
  .onToolResult((name, _args, result) => {
    console.log(`📦 Result: ${JSON.stringify(result)}`);
  })
  .maxIterations(5)
  .execute();

console.log(`\nFinal: ${result.content}`);
console.log(`Tool calls made: ${result.toolCalls.length}`);
```

#### How the Pipeline Works

1. The model receives your messages + tool schemas
2. If the model emits `tool_calls`, the pipeline:
   - Fires `onToolCall` with the tool name and arguments
   - Finds and executes the matching `ToolHandler`
   - Fires `onToolResult` with the result
   - Pushes `assistant` + `tool` messages to the conversation
   - Sends the updated conversation back to the model
3. Repeats until the model stops calling tools or `maxIterations` is reached

### Structured Outputs

Constrain the model to return valid JSON matching a schema.

```ts
interface Person {
  name: string;
  age: number;
  occupation: string;
}

const personSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
    occupation: { type: "string" },
  },
  required: ["name", "age", "occupation"],
};

const result = await new ollamaTask("qwen3.5:2b")
  .system("You are a data generator.")
  .user("Create a fictional person.")
  .format(personSchema)
  .execute();

// Raw JSON string
console.log(result.content);
// '{"name":"Alice","age":30,"occupation":"Engineer"}'

// Typed parsed object
const person = result.parse<Person>();
console.log(person.name); // "Alice"
console.log(person.age); // 30
console.log(person.occupation); // "Engineer"
```

You can also pass `"json"` for generic JSON mode (no schema validation):

```ts
const result = await new ollamaTask("qwen3.5:2b")
  .format("json")
  .user("List 3 colors as a JSON array.")
  .execute();

const colors: string[] = result.parse<string[]>();
```

### Vision Models (Multimodal)

Pass images to vision models like LLaVA or Llama 3.2 Vision via the `images`
option in `.user()`. Images can be file paths, base64 strings, or `Uint8Array`
buffers.

```ts
const result = await new ollamaTask("llava")
  .user("What do you see in this image?", { images: ["photo.jpg"] })
  .execute();

console.log(result.content);
```

Multiple images:

```ts
const result = await new ollamaTask("llava")
  .user("Compare these two images.", {
    images: ["before.jpg", "after.jpg"],
  })
  .execute();
```

### WebStreams

Use `toReadableStream()` to get a standard `ReadableStream<StreamEvent>`. This
integrates with the Web Streams API — pipe to HTTP responses, tee for multiple
consumers, or chain with `TransformStream`.

#### Basic Stream Consumption

```ts
const stream = new ollamaTask("qwen3.5:2b")
  .system("You are a storyteller.")
  .user("Tell me a short story.")
  .toReadableStream();

for await (const event of stream) {
  switch (event.type) {
    case "thinking":
      process.stdout.write(`\x1b[90m${event.data}\x1b[0m`);
      break;
    case "content":
      process.stdout.write(event.data);
      break;
    case "done":
      console.log(
        `\n\nTokens: ${event.data.inputTokens} in / ${event.data.outputTokens} out`,
      );
      break;
  }
}
```

#### Piping to an HTTP Response

```ts
Deno.serve(async (req) => {
  const stream = new ollamaTask("qwen3.5:2b")
    .system("You are a helpful assistant.")
    .user(new URL(req.url).searchParams.get("q") ?? "Hello")
    .toReadableStream();

  const textStream = stream
    .pipeThrough(
      new TransformStream({
        transform(event, controller) {
          if (event.type === "content") {
            controller.enqueue(event.data);
          }
        },
      }),
    );

  return new Response(textStream, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
});
```

#### Teeing the Stream

```ts
const stream = task.toReadableStream();
const [branch1, branch2] = stream.tee();

// Consumer A: print to console
consume(branch1, (event) => {
  if (event.type === "content") process.stdout.write(event.data);
});

// Consumer B: collect into a variable
const fullText = await consume(branch2, (event) => {
  if (event.type === "content") return event.data;
  return "";
});
```

### StreamEvent Types

The `StreamEvent` discriminated union:

| `type`          | `data`                          | Description                         |
| --------------- | ------------------------------- | ----------------------------------- |
| `"thinking"`    | `string`                        | Reasoning/thinking token            |
| `"content"`     | `string`                        | Response content token              |
| `"tool_call"`   | `ToolCall`                      | Model requested a tool              |
| `"tool_result"` | `ToolCallResult`                | Tool handler returned a result      |
| `"done"`        | `{ inputTokens, outputTokens }` | Stream completed for this iteration |

## Types

### `ExecutionResult`

```ts
interface ExecutionResult {
  content: string; // Raw model output
  inputTokens: number; // Prompt tokens consumed
  outputTokens: number; // Completion tokens generated
  toolCalls: ToolCallResult[];
  parse<T>(): T; // JSON.parse(content) as T
}
```

### `ToolDefinition`

```ts
interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, {
        type: string;
        description?: string;
        enum?: unknown[];
      }>;
      required?: string[];
    };
  };
}
```

### `ToolHandler`

```ts
interface ToolHandler {
  name: string;
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}
```

### `ToolCallResult`

```ts
interface ToolCallResult {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}
```

### `StreamEvent`

```ts
type StreamEvent =
  | { type: "thinking"; data: string }
  | { type: "content"; data: string }
  | { type: "tool_call"; data: ToolCall }
  | { type: "tool_result"; data: ToolCallResult }
  | { type: "done"; data: { inputTokens: number; outputTokens: number } };
```

## Pipeline

Chain multiple models in sequence with `ollamaPipeline`. Each stage runs an
independent `ollamaTask` — messages don't leak between stages — and the output
of one stage feeds into the next via `transform`.

> **Note:** `transform` receives `(prev, original)` — the previous stage's
> `ExecutionResult` and the original prompt from `.create()`, so later stages
> always have access to the user's original request.

```ts
import { ollamaPipeline } from "./src/ollamaPipeline.ts";

const results = await ollamaPipeline
  .create("Crie uma API REST com Deno + Hono para gerenciar tarefas")
  .stage({
    model: "qwen3.5:2b",
    system: "Refine o prompt do usuário. Seja claro e específico.",
    onContent: (c) => process.stdout.write(c),
  })
  .then({
    model: "qwen3.5:2b",
    system: "Gere um plano técnico detalhado em markdown. Não escreva código.",
    onContent: (c) => process.stdout.write(c),
  })
  .then({
    model: "qwen3.5:2b",
    system: "Gere código completo e funcional.",
    transform: (prev, original) =>
      `Pedido original:\n${original}\n\nPlano:\n${prev.content}\n\nGere o código.`,
    onContent: (c) => process.stdout.write(c),
  })
  .execute(); // → ExecutionResult[]

// results[0] → prompt refinado
// results[1] → plano técnico
// results[2] → código final
```

Use `.run()` to get only the last stage's result:

```ts
const final = await ollamaPipeline
  .create("...")
  .stage({ model: "a", system: "..." })
  .then({ model: "b", system: "..." })
  .run(); // → ExecutionResult (last stage only)
```

### StageConfig

| Property        | Type                           | Description                                  |
| --------------- | ------------------------------ | -------------------------------------------- |
| `model`         | `string`                       | Ollama model name (required)                 |
| `system`        | `string`                       | System prompt for this stage                 |
| `user`          | `string`                       | Override user message (default: prev result) |
| `transform`     | `(prev, original) => string`   | Transform previous result into next prompt   |
| `tools`         | `ToolDefinition[]`             | Tool schemas for this stage                  |
| `toolHandlers`  | `ToolHandler[]`                | Tool executor functions                      |
| `format`        | `string \| object`             | Response format (`"json"` or JSON schema)    |
| `maxIterations` | `number`                       | Cap tool-calling loops (default: `10`)       |
| `numCtx`        | `number`                       | Context window size (Ollama `num_ctx`)       |
| `temperature`   | `number`                       | Sampling temperature (0.0–2.0)               |
| `keepAlive`     | `string \| number`             | How long to keep model loaded                |
| `stop`          | `string[]`                     | Stop sequences to halt generation            |
| `numPredict`    | `number`                       | Max tokens to generate                       |
| `seed`          | `number`                       | Random seed for reproducibility              |
| `options`       | `Record<string, unknown>`      | Any Ollama runtime option                    |
| `onThinking`    | `(chunk: string) => void`      | Thinking token callback                      |
| `onContent`     | `(chunk: string) => void`      | Content token callback                       |
| `onToolCall`    | `(name, args) => void`         | Tool call callback                           |
| `onToolResult`  | `(name, args, result) => void` | Tool result callback                         |

## Tools (`src/tools/`)

Reusable, zero-dependency building blocks commonly exposed to the model as
tool-calling functions. Each is a single self-contained module returning
structured results. They also power `examples/pipeline-tools.ts`.

All functions take plain options and return serializable objects, so they map
cleanly onto `ToolDefinition`/`ToolHandler` pairs.

| Module          | Function / family                      | Description                                                             |
| --------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `Now.ts`        | `Now()`                                | Current timestamp: ISO, unix, timezone, UTC offset                      |
| `Calculator.ts` | `Calculator(expr)`                     | Evaluates arithmetic via a safe custom parser (no `eval`/`Function`)    |
| `ListDir.ts`    | `ListDir(path = ".")`                  | Lists entries `{ name, kind }`, dirs first, sorted                      |
| `FileRead.ts`   | `FileRead(path, { maxChars, offset })` | Reads a text file from a byte `offset` (`Deno.seek`), truncated         |
| `FileWrite.ts`  | `FileWrite(path, content)`             | Writes a text file, returns bytes written                               |
| `CodeSearch.ts` | `CodeSearch(pattern, opts)`            | Regex search across files; auto backend `rg` → Deno fallback            |
| `Which.ts`      | `Which(binary)`                        | Checks if a binary exists on `PATH` (no subprocess)                     |
| `RunCommand.ts` | `RunCommand(cmd, args, { timeoutMs })` | Runs a whitelisted command with timeout and output truncation           |
| `WebSearch.ts`  | `WebSearch(query)`                     | DuckDuckGo search, parses results and optional instant-answer           |
| `WebFetch.ts`   | `WebFetch(url, { maxChars })`          | Fetches a page and extracts title + clean text                          |
| `StateStore.ts` | `get/set/delete/list`                  | Persistent JSON K-V store (default `data/state.json`)                   |
| `html.ts`       | helpers                                | `stripTags`, `unescapeHtml`, `cleanText`, `extractText`, `extractTitle` |
| `net.ts`        | helpers                                | `BROWSER_HEADERS` + `fetchPage(url)`                                    |

### Calculator

Evaluates `+ - * / % ^`, parentheses, constants (`pi`, `e`, `tau`) and functions
(`sqrt`, `sin`, `cos`, `tan`, `abs`, `round`, `floor`, `ceil`, `log`, `ln`,
`min`, `max`). Uses a recursive-descent parser — the model never "calculates",
so results are deterministic.

```ts
import { Calculator } from "./src/tools/Calculator.ts";

Calculator("2 + 2"); // { expression, value: 4, error: null }
Calculator("sqrt(16) + abs(-4)"); // { value: 8, error: null }
Calculator("2 + process.exit(1)"); // { value: null, error: "caractere inesperado" }
```

### `CodeSearch` with dual backends

`backend: "auto"` (default) checks for `rg` via `Which()`; if available it runs
`rg` (`--allow-run=rg` needed), otherwise it falls back to a pure-Deno walk. The
response reports which backend ran. The `data/` directory (gitignored) is
excluded by default.

```ts
import { CodeSearch } from "./src/tools/CodeSearch.ts";

await CodeSearch("export const", {
  include: ["ts"],
  limit: 20,
  backend: "auto",
});
// { pattern, backend: "rg" | "deno", matches: [{ file, line, snippet }], truncated }
```

### StateStore

Simple persisted key-value store, backed by a JSON file. Default filename is
`data/state.json`, which lives in the gitignored `data/` folder. Each instance
maintains its own cache.

```ts
import { StateStore } from "./src/tools/StateStore.ts";

const store = new StateStore();
await store.set("theme", "dark");
await store.get("theme"); // { key: "theme", value: "dark" }
await store.list(); // { keys: ["theme"], count: 1 }
await store.delete("theme"); // { key: "theme", value: true }
```

#### Tool Factories (for ollamaTask)

```ts
import {
  StateStore,
  StateStoreGetTool,
  StateStoreSetTool,
} from "./src/tools/StateStore.ts";

const store = new StateStore();
const get = StateStoreGetTool(store);
const set = StateStoreSetTool(store);

await new ollamaTask("qwen3.5:2b")
  .tools([get.definition, set.definition])
  .toolHandlers([get.handler, set.handler])
  .execute();
```

Available factories: `StateStoreGetTool`, `StateStoreSetTool`,
`StateStoreDeleteTool`, `StateStoreListTool`, `StateStoreAllTools`.

## Examples

Run any example with:

```bash
deno run --allow-net=127.0.0.1:11434 examples/<file>.ts
```

| File                            | Feature                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| `examples/basic-chat.ts`        | Basic chat with thinking model                                      |
| `examples/tool-calling.ts`      | Tool calling with callbacks                                         |
| `examples/web-stream.ts`        | WebStreams API                                                      |
| `examples/structured-output.ts` | Structured outputs with JSON schema                                 |
| `examples/pipeline-usage.ts`    | Multi-model pipeline                                                |
| `examples/websearch-tool.ts`    | `web_search` wired into `ollamaTask`                                |
| `examples/pipeline-tools.ts`    | 4-stage pipeline using the full tool suite                          |
| `examples/example.ts`           | Contract-generation pipeline using all tools with `FileRead` offset |
| `examples/semantic-memory.ts`   | Semantic routing + RAG via memories                                 |
| `examples/embedding-store.ts`   | Vector store demo via memories                                      |
| `examples/rag-task.ts`          | Passive RAG with `.rag()` builder                                   |
| `examples/rag-tool.ts`          | Agentic RAG with `RAGSearchTool` tool                               |
| `examples/rag-pipeline.ts`      | RAG with `.ragStage()` pipeline stage                               |

The `examples/pipeline-tools.ts` example needs permission flags beyond the
Ollama host because it touches network, filesystem, environment and a partial
`--allow-run`:

```bash
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  examples/pipeline-tools.ts
```

The RAG examples (`rag-task.ts`, `rag-tool.ts`, `rag-pipeline.ts`) need
additional permissions for SQLite and the vector extension:

```bash
deno run --allow-net --allow-env --allow-read --allow-write --allow-ffi --allow-sys \
  examples/rag-task.ts
```

## Running with a Different Host

By default, `ollama-js` connects to `http://127.0.0.1:11434`. To use a remote
server, configure the Ollama client before instantiating `ollamaTask`:

```ts
import ollama from "ollama";

// Set via environment variable
// OLLAMA_HOST=http://my-server:11434 deno run --allow-net example.ts

// Or configure in code (create a custom client)
const customOllama = new ollama.Ollama({ host: "http://my-server:11434" });
```

## RAG & Semantic Memory

Built-in RAG capabilities via `src/memories/`:

- **Encrypted storage** — SQLite with SQLCipher encryption
- **Vector search** — KNN cosine similarity via sqlite-vector extension
- **Semantic chunking** — automatic text splitting by paragraphs/sections
- **Multi-provider** — Ollama and OpenAI-compatible endpoints

### Direct RAG Usage

```ts
import { RAG } from "./src/memories/rag.ts";

const rag = await RAG.create({ provider: "ollama" });
await rag.addText("Your document content...", { title: "Doc" });
const { answer, sources } = await rag.query("Your question?");
```

### RAG Passivo com ollamaTask

Use `.rag()` para buscar contexto automaticamente antes de executar:

```ts
import { ollamaTask } from "./src/ollamaTask.ts";
import { RAG } from "./src/memories/rag.ts";

const rag = await RAG.create();

const result = await (await new ollamaTask("qwen3.5:2b")
  .rag({ rag, k: 3 })
  .system("Você é um assistente útil.")
  .user("Como funciona a criptografia?")
  .onContent((chunk) => process.stdout.write(chunk))).execute();
```

| Opção          | Tipo      | Descrição                                 |
| -------------- | --------- | ----------------------------------------- |
| `rag`          | `RAG`     | Instância RAG (obrigatório)               |
| `k`            | `number`  | Top-k para busca (padrão: 5)              |
| `systemPrompt` | `string`  | Prompt customizado com contexto           |
| `autoIndex`    | `boolean` | Indexar pergunta+resposta automaticamente |
| `minScore`     | `number`  | Threshold para cache semântico            |

### RAG Agentic com Tool Calling

Use `RAGSearchTool` para que o modelo decida quando buscar:

```ts
import { ollamaTask } from "./src/ollamaTask.ts";
import { RAG } from "./src/memories/rag.ts";
import { RAGSearchTool } from "./src/tools/RAGSearch.ts";

const rag = await RAG.create();
const { definition, handler } = RAGSearchTool(rag, { k: 3 });

const result = await new ollamaTask("qwen3.5:2b")
  .system("Use rag_search para buscar informações antes de responder.")
  .user("Como funciona o SQLite?")
  .tools([definition])
  .toolHandlers([handler])
  .onToolCall((name, args) =>
    console.log(`🔧 ${name}(${JSON.stringify(args)})`)
  )
  .execute();
```

### RAG com ollamaPipeline

Use `.ragStage()` para estágios com contexto RAG automático:

```ts
import { ollamaPipeline } from "./src/ollamaPipeline.ts";
import { RAG } from "./src/memories/rag.ts";

const rag = await RAG.create();

const results = await ollamaPipeline
  .create("Explique como funciona o sistema")
  .ragStage({
    model: "qwen3.5:2b",
    rag,
    k: 3,
    system: "Analise o contexto encontrado.",
    onContent: (c) => process.stdout.write(c),
  })
  .then({
    model: "qwen3.5:2b",
    system: "Gere uma resposta completa.",
    onContent: (c) => process.stdout.write(c),
  })
  .execute();
```

Também é possível usar RAG no `transform` de qualquer estágio:

```ts
const results = await ollamaPipeline
  .create("Pergunta do usuário")
  .stage({
    model: "qwen3.5:2b",
    transform: async (prev, original) => {
      const hits = await rag.search(original, { k: 3 });
      const context = hits.map((h) => `- ${h.content}`).join("\n");
      return `Contexto:\n${context}\n\nPergunta: ${original}`;
    },
  })
  .execute();
```

## License

MIT
