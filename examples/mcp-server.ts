/**
 * MCP Server standalone — expõe todas as tools de src/tools/ via protocolo MCP.
 *
 * Para testar:
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
 *     examples/mcp-server.ts
 */
import { startServer } from "../src/mcp/server.ts";

console.error("[mcp-server] Iniciando ollama-task-tools MCP server (stdio)...");

await startServer();
