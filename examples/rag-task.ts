import { ollamaTask } from "../src/ollamaTask.ts";
import { RAG } from "../src/memories/rag.ts";

console.log("=== RAG Passivo com ollamaTask ===\n");

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
  const id = await rag.addText(text, { title: text.split(" ")[0] });
  console.log(`  Doc #${id} indexado`);
}
console.log(`Total de chunks: ${rag.chunkCount()}\n`);

console.log("--- Pergunta com RAG passivo ---");
const result = await new ollamaTask("qwen3.5:2b")
  .rag({ rag, k: 3 })
  .system("Você é um assistente útil. Use o contexto fornecido para responder.")
  .user("O que é Deno?")
  .onContent((chunk) => process.stdout.write(chunk))
  .execute();

console.log(
  `\n\nTokens: ${result.inputTokens} in / ${result.outputTokens} out`,
);
