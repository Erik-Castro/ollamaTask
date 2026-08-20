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
      "Search the web via DuckDuckGo. Returns structured results as Array<{ title, snippet, link }>. Use offset to paginate (0=first page, 10=second, etc.). Check nextOffset in the response for the next page.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        offset: {
          type: "integer",
          description: "Page offset (0=first page, 10=second, etc.)",
        },
      },
      required: ["query"],
    },
  },
};

const searchHandler: ToolHandler = {
  name: "web_search",
  execute: ({ query, offset }) =>
    WebSearch(String(query), {
      offset: offset != null ? Number(offset) : undefined,
    }),
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
    const page = toolResult as { results: unknown[]; nextOffset?: number };
    const count = page?.results?.length ?? 0;
    const next = page?.nextOffset;
    console.log(
      `\n📦 ${name}(${JSON.stringify(args)}) → ${count} resultados${
        next != null ? ` | nextOffset: ${next}` : ""
      }`,
    );
  })
  .execute();

console.log("\n---");
console.log(`Tool calls: ${result.toolCalls.length}`);
console.log(`Input tokens: ${result.inputTokens}`);
console.log(`Output tokens: ${result.outputTokens}`);
