import { ollamaPipeline } from "../src/ollamaPipeline.ts";
import { RAG } from "../src/memories/rag.ts";

console.log("=== RAG com ollamaPipeline ===\n");

const rag = await RAG.create({
  provider: "ollama",
  dbPath: "./data/rag-demo.db",
  embedModel: "nomic-embed-text",
  genModel: "qwen3.5:2b",
});

await rag.ensureModel((status) => console.log(`  [ollama] ${status}`));

const docs = [
  "Deno é um runtime seguro para JavaScript e TypeScript criado por Ryan Dahl.",
  "Ollama roda modelos de linguagem localmente na sua máquina.",
  "SQLite é um banco de dados leve e embutido.",
  "Embeddings vetoriais capturam o significado semântico do texto.",
  "Busca semântica encontra conteúdo similar por significado, não por palavras-chave.",
];

console.log("Indexando documentos...");
for (const text of docs) {
  await rag.addText(text, { title: text.split(" ")[0] });
}
console.log(`Total de chunks: ${rag.chunkCount()}\n`);

console.log("--- Pipeline com RAG stage ---");
const results = await ollamaPipeline
  .create("Explique como o Deno funciona")
  .ragStage({
    model: "qwen3.5:2b",
    rag,
    k: 3,
    system: "Analise o contexto encontrado e prepare uma resposta.",
    onContent: (c) => process.stdout.write(c),
  })
  .then({
    model: "qwen3.5:2b",
    system: "Gere uma resposta técnica completa e bem estruturada.",
    onContent: (c) => process.stdout.write(c),
  })
  .execute();

console.log(`\n\nEstágios executados: ${results.length}`);
for (const [i, r] of results.entries()) {
  console.log(
    `  Estágio ${i + 1}: ${r.inputTokens} in / ${r.outputTokens} out`,
  );
}
