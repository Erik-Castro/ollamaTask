import { SemanticRouter } from "../src/semanticRouter.ts";
import { cachedRun } from "../src/cachedRun.ts";

const requiredModels = [
  "nomic-embed-text",
  "qwen3.5:2b",
  "lfm2.5-thinking:latest",
];

for (const model of requiredModels) {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags");
    const data = await res.json() as { models: Array<{ name: string }> };
    const found = data.models.some((m) => m.name.startsWith(model));
    if (!found) {
      console.error(
        `Required model "${model}" not found. Run: ollama pull ${model}`,
      );
      Deno.exit(1);
    }
  } catch {
    console.error(
      "Cannot reach Ollama at http://127.0.0.1:11434. Is it running?",
    );
    Deno.exit(1);
  }
}

console.log("=== Semantic Memory (via memories RAG) ===\n");

const router = await SemanticRouter.create({
  provider: "ollama",
  genModel: "qwen3.5:2b",
  dbPath: "./data/semantic-test.db",
});

await router.register({
  name: "codegen",
  examples: [
    "escreva uma função que valide entrada",
    "crie um endpoint REST para usuários",
    "gere código typescript para autenticação",
  ],
  model: "qwen3.5:2b",
  systemPrompt:
    "You are a code generation assistant. Write clean, typed TypeScript code.",
});

await router.register({
  name: "reasoning",
  examples: [
    "explique como esse algoritmo funciona",
    "por que isso acontece no sistema",
    "raciocine passo a passo sobre esse problema",
  ],
  model: "lfm2.5-thinking:latest",
  systemPrompt:
    "You are a reasoning assistant. Think step by step and explain clearly.",
});

console.log("Routes registered: codegen, reasoning\n");

const INPUT_A = "Crie uma função TypeScript que valide e-mail com regex";
const INPUT_B =
  "Escreva uma função TS para validar email usando expressão regular";

console.log(`[Test 1] Route "${INPUT_A.slice(0, 40)}..."`);
const t1Start = Date.now();
const r1 = await router.route(INPUT_A);
const t1Time = ((Date.now() - t1Start) / 1000).toFixed(1);

console.log(`  route=${r1.route} score=${r1.score.toFixed(3)}`);
console.log(
  `  tokens: ${r1.result.inputTokens} in / ${r1.result.outputTokens} out`,
);
console.log(`  time: ${t1Time}s\n`);

console.log(`[Test 2] Cache hit with similar input`);
const t2Start = Date.now();
const c2 = await cachedRun(router.getRag(), INPUT_B, {
  minScore: 0.93,
  model: "qwen3.5:2b",
});
const t2Time = ((Date.now() - t2Start) / 1000).toFixed(1);

console.log(`  fromCache=${c2.fromCache}`);
console.log(`  time: ${t2Time}s\n`);

console.log(`[Test 3] RAG query with context`);
const rag = router.getRag();
await rag.addText(
  "O projeto memories usa SQLite criptografado com SQLCipher para proteger dados sensíveis.",
  { title: "About memories" },
);
const { answer, sources } = await rag.query(
  "Como o banco de dados é protegido?",
);
console.log(`  answer: ${answer.slice(0, 200)}...`);
console.log(`  sources: ${sources.length}`);

console.log("\n=== Done ===");
