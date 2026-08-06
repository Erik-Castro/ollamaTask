import { ollamaTask } from "../src/ollamaTask.ts";

interface Weather {
  location: string;
  temperature: number;
  condition: string;
  humidity: number;
}

const weatherSchema = {
  type: "object",
  properties: {
    location: { type: "string" },
    temperature: { type: "number" },
    condition: { type: "string" },
    humidity: { type: "number" },
  },
  required: ["location", "temperature", "condition", "humidity"],
};

const model = "qwen2.5-coder:0.5b";

const result = await new ollamaTask(model)
  .system("You are a weather assistant. Always respond with valid JSON.")
  .user("What's the weather in Paris today?")
  .format(weatherSchema)
  .onThinking((chunk) => {
    process.stdout.write(`\x1b[90m${chunk}\x1b[0m`);
  })
  .onContent((chunk) => {
    process.stdout.write(chunk);
  })
  .execute();

console.log("\n---");
console.log("Raw content:", result.content);

const weather = result.parse<Weather>();
console.log("Parsed:", weather);
console.log(`Location: ${weather.location}`);
console.log(`Temp: ${weather.temperature}°C`);
console.log(`Condition: ${weather.condition}`);
console.log(`Input tokens: ${result.inputTokens}`);
console.log(`Output tokens: ${result.outputTokens}`);
