/**
 * Exemplo: ollamaPipeline com MCP servers por stage.
 *
 * Cada stage do pipeline pode se conectar a MCP servers diferentes.
 * As tools MCP são automaticamente injetadas no ollamaTask do stage.
 *
 * deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
 *   examples/mcp-pipeline.ts
 */
import { ollamaPipeline } from "../src/ollamaPipeline.ts";

const MCP_SERVER = {
  command: "deno",
  args: [
    "run",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    "src/mcp/server.ts",
  ],
};

const write = (token: string) =>
  Deno.stdout.writeSync(new TextEncoder().encode(token));
const gray = (token: string) => write(`\x1b[90m${token}\x1b[0m`);

console.log("=== ollamaPipeline + MCP ===\n");

const results = await ollamaPipeline
  .create("List files in src/tools/ and tell me the current time.")
  .stage({
    model: "lfm2.5-thinking",
    system:
      "You are a helpful assistant. Use the MCP tools available to you. " +
      "List the directory, get the time, and summarize.",
    mcpServers: [MCP_SERVER],
    maxIterations: 4,
    onThinking: gray,
    onContent: write,
    onToolCall: (name, args) => {
      console.log(`\n🔧 MCP: ${name}(${JSON.stringify(args)})`);
    },
    onToolResult: (name, _args, result) => {
      const json = JSON.stringify(result);
      console.log(
        `📦 ${name} → ${json.length > 200 ? json.slice(0, 200) + "…" : json}`,
      );
    },
  })
  .execute();

console.log("\n\n--- Pipeline Done ---");
for (let i = 0; i < results.length; i++) {
  console.log(
    `Stage ${i + 1}: ${results[i].inputTokens} in / ${results[i].outputTokens} out, ${results[i].toolCalls.length} tool calls`,
  );
}
Deno.exit(0);
