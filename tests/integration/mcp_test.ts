/**
 * Testes de integração do `MCPBridge` — valida handshake, listagem de tools
 * e round-trip callTool contra um servidor MCP fake via stdio.
 *
 * Rode com: deno task test:int
 *
 * Não exige Ollama — usa um fake JSON-RPC puro (`fake-mcp-server.ts`) que
 * não depende do SDK.
 */
import { assert, assertEquals } from "@std/assert";
import { MCPBridge } from "../../src/mcp/client.ts";

const FAKE_SERVER_PATH = new URL("./fake-mcp-server.ts", import.meta.url)
  .pathname;

Deno.test("MCP Bridge E2E: handshake + listTools + callTool (stdio)", async () => {
  const bridge = await MCPBridge.connect({
    command: "deno",
    args: ["run", "--allow-all", FAKE_SERVER_PATH],
  });

  try {
    const { definitions, handlers } = bridge.getTools();

    assertEquals(definitions.length, 2, "servidor fake expõe 2 tools");

    // ── Schema ──────────────────────────────────────────────────────────────
    const echoDef = definitions.find((d) => d.function.name === "echo")!;
    assert(echoDef, "tool 'echo' existe");
    assertEquals(echoDef.function.parameters.required, ["text"]);
    assertEquals(echoDef.function.parameters.properties.text.type, "string");

    const sumDef = definitions.find((d) => d.function.name === "sum")!;
    assert(sumDef, "tool 'sum' existe");
    assertEquals(
      sumDef.function.parameters.properties.a.type,
      "number",
      "integer mapeado para number",
    );

    // ── callTool echo ───────────────────────────────────────────────────────
    const echoHandler = handlers.find((h) => h.name === "echo")!;
    assert(echoHandler, "handler 'echo' existe");
    const echoed = await echoHandler.execute({ text: "olá" });
    assertEquals(echoed, { echoed: "olá" });

    // ── callTool sum ────────────────────────────────────────────────────────
    const sumHandler = handlers.find((h) => h.name === "sum")!;
    assert(sumHandler, "handler 'sum' existe");
    const summed = await sumHandler.execute({ a: 20, b: 22 });
    assertEquals(summed, 42, "20 + 22 = 42");
  } finally {
    await bridge.close();
  }
});
