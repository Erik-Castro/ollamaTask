import { assertEquals, assertExists } from "@std/assert";
import { EmbeddingStore } from "./store.ts";

function createStore(): EmbeddingStore {
  return new EmbeddingStore({
    dbPath: ":memory:",
    useTaskPrefixes: false,
  });
}

Deno.test("EmbeddingStore - open creates schema", () => {
  const store = createStore();
  store.open();
  const stats = store.stats();
  assertEquals(stats.total, 0);
  store.close();
});

Deno.test("EmbeddingStore - add and getById", async () => {
  const store = createStore();
  store.open();

  const id = await store.add({
    text: "Hello world",
    kind: "run",
    metadata: { source: "test" },
  });

  assertExists(id);
  const doc = store.getById(id);
  assertExists(doc);
  assertEquals(doc.text, "Hello world");
  assertEquals(doc.kind, "run");
  assertEquals(doc.metadata.source, "test");

  store.close();
});

Deno.test("EmbeddingStore - delete removes document", async () => {
  const store = createStore();
  store.open();

  const id = await store.add({ text: "To delete", kind: "run" });
  const deleted = store.delete(id);
  assertEquals(deleted, true);

  const doc = store.getById(id);
  assertEquals(doc, null);

  store.close();
});

Deno.test("EmbeddingStore - stats counts by kind", async () => {
  const store = createStore();
  store.open();

  await store.add({ text: "run 1", kind: "run" });
  await store.add({ text: "run 2", kind: "run" });
  await store.add({ text: "cache 1", kind: "cache" });

  const stats = store.stats();
  assertEquals(stats.total, 3);
  assertEquals(stats.byKind["run"], 2);
  assertEquals(stats.byKind["cache"], 1);

  store.close();
});

Deno.test("EmbeddingStore - pruneCache removes old cache entries", async () => {
  const store = createStore();
  store.open();

  await store.add({ text: "keep this", kind: "run" });
  await store.add({ text: "cache entry", kind: "cache" });

  const pruned = store.pruneCache(0);
  assertEquals(pruned, 1);

  const stats = store.stats();
  assertEquals(stats.total, 1);
  assertEquals(stats.byKind["run"], 1);

  store.close();
});
