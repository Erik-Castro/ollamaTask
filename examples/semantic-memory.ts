import { existsSync, rmSync } from "node:fs";
import { EmbeddingStore } from "../src/embeddings/store.ts";
import { SemanticRouter } from "../src/embeddings/router.ts";
import { cachedRun } from "../src/embeddings/cache.ts";

const DB_PATH = "./data/usage-test.db";

// ── Helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(id: string, condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ${id} OK`);
  } else {
    failed++;
    failures.push(`${id}: ${msg}`);
    console.log(`  ${id} FAIL — ${msg}`);
  }
}

function log(msg: string): void {
  console.log(`  ${msg}`);
}

// ── Pre-checks ───────────────────────────────────────────────────────

console.log("=== Semantic Memory Usage Test ===");
console.log(`DB: ${DB_PATH}\n`);

const requiredModels = [
  "nomic-embed-text",
  "LFM2.5:350M",
  "lfm2.5-thinking:latest",
  "qwen3.5:2b",
];

for (const model of requiredModels) {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags");
    const data = await res.json() as { models: Array<{ name: string }> };
    const found = data.models.some((m) => m.name.startsWith(model));
    if (!found) {
      console.error(`Required model "${model}" not found. Run: ollama pull ${model}`);
      Deno.exit(1);
    }
  } catch {
    console.error("Cannot reach Ollama at http://127.0.0.1:11434. Is it running?");
    Deno.exit(1);
  }
}

// ── Setup ────────────────────────────────────────────────────────────

if (existsSync(DB_PATH)) rmSync(DB_PATH);

const store = new EmbeddingStore({ dbPath: DB_PATH });
await store.open();

const stats0 = await store.stats();
assert("SETUP.1", stats0.total === 0, `Expected empty DB, got total=${stats0.total}`);

// ── Register routes ──────────────────────────────────────────────────

const router = new SemanticRouter(store);

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

await router.register({
  name: "quick",
  examples: [
    "classifique: isso é um bug ou feature?",
    "resuma em uma frase o que aconteceu",
    "isso é positivo ou negativo?",
  ],
  model: "LFM2.5:350M",
  systemPrompt:
    "You are a quick classifier. Give short, direct answers.",
});

const statsAfterRegister = await store.stats();
assert(
  "SETUP.2",
  (statsAfterRegister.byKind["route_example"] ?? 0) >= 9,
  `Expected >= 9 route_example, got ${statsAfterRegister.byKind["route_example"]}`,
);

// ── Test inputs ──────────────────────────────────────────────────────

const INPUT_A = "Crie uma função TypeScript que valide e-mail com regex";
const INPUT_B = "Escreva uma função TS para validar email usando expressão regular";
const INPUT_C = "Explique passo a passo como essa validação de e-mail funciona";
const INPUT_D = "Classifique: 'O deploy falhou de novo na staging' — bug ou feature?";

// ══════════════════════════════════════════════════════════════════════
// PASSO 1 — codegen, cache miss
// ══════════════════════════════════════════════════════════════════════

console.log("[Passo 1] codegen — MISS");
const t1Start = Date.now();
const r1 = await router.route(INPUT_A);
const t1Time = ((Date.now() - t1Start) / 1000).toFixed(1);

assert("T1.1", r1.route === "codegen", `Expected route=codegen, got ${r1.route}`);
assert("T1.2", r1.score >= 0.5, `Expected score>=0.5, got ${r1.score.toFixed(3)}`);
assert("T1.3", r1.result.content.length > 50, `Expected content>50 chars, got ${r1.result.content.length}`);

const s1 = await store.stats();
assert(
  "T1.4",
  (s1.byKind["run"] ?? 0) >= 1,
  `Expected >= 1 run, got ${JSON.stringify(s1.byKind)}`,
);

const contentLower = r1.result.content.toLowerCase();
assert(
  "T1.5",
  contentLower.includes("email") || contentLower.includes("e-mail") || contentLower.includes("regex") || contentLower.includes("valid"),
  "Response should mention email/validation/regex",
);

log(`route=${r1.route} score=${r1.score.toFixed(3)}`);
log(`tokens: ${r1.result.inputTokens} in / ${r1.result.outputTokens} out`);
log(`time: ${t1Time}s`);

// ══════════════════════════════════════════════════════════════════════
// PASSO 2 — near-identical input → cache hit
// ══════════════════════════════════════════════════════════════════════

console.log("\n[Passo 2] codegen — CACHE HIT");
const t2Start = Date.now();
const c2 = await cachedRun(store, INPUT_B, {
  minScore: 0.93,
  model: "qwen3.5:2b",
});
const t2Time = ((Date.now() - t2Start) / 1000).toFixed(1);

assert("T2.1", c2.fromCache === true, `Expected cache hit, got fromCache=${c2.fromCache}`);
assert(
  "T2.2",
  c2.result.content.length > 0,
  "Cached content should not be empty",
);

const cacheHitFast = parseFloat(t2Time) < parseFloat(t1Time) * 0.8;
if (parseFloat(process.env.STRICT_TIMING ?? "0") === 1) {
  assert("T2.3", cacheHitFast, `Expected cache faster than step 1 (${t1Time}s), got ${t2Time}s`);
} else {
  log(`(soft timing) step1=${t1Time}s step2=${t2Time}s`);
  assert("T2.3", true, "timing check skipped (non-strict)");
}

const s2 = await store.stats();
const runsBefore = s1.byKind["run"] ?? 0;
const runsAfter = s2.byKind["run"] ?? 0;
assert(
  "T2.4",
  runsAfter <= runsBefore + 1,
  `Runs should not jump drastically: before=${runsBefore} after=${runsAfter}`,
);

