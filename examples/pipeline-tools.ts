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

const str = (v: unknown, fallback = ""): string =>
  v === undefined || v === null ? fallback : String(v);

const num = (v: unknown, fallback: number | null = null): number | undefined =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "")
    ? (fallback ?? undefined)
    : Number(v);

const splitArgs = (v: unknown): string[] =>
  str(v)
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

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

const tools: ToolDefinition[] = [
  tool("now", "Current timestamp (ISO, unix, timezone).", {}),
  tool(
    "calculate",
    "Evaluate a math expression reliably (+ - * / % ^, parens, pi/e/tau, sqrt abs round floor ceil log ln min max).",
    { expression: { type: "string" } },
    ["expression"],
  ),
  tool("list_dir", "List entries of a directory (name + kind), dirs first.", {
    path: { type: "string" },
  }),
  tool("file_read", "Read a text file ({ path, content, truncated }).", {
    path: { type: "string" },
    maxChars: { type: "integer" },
  }, ["path"]),
  tool("file_write", "Create/overwrite a text file ({ path, bytesWritten }).", {
    path: { type: "string" },
    content: { type: "string" },
  }, ["path", "content"]),
  tool(
    "code_search",
    "Regex search over the codebase ({ backend, matches: file:line:snippet }).",
    {
      pattern: { type: "string" },
      include: { type: "string", description: "comma-separated extensions" },
      limit: { type: "integer" },
    },
    ["pattern"],
  ),
  tool("which", "Check a binary exists on PATH ({ binary, exists, path }).", {
    binary: { type: "string" },
  }, ["binary"]),
  tool(
    "run_command",
    "Run a whitelisted shell command with an args array ({ code, stdout, stderr }).",
    {
      command: { type: "string" },
      args: { type: "string", description: "space-separated arguments" },
    },
    ["command"],
  ),
  tool("web_search", "DuckDuckGo search ({ query?, results[] }).", {
    query: { type: "string" },
  }, ["query"]),
  tool("web_fetch", "Fetch a page ({ url, title, text }).", {
    url: { type: "string" },
  }, ["url"]),
  tool("state_get", "Read a key from the persistent K-V store.", {
    key: { type: "string" },
  }, ["key"]),
  tool("state_set", "Persist a value under a key in the K-V store.", {
    key: { type: "string" },
    value: { type: "string" },
  }, ["key", "value"]),
  tool("state_delete", "Delete a key from the K-V store.", {
    key: { type: "string" },
  }, ["key"]),
  tool("state_list", "List all keys in the K-V store.", {}),
];

const handlers: ToolHandler[] = [
  { name: "now", execute: () => Now() },
  {
    name: "calculate",
    execute: (a: ToolArgs) => Calculator(str(a.expression)),
  },
  { name: "list_dir", execute: (a: ToolArgs) => ListDir(str(a.path, ".")) },
  {
    name: "file_read",
    execute: (a: ToolArgs) =>
      FileRead(str(a.path), { maxChars: num(a.maxChars) }),
  },
  {
    name: "file_write",
    execute: (a: ToolArgs) => FileWrite(str(a.path), str(a.content)),
  },
  {
    name: "code_search",
    execute: (a: ToolArgs) =>
      CodeSearch(str(a.pattern), {
        include: str(a.include)
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean),
        limit: num(a.limit, 20),
      }),
  },
  { name: "which", execute: (a: ToolArgs) => Which(str(a.binary)) },
  {
    name: "run_command",
    execute: (a: ToolArgs) => RunCommand(str(a.command), splitArgs(a.args)),
  },
  { name: "web_search", execute: (a: ToolArgs) => WebSearch(str(a.query)) },
  { name: "web_fetch", execute: (a: ToolArgs) => WebFetch(str(a.url)) },
  { name: "state_get", execute: (a: ToolArgs) => StateStoreGet(str(a.key)) },
  {
    name: "state_set",
    execute: (a: ToolArgs) => StateStoreSet(str(a.key), a.value),
  },
  {
    name: "state_delete",
    execute: (a: ToolArgs) => StateStoreDelete(str(a.key)),
  },
  { name: "state_list", execute: () => StateStoreList() },
];

