import { assertEquals, assertRejects } from "@std/assert";
import { EmbeddingStore } from "./store.ts";
import { SemanticRouter } from "./router.ts";

function createStore(): EmbeddingStore {
  return new EmbeddingStore({
    dbPath: ":memory:",
    useTaskPrefixes: false,
  });
}

Deno.test("SemanticRouter - register stores routes", async () => {
  const store = createStore();
  store.open();
  const router = new SemanticRouter(store);

  await router.register({
    name: "codegen",
    examples: ["write code", "generate function", "create module"],
    model: "test-model",
  });

  await router.register({
    name: "reasoning",
    examples: ["think step by step", "analyze this", "explain why"],
    model: "test-model",
  });

  const stats = store.stats();
  assertEquals(stats.byKind["route_example"], 6);

  store.close();
});

Deno.test("SemanticRouter - route throws when no routes registered", async () => {
  const store = createStore();
  store.open();
  const router = new SemanticRouter(store);

  await assertRejects(
    () => router.route("hello"),
    Error,
    "No routes registered",
  );

  store.close();
});

Deno.test("SemanticRouter - route throws when score below threshold", async () => {
  const store = createStore();
  store.open();
  const router = new SemanticRouter(store);

  await router.register({
    name: "codegen",
    examples: ["write code in python"],
    model: "test-model",
  });

  await assertRejects(
    () => router.route("quantum physics theory", { minScore: 0.99 }),
    Error,
    "No route matched above threshold",
  );

  store.close();
});

Deno.test("SemanticRouter - custom routeTopK overrides default", async () => {
  const store = createStore();
  store.open();
  const router = new SemanticRouter(store);

  await router.register({
    name: "route-a",
    examples: ["alpha", "beta", "gamma"],
    model: "m",
  });

  await router.register({
    name: "route-b",
    examples: ["delta", "epsilon", "zeta"],
    model: "m",
  });

  const stats = store.stats();
  assertEquals(stats.byKind["route_example"], 6);

  store.close();
});
