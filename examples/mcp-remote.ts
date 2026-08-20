/**
 * Remote MCP example — connects to the Exa search server via HTTP.
 *
 * Usage:
 *   deno run --allow-net examples/mcp-remote.ts [model]
 */

import {
  ollamaTask,
} from "../src/ollamaTask.ts";
import { MCPBridge } from "../src/mcp/client.ts";

const EXA_URL = "https://mcp.exa.ai/mcp";

console.log("Connecting to Exa MCP server...");
const bridge = await MCPBridge.connect({
  type: "remote",
  url: EXA_URL,
});

const { definitions, handlers } = bridge.getTools();
console.log(`Found ${definitions.length} tools:`);
for (const d of definitions) {
  console.log(`  - ${d.function.name}: ${d.function.description}`);
}

const model = Deno.args[0] ?? "LFM2.5:8B-A1B";

const result = await new ollamaTask(model)
  .system(
    "You are a helpful assistant. Use the exa_search tool to find recent information before answering.",
  )
  .user("What are the latest developments in Deno 2.x in 2026?")
  .tools(definitions)
  .toolHandlers(handlers)
  .onThinking((chunk) => {
    Deno.stdout.writeSync(new TextEncoder().encode(`\x1b[90m${chunk}\x1b[0m`));
  })
  .onContent((chunk) => {
    Deno.stdout.writeSync(new TextEncoder().encode(chunk));
  })
  .onToolCall((name, args) => {
    console.log(`\n🔧 ${name}(${JSON.stringify(args)})`);
  })
  .onToolResult((name, _args, res) => {
    const text =
      typeof res === "string" ? res.slice(0, 200) : JSON.stringify(res).slice(0, 200);
    console.log(`\n📦 ${name} → ${text}...`);
  })
  .execute();

console.log("\n---");
console.log(`Tool calls: ${result.toolCalls.length}`);
console.log(`Tokens: ${result.inputTokens} in / ${result.outputTokens} out`);

await bridge.close();
