/**
 * Exemplo testável: gera um contrato de prestação de serviço (fictício)
 * usando ollamaPipeline + todas as tools do src/tools/.
 *
 * deno run --allow-net --allow-read --allow-write --allow-run \
 *   examples/contract-pipeline.ts
 */
import { ollamaPipeline } from "../src/ollamaPipeline.ts";
import type {
  ToolArgs,
  ToolDefinition,
  ToolHandler,
} from "../src/ollamaTask.ts";
import { Now } from "../src/tools/Now.ts";
import { Calculator } from "../src/tools/Calculator.ts";
import { ListDir } from "../src/tools/ListDir.ts";
import { FileRead } from "../src/tools/FileRead.ts";
import { FileWrite } from "../src/tools/FileWrite.ts";
import { CodeSearch } from "../src/tools/CodeSearch.ts";
import { Which } from "../src/tools/Which.ts";
import { RunCommand } from "../src/tools/RunCommand.ts";
import { WebSearch } from "../src/tools/WebSearch.ts";
import { WebFetch } from "../src/tools/WebFetch.ts";
import {
  StateStoreDelete,
  StateStoreGet,
  StateStoreList,
  StateStoreSet,
} from "../src/tools/StateStore.ts";

// ── helpers ──────────────────────────────────────────────
const str = (v: unknown, fb = "") =>
  v === undefined || v === null ? fb : String(v);
const num = (v: unknown, fb: number | null = null) =>
  v === undefined || v === null || (typeof v === "string" && !String(v).trim())
    ? (fb ?? undefined)
    : Number(v);
const splitArgs = (v: unknown) =>
  str(v).split(/\s+/).map((p) => p.trim()).filter(Boolean);

const write = (token: string) =>
  Deno.stdout.writeSync(new TextEncoder().encode(token));
const gray = (token: string) => write(`\x1b[90m${token}\x1b[0m`);

const tool = (
  name: string,
  description: string,
  properties: Record<string, { type: string; description?: string }>,
  required: string[] = [],
): ToolDefinition => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required },
  },
});

const ALL_TOOLS: ToolDefinition[] = [
  tool("now", "Data/hora atual (ISO, unix, timezone).", {}),
  tool("calculate", "Avalia expressão matemática segura.", {
    expression: { type: "string" },
  }, ["expression"]),
  tool("list_dir", "Lista entradas de um diretório.", {
    path: { type: "string" },
  }),
  tool("file_read", "Lê arquivo de texto (offset em bytes + maxChars).", {
    path: { type: "string" },
    maxChars: { type: "integer" },
    offset: { type: "integer" },
  }, ["path"]),
  tool("file_write", "Cria/sobrescreve arquivo de texto.", {
    path: { type: "string" },
    content: { type: "string" },
  }, ["path", "content"]),
  tool("code_search", "Busca regex no código.", {
    pattern: { type: "string" },
    include: { type: "string" },
    limit: { type: "integer" },
  }, ["pattern"]),
  tool("which", "Verifica se binário existe no PATH.", {
    binary: { type: "string" },
  }, ["binary"]),
  tool(
    "run_command",
    "Roda comando da whitelist (args separados por espaço).",
    {
      command: { type: "string" },
      args: { type: "string" },
    },
    ["command"],
  ),
  tool("web_search", "Busca no DuckDuckGo.", {
    query: { type: "string" },
  }, ["query"]),
  tool("web_fetch", "Baixa e extrai texto de uma URL.", {
    url: { type: "string" },
  }, ["url"]),
  tool("state_get", "Lê chave do StateStore.", { key: { type: "string" } }, [
    "key",
  ]),
  tool("state_set", "Grava chave no StateStore.", {
    key: { type: "string" },
    value: { type: "string" },
  }, ["key", "value"]),
  tool("state_delete", "Remove chave do StateStore.", {
    key: { type: "string" },
  }, ["key"]),
  tool("state_list", "Lista chaves do StateStore.", {}),
];

const handlers: ToolHandler[] = [
  { name: "now", execute: () => Now() },
  { name: "calculate", execute: (a) => Calculator(str(a.expression)) },
  { name: "list_dir", execute: (a) => ListDir(str(a.path, ".")) },
  {
    name: "file_read",
    execute: (a) =>
      FileRead(str(a.path), {
        maxChars: num(a.maxChars) ?? 2000,
        offset: num(a.offset) ?? 0,
      }),
  },
  {
    name: "file_write",
    execute: (a) => FileWrite(str(a.path), str(a.content)),
  },
  {
    name: "code_search",
    execute: (a) =>
      CodeSearch(str(a.pattern), {
        include: str(a.include).split(",").map((e) => e.trim()).filter(Boolean),
        limit: num(a.limit, 20),
      }),
  },
  { name: "which", execute: (a) => Which(str(a.binary)) },
  {
    name: "run_command",
    execute: (a) => RunCommand(str(a.command), splitArgs(a.args)),
  },
  { name: "web_search", execute: (a) => WebSearch(str(a.query)) },
  { name: "web_fetch", execute: (a) => WebFetch(str(a.url)) },
  { name: "state_get", execute: (a) => StateStoreGet(str(a.key)) },
  {
    name: "state_set",
    execute: (a) => StateStoreSet(str(a.key), a.value),
  },
  { name: "state_delete", execute: (a) => StateStoreDelete(str(a.key)) },
  { name: "state_list", execute: () => StateStoreList() },
];

