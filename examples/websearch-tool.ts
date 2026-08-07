import {
  ollamaTask,
  type ToolDefinition,
  type ToolHandler,
} from "../src/ollamaTask.ts";
import { WebSearch } from "../src/tools/WebSearch.ts";

const searchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web via DuckDuckGo. Returns structured results as Array<{ title, snippet, link }>.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    },
  },
};

const searchHandler: ToolHandler = {
  name: "web_search",
  execute: ({ query }) => WebSearch(String(query)),
};

const model = "LFM2.5:8B-A1B";

const result = await new ollamaTask(model)
  .system(
    "You are a helpful assistant. Use the web_search tool to get up-to-date information before answering.",
  )
  .user("Qual é a versão mais recente do Hono e quais as novidades em 2026?")
  .tools([searchTool])
  .toolHandlers([searchHandler])
  .onThinking((chunk) => {
    Deno.stdout.writeSync(new TextEncoder().encode(`\x1b[90m${chunk}\x1b[0m`));
  })
  .onContent((chunk) => {
    Deno.stdout.writeSync(new TextEncoder().encode(chunk));
  })
  .onToolCall((name, args) => {
    console.log(`\n🔧 Calling: ${name}(${JSON.stringify(args)})`);
  })
  .onToolResult((name, args, toolResult) => {
    const page = Array.isArray(toolResult) ? toolResult[0] : undefined;
    const count = page?.results?.length ?? 0;
    console.log(
      `\n📦 ${name}(${JSON.stringify(args)}) → ${count} resultados${
        page?.query ? ` | query: ${page.query.title}` : ""
      }`,
    );
  })
  .execute();

console.log("\n---");
console.log(`Tool calls: ${result.toolCalls.length}`);
console.log(`Input tokens: ${result.inputTokens}`);
console.log(`Output tokens: ${result.outputTokens}`);
