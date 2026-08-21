import { openDatabase } from "../src/memories/database.ts";
import { type EmbeddedChunk, VectorStore } from "../src/memories/store.ts";
import { assert, assertEquals } from "@std/assert";

function makeVec(...values: number[]): number[] {
  return values;
}

Deno.test("VectorStore insert and search", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const db = await openDatabase({
      path: `${dir}/test.db`,
      keyPath: `${dir}/.key`,
      vectorExtensionPath: "./bin/vector.so",
    });

    using _dbRef = db;
    const store = new VectorStore(db);
    const docId = store.addDocument("test.md", "Teste");
    assert(docId > 0);

    const _dims = 4;
    const chunks: EmbeddedChunk[] = [
      { index: 0, content: "chunk alpha", embedding: makeVec(1, 0, 0, 0) },
      { index: 1, content: "chunk beta", embedding: makeVec(0, 1, 0, 0) },
      { index: 2, content: "chunk gamma", embedding: makeVec(0, 0, 1, 0) },
    ];
    store.addChunks(docId, chunks);
    assertEquals(store.chunkCount(), 3);
    assertEquals(store.documentCount(), 1);

    const results = store.search(makeVec(0.9, 0.1, 0, 0), 2);
    assertEquals(results.length, 2);
    assertEquals(results[0].content, "chunk alpha");
    assert(
      results[0].distance < results[1].distance,
      "Resultados deveriam estar ordenados por distância",
    );
    assert(
      results[0].score > results[1].score,
      "Scores deveriam ser decrescentes",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("VectorStore search works across reconnections", async () => {
  const dir = await Deno.makeTempDir();
  try {
    {
      const db = await openDatabase({
        path: `${dir}/test.db`,
        keyPath: `${dir}/.key`,
        vectorExtensionPath: "./bin/vector.so",
      });
      using _dbRef = db;
      const store = new VectorStore(db);
      const docId = store.addDocument(null, null);
      store.addChunks(docId, [
        { index: 0, content: "persistente", embedding: makeVec(1, 0, 0) },
      ]);
    }

    {
      const db = await openDatabase({
        path: `${dir}/test.db`,
        keyPath: `${dir}/.key`,
        vectorExtensionPath: "./bin/vector.so",
      });
      using _dbRef = db;
      const store = new VectorStore(db);
      const results = store.search(makeVec(1, 0, 0), 1);
      assertEquals(results.length, 1);
      assertEquals(results[0].content, "persistente");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("VectorStore handles empty search gracefully", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const db = await openDatabase({
      path: `${dir}/test.db`,
      keyPath: `${dir}/.key`,
      vectorExtensionPath: "./bin/vector.so",
    });
    using _dbRef = db;
    const store = new VectorStore(db);
    store.addDocument("empty.md", "Vazio");
    const results = store.search(makeVec(1, 0, 0), 5);
    assertEquals(results.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