const safeHandlers: ToolHandler[] = handlers.map((h) => ({
  name: h.name,
  execute: async (args: ToolArgs) => {
    try {
      return await h.execute(args);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
}));

const pick = (...names: string[]) =>
  ALL_TOOLS.filter((t) => names.includes(t.function.name));

const used = new Set<string>();
const onToolCall = (name: string, args: ToolArgs) => {
  used.add(name);
  console.log(`\n🔧 ${name}(${JSON.stringify(args)})`);
};
const onToolResult = (name: string, _a: ToolArgs, result: unknown) => {
  const j = JSON.stringify(result);
  console.log(`📦 ${name} → ${j.length > 180 ? j.slice(0, 180) + "…" : j}`);
};

const OUT = "data/contracts/servico-cloud-2026.md";

// ── pipeline ─────────────────────────────────────────────
const BRIEF = `
Gere um CONTRATO DE PRESTAÇÃO DE SERVIÇOS (documento de teste, fictício).

Partes:
- CONTRATANTE: Acme Analytics Ltda. (CNPJ 12.345.678/0001-90)
- CONTRATADA: Nimbus Cloud Services ME (CNPJ 98.765.432/0001-10)

Objeto: hospedagem e monitoramento de API (plano Pro).
Mensalidade base: R$ 1.200,00
Desconto fidelidade 12 meses: 10%
Prazo: 12 meses a partir da data de assinatura.
Jurisdição: São Paulo/SP.

O arquivo final deve ser markdown em ${OUT}.
`;

await Deno.mkdir("data/contracts", { recursive: true });

const results = await ollamaPipeline
  .create(BRIEF)
  .stage({
    // 1) Ambiente + data
    model: "qwen3.5:0.8b",
    system: `Você prepara o contexto do contrato.
1) Chame now.
2) Chame list_dir path="data".
3) Chame which binary="git".
4) Chame run_command command="pwd" (sem args) ou command="date".
5) state_set key="tmp_scratch" value="contexto-ok".
6) state_set key="contract_meta" com um JSON string: {generatedAt, cwdHint, hasGit}.
Responda só um JSON curto confirmando o que fez.`,
    tools: pick(
      "now",
      "list_dir",
      "which",
      "run_command",
      "state_set",
      "state_get",
    ),
    toolHandlers: safeHandlers,
    format: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        cwdHint: { type: "string" },
        hasGit: { type: "boolean" },
        generatedAt: { type: "string" },
      },
      required: ["ok"],
    },
    maxIterations: 6,
    onContent: write,
    onThinking: gray,
    onToolCall,
    onToolResult,
  })
  .then({
    // 2) Pesquisa web (cláusulas típicas)
    model: "qwen3.5:2b",
    system: `Você pesquisa cláusulas usuais de contrato de hospedagem/SaaS.
1) web_search query curta em português (ex: "cláusulas contrato prestação serviços TI").
2) Se houver um bom link, web_fetch nele.
3) state_set key="research_notes" com 3–5 bullets de cláusulas típicas (rescisão, SLA, confidencialidade, foro).
Responda só um resumo curto.`,
    transform: (prev) =>
      `Contexto stage1:\n${prev.content}\n\nFaça a pesquisa de cláusulas.`,
    tools: pick("web_search", "web_fetch", "state_set", "state_get"),
    toolHandlers: safeHandlers,
    maxIterations: 5,
    onContent: write,
    onThinking: gray,
    onToolCall,
    onToolResult,
  })
  .then({
    // 3) Cálculo financeiro
    model: "qwen3.5:2b",
    system: `Você calcula valores do contrato.
Mensalidade 1200, desconto 10%, prazo 12 meses.
1) calculate expression="1200 * 0.9"  → mensalidade líquida
2) calculate expression="1200 * 0.9 * 12" → total no período
3) state_get key="contract_meta"
4) state_set key="contract_values" value=JSON {monthlyNet, totalPeriod, currency:"BRL"}
Responda só o JSON dos valores.`,
    transform: (prev) =>
      `Pesquisa:\n${prev.content}\n\nCalcule os valores do contrato.`,
    tools: pick("calculate", "state_get", "state_set"),
    toolHandlers: safeHandlers,
    format: {
      type: "object",
      properties: {
        monthlyNet: { type: "number" },
        totalPeriod: { type: "number" },
        currency: { type: "string" },
      },
      required: ["monthlyNet", "totalPeriod", "currency"],
    },
    maxIterations: 5,
    onContent: write,
    onThinking: gray,
    onToolCall,
    onToolResult,
  })
  .then({
    // 4) Redação + gravação
    model: "gpt-oss:20b-cloud",
    system: `Você redige o contrato em Markdown e grava no disco.
1) state_get contract_meta, contract_values, research_notes
2) Monte o contrato completo (título, partes, objeto, valores, prazo, obrigações, rescisão, foro, data).
3) file_write path="${OUT}" content=<markdown completo>
4) file_read path="${OUT}" maxChars=500 para conferir
5) code_search pattern="CONTRATO" include="md" limit=5 (opcional, no workspace)
6) state_set key="contract_body" value=<primeiros 500 chars ou path>
Responda JSON {path, bytesHint, ok:true}.`,
    transform: (prev) =>
      `Valores:\n${prev.content}\n\nRedija e grave o contrato em ${OUT}.`,
    tools: pick(
      "state_get",
      "state_list",
      "file_write",
      "file_read",
      "code_search",
      "state_set",
    ),
    toolHandlers: safeHandlers,
    format: {
      type: "object",
      properties: {
        path: { type: "string" },
        bytesHint: { type: "number" },
        ok: { type: "boolean" },
      },
      required: ["path", "ok"],
    },
    maxIterations: 6,
    onContent: write,
    onThinking: gray,
    onToolCall,
    onToolResult,
  })
  .then({
    // 5) Limpeza + checklist
    model: "qwen3.5:0.8b",
    system: `Finalize.
1) state_delete key="tmp_scratch"
2) state_list
3) file_read path="${OUT}" maxChars=300
Responda JSON {cleaned:true, keysRestantes, previewOk:true/false}.`,
    transform: (prev) =>
      `Stage anterior:\n${prev.content}\n\nLimpe tmp_scratch e confirme o arquivo.`,
    tools: pick("state_delete", "state_list", "state_get", "file_read"),
    toolHandlers: safeHandlers,
    format: {
      type: "object",
      properties: {
        cleaned: { type: "boolean" },
        keysRemaining: { type: "integer" },
        previewOk: { type: "boolean" },
      },
      required: ["cleaned", "previewOk"],
    },
    maxIterations: 4,
    onContent: write,
    onThinking: gray,
    onToolCall,
    onToolResult,
  })
  .execute();

