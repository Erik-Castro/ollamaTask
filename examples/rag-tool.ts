import { ollamaTask } from "../src/ollamaTask.ts";
import { RAG } from "../src/memories/rag.ts";
import { RAGSearchTool } from "../src/tools/RAGSearch.ts";

console.log("=== RAG Agentic com ollamaTask ===\n");

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

const { definition, handler } = RAGSearchTool(rag, { k: 3 });

console.log("--- Pergunta com RAG agentic (tool calling) ---");
const result = await new ollamaTask("qwen3.5:2b")
  .system(
    "Você é um assistente útil. Use a tool rag_search para buscar informações antes de responder.",
  )
  .user("Como funciona o SQLite?")
  .tools([definition])
  .toolHandlers([handler])
  .onToolCall((name, args) => {
    console.log(`\n  🔧 Chamando: ${name}(${JSON.stringify(args)})`);
  })
  .onToolResult((_name, _args, result) => {
    console.log(`  📦 Resultado: ${JSON.stringify(result).slice(0, 100)}...`);
  })
  .onContent((chunk) => process.stdout.write(chunk))
  .maxIterations(5)
  .execute();

console.log(
  `\n\nTokens: ${result.inputTokens} in / ${result.outputTokens} out`,
);
console.log(`Tool calls: ${result.toolCalls.length}`);
