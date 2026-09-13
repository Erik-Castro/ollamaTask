/**
 * Testes do registro e execução segura de ferramentas (src/tools.ts) — offline.
 */
import { z } from "zod";
import { assertEquals, assertThrows } from "@std/assert";
import { formatZodIssues, ToolRegistry, toOpenAITool } from "./tools.ts";
import type { Tool } from "./types.ts";

const echo: Tool = {
  name: "echo",
  description: "Repete o texto.",
  parameters: z.object({
    text: z.string(),
    times: z.number().int().optional(),
    loud: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    level: z.enum(["low", "high"]).optional(),
  }),
  execute: (params) => params["text"] as string,
};

Deno.test("registra e lista ferramentas", () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  assertEquals(registry.list().map((t) => t.name), ["echo"]);
  assertEquals(registry.get("echo"), echo);
});

Deno.test("rejeita registro duplicado", () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  assertThrows(() => registry.register(echo), Error, "já registrada");
});

Deno.test("executeSafe: ferramenta desconhecida não lança", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  const res = await registry.executeSafe("nope", "{}");
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("Ferramenta desconhecida"), true);
});

Deno.test("executeSafe: JSON malformado vira erro estruturado", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  const res = await registry.executeSafe("echo", "{nao-e-json");
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("JSON inválido"), true);
});

Deno.test("executeSafe: parâmetros fora de objeto JSON", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  assertEquals((await registry.executeSafe("echo", '"texto"')).ok, false);
  assertEquals((await registry.executeSafe("echo", "42")).ok, false);
  assertEquals((await registry.executeSafe("echo", "null")).ok, false);
});

Deno.test("executeSafe: validação Zod (required/tipos/enum)", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);

  const missing = await registry.executeSafe("echo", "{}");
  assertEquals(missing.ok, false);
  assertEquals(missing.error?.includes("$.text"), true);
  assertEquals(missing.error?.includes("expected string"), true);

  const wrongType = await registry.executeSafe("echo", '{"text": 42}');
  assertEquals(wrongType.ok, false);
  assertEquals(wrongType.error?.includes("expected string"), true);

  const badEnum = await registry.executeSafe(
    "echo",
    '{"text": "a", "level": "x"}',
  );
  assertEquals(badEnum.ok, false);
  assertEquals(badEnum.error?.includes("expected one of"), true);
});

Deno.test("executeSafe: schema opcional valida arrays/índices", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  const res = await registry.executeSafe(
    "echo",
    '{"text":"a","tags":[1,"ok"]}',
  );
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("$.tags.0"), true);
  assertEquals(res.error?.includes("expected string"), true);
});

Deno.test("executeSafe: execução bem-sucedida com params parseados", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  const ok = await registry.executeSafe("echo", '{"text":"oi"}');
  assertEquals(ok, { ok: true, output: "oi" });
});

Deno.test("executeSafe: sem schema, aceita objeto livre", async () => {
  const free: Tool = {
    name: "free",
    description: "Sem validação de parâmetros.",
    execute: (params) => JSON.stringify(params),
  };
  const registry = new ToolRegistry();
  registry.register(free);
  const ok = await registry.executeSafe("free", '{"qualquer":1}');
  assertEquals(ok, { ok: true, output: '{"qualquer":1}' });
});

Deno.test("executeSafe: erro de execução vira erro estruturado", async () => {
  const flaky: Tool = {
    name: "flaky",
    description: "Falha sempre.",
    execute: () => {
      throw new Error("boom da tool");
    },
  };
  const registry = new ToolRegistry();
  registry.register(flaky);
  const res = await registry.executeSafe("flaky", "{}");
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("boom da tool"), true);
});

Deno.test("formatZodIssues: issues viram '$.caminho: mensagem'", () => {
  const result = z.object({ text: z.string() }).safeParse({ text: 1 });
  assertEquals(result.success, false);
  const formatted = formatZodIssues(result.error!);
  assertEquals(formatted.includes("$.text"), true);
  assertEquals(formatted.includes("expected string"), true);
});

Deno.test("toOpenAITool: parametersJsonSchema é anunciado direto (sem $schema)", () => {
  const manual: Tool = {
    name: "manual",
    description: "Schema manual sem zod.",
    parametersJsonSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
    execute: (params) => JSON.stringify(params),
  };
  const openAITool = toOpenAITool(manual) as {
    type: string;
    name: string;
    parameters: Record<string, unknown> | null;
  };
  assertEquals(openAITool.type, "function");
  assertEquals(openAITool.name, "manual");
  const params = openAITool.parameters as Record<string, unknown>;
  assertEquals(params["$schema"], undefined);
  assertEquals(params["type"], "object");
  assertEquals(
    (params["properties"] as Record<string, unknown>)["q"],
    { type: "string" },
  );
});

Deno.test("toOpenAITool: sem schema algum, parameters fica null", () => {
  const bare: Tool = {
    name: "bare",
    description: "Sem schema.",
    execute: () => "ok",
  };
  const openAITool = toOpenAITool(bare) as {
    name: string;
    parameters: Record<string, unknown> | null;
  };
  assertEquals(openAITool.name, "bare");
  assertEquals(openAITool.parameters, null);
});

Deno.test("executeSafe: parametersJsonSchema só exige JSON parseável + objeto", async () => {
  const manual: Tool = {
    name: "manual",
    description: "Schema manual sem zod.",
    parametersJsonSchema: {
      type: "object",
      properties: { a: { type: "number" } },
    },
    execute: (params) => String(params["a"]),
  };
  const registry = new ToolRegistry();
  registry.register(manual);

  const ok = await registry.executeSafe("manual", '{"a": 42}');
  assertEquals(ok, { ok: true, output: "42" });

  const badJson = await registry.executeSafe("manual", "{nope");
  assertEquals(badJson.ok, false);
  assertEquals(badJson.error?.includes("Argumentos JSON inválidos"), true);
});