// ── asserts (parte testável) ─────────────────────────────
const REQUIRED_TOOLS = [
  "now",
  "calculate",
  "list_dir",
  "file_read",
  "file_write",
  "code_search",
  "which",
  "run_command",
  "web_search",
  "web_fetch",
  "state_get",
  "state_set",
  "state_delete",
  "state_list",
];

let failed = 0;
const assert = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
};

console.log("\n=== Asserts ===");

const fileExists = await Deno.stat(OUT).then(() => true).catch(() => false);
assert("T1 arquivo do contrato existe", fileExists, OUT);

if (fileExists) {
  const body = await Deno.readTextFile(OUT);
  assert("T2 contrato não vazio", body.trim().length > 200);
  assert("T3 menciona CONTRATANTE ou Acme", /acme|contratante/i.test(body));
  assert(
    "T4 menciona valor ou 1200|mensalidade",
    /1200|mensalidade|r\$/i.test(body),
  );
}

const meta = await StateStoreGet("contract_meta");
const values = await StateStoreGet("contract_values");
const tmp = await StateStoreGet("tmp_scratch");
const list = await StateStoreList();

assert("T5 state contract_meta", meta.value != null);
assert("T6 state contract_values", values.value != null);
assert("T7 tmp_scratch removido", tmp.value == null);
assert("T8 state_list tem chaves", list.count >= 1);

const missing = REQUIRED_TOOLS.filter((t) => !used.has(t));
assert(
  "T9 todas as tools foram chamadas ao menos 1x",
  missing.length === 0,
  missing.length ? `faltou: ${missing.join(", ")}` : "",
);

console.log("\nTools usadas:", [...used].sort().join(", "));
console.log(
  "Stages:",
  results.map((r, i) =>
    `#${
      i + 1
    } ${r.inputTokens}/${r.outputTokens} tok, ${r.toolCalls.length} calls`
  ).join(" | "),
);

if (failed) {
  console.error(`\nFALHOU: ${failed} assert(s)`);
  Deno.exit(1);
}
console.log("\nOK — contrato gerado e asserts passaram.");
