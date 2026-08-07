import {
  ollamaTask,
  type ToolDefinition,
  type ToolHandler,
} from "../src/ollamaTask.ts";

const weatherTool: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
};

const weatherHandler: ToolHandler = {
  name: "get_weather",
  execute: (args) => ({
    temperature: 22,
    condition: "sunny",
    location: args.location,
  }),
};

const model = "LFM2.5:1.2b-thinking";

const result = await new ollamaTask(model)
  .system("You are a helpful assistant. Use tools when you need data.")
  .user("What's the weather in Paris?")
  .tools([weatherTool])
  .toolHandlers([weatherHandler])
  .onThinking((chunk) => {
    Deno.stdout.writeSync(new TextEncoder().encode(`\x1b[90m${chunk}\x1b[0m`));
  })
  .onContent((chunk) => {
    Deno.stdout.writeSync(new TextEncoder().encode(chunk));
  })
  .onToolCall((name, args) => {
    console.log(`\n🔧 Calling: ${name}(${JSON.stringify(args)})`);
  })
  .onToolResult((name, args, result) => {
    console.log(
      `\n📦 ${name} ${JSON.stringify(args)} → ${JSON.stringify(result)}`,
    );
  })
  .execute();

console.log("\n---");
console.log(`Tool calls: ${result.toolCalls.length}`);
console.log(`Input tokens: ${result.inputTokens}`);
console.log(`Output tokens: ${result.outputTokens}`);