const safe = (
  execute: (args: ToolArgs) => unknown | Promise<unknown>,
): ToolHandler["execute"] =>
async (args: ToolArgs) => {
  try {
    return await execute(args);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const safeHandlers: ToolHandler[] = handlers.map((h) => ({
  name: h.name,
  execute: safe(h.execute),
}));

const writeChunk = (c: string) =>
  Deno.stdout.writeSync(new TextEncoder().encode(c));
const gray = (c: string) => writeChunk(`\x1b[90m${c}\x1b[0m`);

let totalCalls = 0;
const onToolCall = (name: string, args: ToolArgs) => {
  totalCalls++;
  console.log(`\n🔧 [${totalCalls}] ${name}(${JSON.stringify(args)})`);
};
const onToolResult = (name: string, _args: ToolArgs, result: unknown) => {
  const json = JSON.stringify(result);
  console.log(
    `📦 ${name} → ${json.length > 200 ? json.slice(0, 200) + "…" : json}`,
  );
};

const sliced = (names: string[]): ToolDefinition[] =>
  tools.filter((t) => names.includes(t.function.name));

try {
  const results = await ollamaPipeline
    .create(
      "Analise este repositório: descubra a estrutura de src/tools/, quantas ferramentas existem e quantos arquivos .ts há no total. Salve o relatório final no StateStore (chave 'report') e escreva uma cópia em data/report.md.",
    )
    .stage({
      model: "qwen3.5:0.8b",
      system:
        "Você é eficiente. Chame list_dir com path 'src/tools'. Depois chame now. Monte um JSON com as chaves: layout (resultado do list_dir), quando (resultado do now), totalDeArquivos (número de entries do list_dir). Responda apenas com o JSON final.",
      tools: sliced([
        "list_dir",
        "now",
        "calculate",
        "state_get",
        "state_set",
        "state_list",
      ]),
      toolHandlers: safeHandlers,
      maxIterations: 3,
      onThinking: (c) => gray(c),
      onToolCall,
      onToolResult,
    })
    .then({
      model: "qwen3.5:2b",
      system:
        "Você é analista. Use code_search com pattern='export const', include='ts,tsx', no código. Use which para os binários, file_read para confirmar snippets. args de run_command: 'args' space-separated. Salve a contagem em state_set key='countTools'. Responda apenas com análise JSON.",
      transform: (prev) =>
        `Resumo da 1ª etapa:\n${prev.content}\n\nAgora faça a análise dos arquivos de src/tools/ e conte ferramentas export com code_search.`,
      tools: sliced([
        "code_search",
        "file_read",
        "which",
        "run_command",
        "state_get",
        "state_set",
        "file_write",
      ]),
      toolHandlers: safeHandlers,
      maxIterations: 3,
      onToolCall,
      onToolResult,
    })
    .then({
      model: "qwen3.5:0.8b",
      system:
        "Você é pesquisador. Use web_search com query curta. Salve um resumo em state_set 'web_note'. Use state_get/state_list para conferir. Responda JSON com keys: nota, resumo.",
      transform: (prev) =>
        `Etapa 2 (código):\n${prev.content}\n\nAgora faça uma checagem web breve.`,
      tools: sliced([
        "web_search",
        "web_fetch",
        "state_get",
        "state_set",
        "state_delete",
        "state_list",
      ]),
      toolHandlers: safeHandlers,
      maxIterations: 3,
      onToolCall,
      onToolResult,
    })
    .then({
      model: "qwen3.5:0.8b",
      system:
        "Você recebe os dados na mensagem. Use state_set com key='report', value=normalize-resumo JSON {ferramentas, arquivos, fontes, nota}. Responda apenas um JSON com a chave 'gravado' true.",
      transform: (prev) =>
        `Dados coletados (JSON): ${prev.content}\n\nGrave o resumo no state com state_set key='report' e responda o JSON final.`,
      tools: sliced([
        "calculate",
        "state_get",
        "state_set",
        "file_write",
        "run_command",
      ]),
      toolHandlers: safeHandlers,
      maxIterations: 3,
      onToolCall,
      onToolResult,
    })
    .execute();

  console.log("\n\n--- Pipeline finalizado ---");
  for (let i = 0; i < results.length; i++) {
    console.log(
      `Stage ${i + 1}: ${results[i].inputTokens} in / ${
        results[i].outputTokens
      } out, ` +
        `${results[i].toolCalls.length} tool calls`,
    );
  }
  console.log(`\nTool calls no total: ${totalCalls}`);

  const final = results.at(-1)!;
  console.log("\n--- Relatório final (stage 4) ---");
  console.log(final.content);

  const state = await StateStoreList();
  console.log("\n--- StateStore keys ---", JSON.stringify(state));
  const report = await StateStoreGet("report");
  console.log("report:", JSON.stringify(report.value)?.slice(0, 300));
} catch (error) {
  console.error("\nPipeline falhou:", error);
  Deno.exit(1);
}