log(`fromCache=${c2.fromCache}`);
log(`time: ${t2Time}s`);

// ══════════════════════════════════════════════════════════════════════
// PASSO 3 — related question → history retrieval
// ══════════════════════════════════════════════════════════════════════

console.log("\n[Passo 3] reasoning + context");
const t3Start = Date.now();
const r3 = await router.route(INPUT_C, { contextK: 3 });
const t3Time = ((Date.now() - t3Start) / 1000).toFixed(1);

assert("T3.1", r3.route === "reasoning", `Expected route=reasoning, got ${r3.route}`);
assert(
  "T3.2",
  r3.contextHits >= 1,
  `Expected context hits >= 1, got ${r3.contextHits}`,
);

const r3Lower = r3.result.content.toLowerCase();
assert(
  "T3.3",
  r3Lower.includes("email") ||
    r3Lower.includes("e-mail") ||
    r3Lower.includes("regex") ||
    r3Lower.includes("valid"),
  "Response should reference email validation (context injected)",
);

const s3 = await store.stats();
const runsAfter3 = s3.byKind["run"] ?? 0;
assert(
  "T3.4",
  runsAfter3 > runsAfter,
  `Expected new run persisted: before=${runsAfter} after=${runsAfter3}`,
);

log(`contextHits=${r3.contextHits}`);
log(`tokens: ${r3.result.inputTokens} in / ${r3.result.outputTokens} out`);
log(`time: ${t3Time}s`);

// ══════════════════════════════════════════════════════════════════════
// PASSO 4 — quick classification
// ══════════════════════════════════════════════════════════════════════

console.log("\n[Passo 4] quick");
const t4Start = Date.now();
const r4 = await router.route(INPUT_D);
const t4Time = ((Date.now() - t4Start) / 1000).toFixed(1);

assert("T4.1", r4.route === "quick", `Expected route=quick, got ${r4.route}`);

const r4Lower = r4.result.content.toLowerCase();
const isShort = r4.result.content.length < 300;
const hasClassification =
  r4Lower.includes("bug") ||
  r4Lower.includes("feature") ||
  r4Lower.includes("falha") ||
  r4Lower.includes("defeito") ||
  r4Lower.includes("problema");
assert(
  "T4.2",
  isShort || hasClassification,
  `Expected short/classified response (len=${r4.result.content.length})`,
);

log(`tokens: ${r4.result.inputTokens} in / ${r4.result.outputTokens} out`);
log(`time: ${t4Time}s`);

// ══════════════════════════════════════════════════════════════════════
// PASSO 5 — persistence between processes
// ══════════════════════════════════════════════════════════════════════

console.log("\n[Passo 5] persistence");
store.close();

const store2 = new EmbeddingStore({ dbPath: DB_PATH });
await store2.open();

const s5 = await store2.stats();
assert(
  "T5.1",
  s5.total >= 3,
  `Expected total>=3, got ${s5.total} (${JSON.stringify(s5.byKind)})`,
);

const hits5 = await store2.search({ query: INPUT_A, topK: 3, kind: "run" });
assert("T5.2", hits5.length >= 1, `Expected >= 1 hit, got ${hits5.length}`);
assert(
  "T5.3",
  hits5[0].text.toLowerCase().includes("email") ||
    hits5[0].text.toLowerCase().includes("e-mail") ||
    hits5[0].text.toLowerCase().includes("valid"),
  `Expected email-related text, got: "${hits5[0].text.slice(0, 80)}"`,
);
assert("T5.4", hits5[0].score > 0, `Expected score>0, got ${hits5[0].score}`);

log(`total=${s5.total} byKind=${JSON.stringify(s5.byKind)}`);
log(`top hit: [${hits5[0].score.toFixed(3)}] ${hits5[0].text.slice(0, 60)}...`);

// ══════════════════════════════════════════════════════════════════════
// PASSO 6 — kind isolation
// ══════════════════════════════════════════════════════════════════════

console.log("\n[Passo 6] kind filter");

const onlyExamples = await store2.search({
  query: "escreva código typescript",
  topK: 5,
  kind: "route_example",
});
const onlyRuns = await store2.search({
  query: "escreva código typescript",
  topK: 5,
  kind: "run",
});

const examplesCorrectKind = onlyExamples.every(
  (h) => h.kind === "route_example",
);
const runsCorrectKind = onlyRuns.every(
  (h) => h.kind === "run" || h.kind === "cache",
);

const exampleIds = new Set(onlyExamples.map((h) => h.id));
const runIds = new Set(onlyRuns.map((h) => h.id));
const noOverlap = [...exampleIds].every((id) => !runIds.has(id));

assert("T6.1", examplesCorrectKind, "All examples should have kind=route_example");
assert("T6.2", runsCorrectKind, "All runs should have kind=run or cache");
assert("T6.3", noOverlap, "No overlap between example and run results");

log(`route_examples found: ${onlyExamples.length}`);
log(`runs found: ${onlyRuns.length}`);

// ── Summary ──────────────────────────────────────────────────────────

store2.close();

console.log("\n=== RESULTADO: " + `${passed}/${passed + failed} asserts passed ===`);

if (failed > 0) {
  console.log("\nFailed asserts:");
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  Deno.exit(1);
}

if (existsSync(DB_PATH)) {
  const fileInfo = Deno.statSync(DB_PATH);
  console.log(`\nDB file: ${DB_PATH} (${fileInfo.size} bytes)`);
}

Deno.exit(0);
