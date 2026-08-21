import { RAG } from "../src/memories/rag.ts";

console.log("=== RAG Store Demo (via memories) ===\n");

const rag = await RAG.create({
  provider: "ollama",
  dbPath: "./data/rag-demo.db",
  embedModel: "nomic-embed-text",
  genModel: "qwen3.5:2b",
});

const docs = [
  "Deno is a secure runtime for JavaScript and TypeScript",
  "Ollama runs large language models locally on your machine",
  "SQLite is a lightweight embedded database engine",
  "Vector embeddings capture semantic meaning of text",
  "Semantic search finds similar content by meaning, not keywords",
];

console.log("Adding documents...");
for (const text of docs) {
  const id = await rag.addText(text, { title: text.split(" ")[0] });
  console.log(`  Added doc #${id}`);
}
console.log(`Total chunks: ${rag.chunkCount()}\n`);

console.log("--- Search: 'JavaScript runtime' ---");
const hits1 = await rag.search("JavaScript runtime", { k: 3 });
for (const hit of hits1) {
  console.log(`  [${hit.score.toFixed(3)}] ${hit.content}`);
}

console.log("\n--- Search: 'local AI models' ---");
const hits2 = await rag.search("local AI models", { k: 3 });
for (const hit of hits2) {
  console.log(`  [${hit.score.toFixed(3)}] ${hit.content}`);
}

console.log("\n--- RAG Query: 'What is Deno?' ---");
const { answer, sources } = await rag.query("What is Deno?");
console.log(`  Answer: ${answer}`);
console.log(`  Sources: ${sources.length}`);

console.log("\n--- Stats ---");
console.log(`  Documents: ${rag.documentCount()}`);
console.log(`  Chunks: ${rag.chunkCount()}`);

console.log("\nDone.");
