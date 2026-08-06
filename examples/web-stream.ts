import { ollamaTask } from "../src/ollamaTask.ts";

const model = "qwen2.5-coder:0.5b";

const task = new ollamaTask(model)
  .system("You are a helpful assistant.")
  .user("Explain what a ReadableStream is in one sentence.");

const stream = task.toReadableStream();
const reader = stream.getReader();

console.log("=== WebStream events ===\n");

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  switch (value.type) {
    case "thinking":
      process.stdout.write(`\x1b[90m[thinking] ${value.data}\x1b[0m`);
      break;
    case "content":
      process.stdout.write(value.data);
      break;
    case "tool_call":
      console.log(`\n🔧 Tool call: ${value.data.function.name}`);
      break;
    case "tool_result":
      console.log(`📦 Result: ${JSON.stringify(value.data.result)}`);
      break;
    case "done":
      console.log(
        `\n--- done (in: ${value.data.inputTokens}, out: ${value.data.outputTokens}) ---`,
      );
      break;
  }
}
