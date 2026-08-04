import { ollamaTask } from "./ollamaTask.ts";
import { PromptEnginner } from "./prompts.ts";

const model = "LFM2.5:1.2b-instruct";

const result = await new ollamaTask(model)
  .system(PromptEnginner)
  .user("Gen a complete ERP with typescript with deno runtime and postgress db")
  .onThinking((chunk) =>
    Deno.stdout.writeSync(new TextEncoder().encode(`\x1b[90m${chunk}\x1b[0m`))
  )
  .onContent((chunk) => {
    Deno.stdout.writeSync(new TextEncoder().encode(chunk));
  })
  .execute();

console.log("\n---");
console.log(`Input tokens: ${result.inputTokens}`);
console.log(`Output tokens: ${result.outputTokens}`);
