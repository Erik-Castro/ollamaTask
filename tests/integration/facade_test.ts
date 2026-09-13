/**
 * Testes de integração da fachada `ollamaTask` — cobrem a camada de adaptação
 * (streaming, tool_call, format, modelParams) entre a API pública do consumidor
 * e o motor ReAct interno.
 *
 * Rode com: deno task test:int
 *
 * Exige Ollama local em http://127.0.0.1:11434 com o modelo default
 * (nemotron-3-nano:30b-cloud) ou com OPENAI_MODEL exportado.
 */
import { assert, assertEquals } from "@std/assert";
import {
  ollamaTask,
  type StreamEvent,
  type ToolDefinition,
  type ToolHandler,
} from "../../src/ollamaTask.ts";
import { assertOllamaAvailable } from "./helpers.ts";

const MODEL = Deno.env.get("OPENAI_MODEL") ?? "nemotron-3-nano:30b-cloud";

await assertOllamaAvailable(MODEL);

/** Varre recursivamente um JSON em busca de um número `target`. */
function containsNumber(value: unknown, target: number): boolean {
  if (typeof value === "number") return value === target;
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some((v) => containsNumber(v, target));
}

// ── Definições de tool compartilhadas ────────────────────────────────────────

const uppercaseDef: ToolDefinition = {
  type: "function",
  function: {
    name: "uppercase",
    description: "Converte texto para maiúsculas.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
};

const uppercaseHandler: ToolHandler = {
  name: "uppercase",
  execute: (args) => String(args.text).toUpperCase(),
};

// ── Testes ───────────────────────────────────────────────────────────────────

Deno.test("fachada E2E: chat simples via execute()", async () => {
  const task = new ollamaTask(MODEL)
    .system("Você é um assistente direto e conciso.")
    .user("Quanto é 2 + 2? Responda com apenas o número.")
    .maxIterations(3);

  const result = await task.execute();

  assert(result.content.length > 0, "content não vazio");
  assert(
    result.inputTokens > 0,
    `inputTokens > 0 (teve ${result.inputTokens})`,
  );
  assert(
    result.outputTokens > 0,
    `outputTokens > 0 (teve ${result.outputTokens})`,
  );
  assertEquals(result.toolCalls.length, 0, "sem tool calls");
});

Deno.test("fachada E2E: tool round (uppercase)", async () => {
  const task = new ollamaTask(MODEL)
    .system(
      "Você é um assistente direto. Use a ferramenta uppercase quando o usuário pedir.",
    )
    .user('Transforme a palavra "pelicano" em maiusculas.')
    .tools([uppercaseDef])
    .toolHandlers([uppercaseHandler])
    .maxIterations(6);

  const result = await task.execute();

  assert(
    result.toolCalls.length >= 1,
    `toolCalls >= 1 (teve ${result.toolCalls.length})`,
  );
  assertEquals(result.toolCalls[0].name, "uppercase");
  assertEquals(result.toolCalls[0].result, "PELICANO");
  assert(
    result.content.includes("PELICANO"),
    `content inclui "PELICANO": ${result.content.slice(0, 120)}`,
  );
  assert(result.inputTokens > 0);
});

Deno.test("fachada E2E: formato estruturado com .format/.parse()", async () => {
  const schema = {
    type: "object",
    properties: {
      result: { type: "integer", description: "Resultado da operação" },
    },
    required: ["result"],
  };

  const task = new ollamaTask(MODEL)
    .system("Responda SOMENTE com JSON válido seguindo o schema informado.")
    .user("Quanto é 2 + 2? Responda apenas com o JSON.")
    .format(schema)
    .maxIterations(3);

  const result = await task.execute();

  // O modelo decide o shape (escalar `4`, `{"result":4}`, `{"answer":4}`, ...):
  // o que importa é a saída ser JSON válido contendo a resposta numérica.
  const parsed = result.parse<unknown>();
  assert(
    containsNumber(parsed, 4),
    `.format()/.parse() gerou JSON com o valor 4 (teve: ${result.content})`,
  );
  assert(result.inputTokens > 0, "tokens registrados");
});

Deno.test("fachada E2E: streaming + modelParams/seed", async () => {
  const task = new ollamaTask(MODEL)
    .system("Você é um assistente direto.")
    .user("Diga apenas a palavra OLLAMA em maiúsculas, nada mais.")
    .numCtx(2048)
    .temperature(0)
    .seed(42)
    .numPredict(10)
    .maxIterations(2);

  const events: StreamEvent[] = [];
  for await (const event of task.toReadableStream()) {
    events.push(event);
  }

  assert(
    events.some((e) => e.type === "content"),
    "houve ao menos 1 evento content",
  );
  assert(
    events.some((e) => e.type === "done"),
    "evento done presente",
  );

  const doneEvent = events.find((e) => e.type === "done");
  assert(doneEvent, "done existe");
  assertEquals(doneEvent.type, "done");
  assert(
    (doneEvent.data as { outputTokens: number }).outputTokens > 0,
    "outputTokens > 0 no done",
  );
});
