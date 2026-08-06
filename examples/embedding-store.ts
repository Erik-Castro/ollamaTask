import { EmbeddingStore } from "../src/embeddings/store.ts";

const store = new EmbeddingStore({
  dbPath: "./data/memory.db",
  embeddingModel: "nomic-embed-text",
  dimensions: 768,
});

await store.open();
console.log("EmbeddingStore opened.\n");

// --- Add documents ---
const docs = [
  "Deno is a secure runtime for JavaScript and TypeScript",
  "Ollama runs large language models locally on your machine",
  "SQLite is a lightweight embedded database engine",
  "Vector embeddings capture semantic meaning of text",
  "Semantic search finds similar content by meaning, not keywords",
];

console.log("Adding documents...");
const ids = await store.addBatch(
  docs.map((text) => ({ text, kind: "run" as const })),
);
console.log(`  Added ${ids.length} documents.\n`);

// --- Add a cache entry ---
const cacheId = await store.add({
  text: "What is Deno?",
  kind: "cache",
  metadata: {
    fullOutput: "Deno is a secure runtime for JavaScript and TypeScript.",
  },
});
console.log(`  Cache entry added: ${cacheId}\n`);

// --- Stats ---
const stats = await store.stats();
console.log("Stats:", stats);

// --- Semantic search ---
console.log("\n--- Search: 'JavaScript runtime' ---");
let hits = await store.search({ query: "JavaScript runtime", topK: 3 });
for (const hit of hits) {
  console.log(`  [${hit.score.toFixed(3)}] ${hit.text}`);
}

console.log("\n--- Search: 'local AI models' ---");
hits = await store.search({ query: "local AI models", topK: 3 });
for (const hit of hits) {
  console.log(`  [${hit.score.toFixed(3)}] ${hit.text}`);
}

console.log("\n--- Search: 'What is Deno?' (cache lookup, minScore=0.90) ---");
hits = await store.search({
  query: "What is Deno?",
  kind: "cache",
  topK: 1,
  minScore: 0.9,
});
if (hits.length > 0) {
  console.log(`  Cache hit! score=${hits[0].score.toFixed(3)}`);
  console.log(`  Output: ${hits[0].metadata.fullOutput}`);
} else {
  console.log("  Cache miss.");
}

// --- Filter by kind ---
console.log("\n--- Search: 'database' (kind=run only) ---");
hits = await store.search({ query: "database", kind: "run", topK: 2 });
for (const hit of hits) {
  console.log(`  [${hit.score.toFixed(3)}] ${hit.text}`);
}

// --- GetById ---
console.log("\n--- GetById ---");
const doc = await store.getById(ids[0]);
console.log(`  Found: ${doc?.text}`);

// --- Delete ---
console.log("\n--- Delete ---");
const deleted = await store.delete(ids[0]);
console.log(`  Deleted: ${deleted}`);

// --- Prune cache ---
console.log("\n--- Prune cache (older than 1 hour) ---");
const pruned = await store.pruneCache(60 * 60 * 1000);
console.log(`  Pruned: ${pruned} entries`);

// --- Final stats ---
const finalStats = await store.stats();
console.log("\nFinal stats:", finalStats);

store.close();
console.log("\nDone.");
