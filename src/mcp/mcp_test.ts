/**
 * Testes unitários offline dos helpers de `src/mcp/client.ts`:
 * conversão de schema, extração de conteúdo de `CallToolResult` e o
 * discriminador stdio vs. remoto. Sem rede, sem subprocessos.
 */
import { assertEquals } from "@std/assert";
import { convertSchema, isRemote, parseToolResultContent } from "./client.ts";

Deno.test("convertSchema: tipos e required de propriedades", () => {
  const def = convertSchema("echo", "Echoa o texto de volta.", {
    type: "object",
    properties: {
      text: { type: "string", description: "Texto a ecoar" },
      count: { type: "integer" },
      flag: { type: "boolean" },
      mode: { type: "string", enum: ["fast", "slow"] },
      unknownType: { type: "file" },
    },
    required: ["text"],
  });

  assertEquals(def, {
    type: "function",
    function: {
      name: "echo",
      description: "Echoa o texto de volta.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Texto a ecoar",
            enum: undefined,
          },
          count: { type: "number", description: undefined, enum: undefined },
          flag: { type: "boolean", description: undefined, enum: undefined },
          mode: {
            type: "string",
            description: undefined,
            enum: ["fast", "slow"],
          },
          unknownType: {
            type: "string",
            description: undefined,
            enum: undefined,
          },
        },
        required: ["text"],
      },
    },
  });
});

Deno.test("convertSchema: sem properties devolve objeto vazio sem required", () => {
  const def = convertSchema("ping", "Sem argumentos.", {
    type: "object",
  });

  assertEquals(def.function.parameters, {
    type: "object",
    properties: {},
    required: undefined,
  });
});

Deno.test("parseToolResultContent: texto JSON vira objeto", () => {
  const result = parseToolResultContent(
    [{ type: "text", text: '{"result": 42}' }],
    "fallback",
  );
  assertEquals(result, { result: 42 });
});

Deno.test("parseToolResultContent: texto puro vira string", () => {
  const result = parseToolResultContent(
    [{ type: "text", text: "olá mundo" }],
    "fallback",
  );
  assertEquals(result, "olá mundo");
});

Deno.test("parseToolResultContent: sem conteúdo devolve fallback", () => {
  const content = [{ type: "resource", resource: {} }];
  assertEquals(parseToolResultContent(content, "fb"), "fb");
  assertEquals(parseToolResultContent([], "fb"), "fb");
  assertEquals(parseToolResultContent(undefined, "fb"), "fb");
});

Deno.test("isRemote: distingue stdio de remoto", () => {
  assertEquals(
    isRemote({ command: "deno", args: ["run", "server.ts"] }),
    false,
  );
  assertEquals(isRemote({ type: "stdio", command: "npx", args: [] }), false);
  assertEquals(
    isRemote({ type: "remote", url: "http://localhost:9000" }),
    true,
  );
  assertEquals(
    isRemote({ type: "remote", url: "http://localhost:9000" }),
    true,
  );
});
