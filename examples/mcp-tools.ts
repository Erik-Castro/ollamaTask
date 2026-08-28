/**
 * Exemplo: ollamaTask + MCP client conectando ao servidor local.
 *
 * O servidor MCP é iniciado automaticamente como child process via stdio.
 * As tools do MCP são convertidas para o formato ToolDefinition/ToolHandler
 * do ollamaTask e usadas normalmente no loop de tool calling.
 *
 * deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
 *   examples/mcp-tools.ts
 */
import { ollamaTask } from "../src/ollamaTask.ts";

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

console.log("=== ollamaTask + MCP Client ===\n");
console.log("Connecting to MCP server...\n");

const task = new ollamaTask("qwen3.5:2b")
  .system(
    "You are a helpful assistant with access to filesystem and web tools via MCP. " +
    "Use tools when needed. Be concise.",
  )
  .user(
    "List the files in the current directory using the list_dir tool, " +
    "then check the current time with the now tool. " +
    "Summarize what you found.",
  );

await task.useMCP(MCP_SERVER);

const result = await task
  .onThinking(gray)
  .onContent(write)
  .onToolCall((name: string, args: Record<string, unknown>) => {
    console.log(`\n🔧 MCP: ${name}(${JSON.stringify(args)})`);
  })
  .onToolResult(
    (name: string, _args: Record<string, unknown>, result: unknown) => {
      const json = JSON.stringify(result);
      console.log(
        `📦 ${name} → ${json.length > 200 ? json.slice(0, 200) + "…" : json}`,
      );
    },
  )
  .execute();

console.log("\n\n--- Result ---");
console.log(`Tool calls: ${result.toolCalls.length}`);
console.log(`Input tokens: ${result.inputTokens}`);
console.log(`Output tokens: ${result.outputTokens}`);
