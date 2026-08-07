import { ollamaPipeline } from "../src/ollamaPipeline.ts";

const write = (c: string) => Deno.stdout.writeSync(new TextEncoder().encode(c));

const gray = (c: string) => write(`\x1b[90m${c}\x1b[0m`);

const results = await ollamaPipeline
  .create("Crie uma API REST com Deno + Hono para gerenciar tarefas")
  .stage({
    model: "LFM2.5:1.2b-thinking",
    system:
      "Refine o prompt do usuário. Seja claro, técnico e específico. Responda apenas com o prompt refinado.",
    onThinking: (c) => gray(c),
    onContent: (c) => write(c),
  })
  .then({
    model: "qwen3.5:0.8b",
    system:
      "Você é arquiteto de software. Gere um plano técnico detalhado em markdown (pastas, endpoints, modelos, deps). Não escreva código.",
    onThinking: (c) => gray(c),
    onContent: (c) => write(c),
  })
  .then({
    model: "qwen2.5-coder:latest",
    system:
      "Você é dev TypeScript sênior em Deno. Gere código completo e funcional.",
    transform: (prev, original) =>
      `Pedido original:\n${original}\n\nPlano técnico:\n${prev.content}\n\nGere o código.`,
    onContent: (c) => write(c),
  })
  .execute();

console.log("\n--- Pipeline finalizado ---");
for (let i = 0; i < results.length; i++) {
  console.log(
    `\nStage ${i + 1}: ${results[i].inputTokens} in / ${
      results[i].outputTokens
    } out`,
  );
}
console.log("Última saída:", results.at(-1)?.content.slice(0, 200), "...");
