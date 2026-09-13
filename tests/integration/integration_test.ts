/**
 * Testes de integração ponta a ponta contra Ollama local.
 * Rode com: deno task test:int
 *
 * Exige Ollama rodando em http://localhost:11434 com o modelo (default:
 * nemotron-3-nano:30b-cloud). Para usar outro, exporte OPENAI_MODEL.
 *
 * Todos os testes usam o harness v1 (ReAct.run) e o provider real,
 * provando que o streaming, a validação, a poda por tokens e o
 * self-healing funcionam de verdade com o modelo instalado.
 */
import { z } from "zod";
import { assert, assertEquals } from "@std/assert";
import { ReAct, type Tool } from "../../src/engine/mod.ts";
import { assertOllamaAvailable, collect, makeResponses } from "./helpers.ts";

const MODEL = Deno.env.get("OPENAI_MODEL") ?? "nemotron-3-nano:30b-cloud";

await assertOllamaAvailable(MODEL);

const uppercaseTool: Tool = {
  name: "uppercase",
  description: "Converte texto para maiúsculas.",
  parameters: z.object({ text: z.string() }).strict(),
  execute: ({ text }) => String(text).toUpperCase(),
};

const sumTool: Tool = {
  name: "sum",
  description: "Soma dois números inteiros.",
  parameters: z.object({ a: z.number().int(), b: z.number().int() }).strict(),
  execute: ({ a, b }) => String(Number(a) + Number(b)),
};

function makeAgent(maxRounds = 6) {
  return new ReAct(
    {
      model: MODEL,
      system_prompt:
        "Você é um assistente direto. Use as ferramentas quando necessário. Responda em português.",
      maxRounds,
    },
    { responses: makeResponses() },
  );
}

Deno.test("E2E: tool round completo (uppercase)", async () => {
  const agent = makeAgent();
  agent.registryTool(uppercaseTool);

  const { events, result } = await collect(
    agent.run("Transforme a palavra pelicano em maiusculas."),
  );

  const reasoningEvents = events.filter((e) => e.type === "reasoning");
  const toolCalls = events.filter((e) => e.type === "tool_call");
  const toolResults = events.filter((e) => e.type === "tool_result");

  assert(
    reasoningEvents.length >= 1,
    `reasoning events >= 1 (teve ${reasoningEvents.length})`,
  );
  assert(toolCalls.length >= 1, "houve ao menos 1 tool_call");
  assert(toolResults.length >= 1, "houve ao menos 1 tool_result");

  const tr = toolResults[0] as {
    type: "tool_result";
    tool: string;
    ok: boolean;
    output: string;
  };
  assertEquals(tr.tool, "uppercase");
  assertEquals(tr.ok, true);
  assertEquals(tr.output, "PELICANO");

  const call = toolCalls[0] as {
    type: "tool_call";
    tool: string;
    args: string;
  };
  const parsed = JSON.parse(call.args);
  assertEquals(parsed.text, "pelicano");

  assert(result.content.content.length > 0, "content final não vazio");
  assert(
    result.content.content.includes("PELICANO"),
    `content inclui "PELICANO" (conteúdo: ${
      result.content.content.slice(0, 80)
    }...)`,
  );
  assert(result.rounds >= 1, "rounds >= 1");
  assert(result.toolCalls >= 1, "toolCalls >= 1");
  assert(
    result.totalTokens > 0,
    `totalTokens > 0 (teve ${result.totalTokens})`,
  );
  assertEquals(agent.state, "idle");
});

Deno.test("E2E: contexto entre rounds com multi-tool (sum)", async () => {
  const agent = makeAgent();
  agent.registryTool(sumTool);

  const { events, result } = await collect(
    agent.run(
      "Some 10 com 5. Depois some 41 com 1. Me diga o resultado de cada soma.",
    ),
  );

  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert(
    toolCalls.length >= 2,
    `toolCalls >= 2 (teve ${toolCalls.length})`,
  );
  assert(
    result.toolCalls >= 2,
    `result.toolCalls >= 2 (teve ${result.toolCalls})`,
  );
  assert(
    result.rounds >= 2,
    `rounds >= 2 (teve ${result.rounds})`,
  );

  const outputs = events
    .filter((e) => e.type === "tool_result")
    .map((e) => (e as { output: string }).output);
  assert(outputs.includes("15"), "resultado 15 presente");
  assert(outputs.includes("42"), "resultado 42 presente");

  assert(
    result.content.content.includes("15") &&
      result.content.content.includes("42"),
    `content final menciona ambas as somas (15 e 42); conteúdo: ${
      result.content.content.slice(0, 120)
    }...`,
  );
  assertEquals(agent.state, "idle");
});
