#!/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * news-digest.ts
 *
 * Pipeline de notícias recentes → Markdown limpo para glow
 *
 * Fluxo:
 *   1. Planejamento de consultas
 *   2. Recuperação de manchetes (web_search)
 *   3. Curadoria e ranking
 *   4. Enriquecimento (web_fetch nas top stories)
 *   5. Redação do digest
 *   6. Gravação
 *
 * Uso:
 *   ./news-digest.ts
 *   ./news-digest.ts "tecnologia"
 *   glow $(ls -t data/news/*.md | head -1)
 */

import { ollamaPipeline } from "../src/ollamaPipeline.ts";
import type {
  ToolArgs,
  ToolDefinition,
  ToolHandler,
} from "../src/ollamaTask.ts";
import { Now } from "../src/tools/Now.ts";
import { WebSearch } from "../src/tools/WebSearch.ts";
import { WebFetch } from "../src/tools/WebFetch.ts";
import { FileWrite } from "../src/tools/FileWrite.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const str = (v: unknown, fb = ""): string =>
  v === undefined || v === null ? fb : String(v);

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

// ── Tool definitions ─────────────────────────────────────────────────────────

const ALL_TOOLS: ToolDefinition[] = [
  tool(
    "now",
    "Data/hora atual: { iso, unix, timezone, utcOffsetMinutes }.",
    {},
  ),
  tool(
    "web_search",
    "Busca na web via DuckDuckGo. Retorna { results: [{ title, snippet, link }] }.",
    {
      query: { type: "string", description: "Termo de busca" },
      timeRange: {
        type: "string",
        description: "Filtro temporal: d (dia), w (semana), m (mês)",
      },
    },
    ["query"],
  ),
  tool(
    "web_fetch",
    "Baixa conteúdo de uma URL. Retorna { url, title, text }.",
    {
      url: { type: "string" },
      maxChars: { type: "integer" },
    },
    ["url"],
  ),
  tool(
    "file_write",
    "Escreve conteúdo em arquivo local.",
    {
      path: { type: "string" },
      content: { type: "string" },
    },
    ["path", "content"],
  ),
];

// ── Handlers ─────────────────────────────────────────────────────────────────

const handlers: ToolHandler[] = [
  { name: "now", execute: () => Now() },
  {
    name: "web_search",
    execute: async (a) => {
      const result = await WebSearch(str(a.query), {
        timeRange: str(a.timeRange) as "d" | "w" | "m" | undefined,
      });
      return { results: result.results };
    },
  },
  {
    name: "web_fetch",
    execute: (a) =>
      WebFetch(str(a.url), {
        maxChars: typeof a.maxChars === "number" ? a.maxChars : 4000,
      }),
  },
  {
    name: "file_write",
    execute: (a) => FileWrite(str(a.path), str(a.content)),
  },
];

const safeHandlers: ToolHandler[] = handlers.map((h) => ({
  name: h.name,
  execute: async (args: ToolArgs) => {
    try {
      return await h.execute(args);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
}));

// ── Pick helpers ─────────────────────────────────────────────────────────────

const pick = (...names: string[]) =>
  ALL_TOOLS.filter((t) => names.includes(t.function.name));

// ── CLI ──────────────────────────────────────────────────────────────────────

const topic = Deno.args[0]?.trim() || "notícias recentes do mundo";

const OUT_DIR = "data/news";
await Deno.mkdir(OUT_DIR, { recursive: true });
const OUTPUT_FILE = `${OUT_DIR}/digest-${Date.now()}.md`;

// ── Console helpers ──────────────────────────────────────────────────────────

let totalToolCalls = 0;
const encoder = new TextEncoder();
const writeChunk = (chunk: string) =>
  Deno.stdout.writeSync(encoder.encode(chunk));
const gray = (chunk: string) => writeChunk(`\x1b[90m${chunk}\x1b[0m`);

const onToolCall = (name: string, args: ToolArgs) => {
  totalToolCalls++;
  console.log(`🔧 [${totalToolCalls}] ${name}(${JSON.stringify(args)})`);
};

const onToolResult = (name: string, _args: ToolArgs, result: unknown) => {
  const json = JSON.stringify(result);
  console.log(
    `📦 ${name} → ${json.length > 200 ? json.slice(0, 200) + "…" : json}`,
  );
};

// ── Pipeline ─────────────────────────────────────────────────────────────────

const results = await ollamaPipeline
  .create(topic)
  // ============================================================
  // 1. PLANEJAMENTO DE CONSULTAS
  // ============================================================
  .stage({
    model: "qwen3.5:2b",
    system: `Você é o planejador de um digest de notícias.

TÓPICO: "${topic}"

DATA/HORA ATUAL: use a tool "now" para obter.

OBJETIVO
Gerar consultas de busca diversificadas para cobrir as notícias mais relevantes e recentes sobre o tópico.

PRODUZA ATÉ 6 CONSULTAS.
- Inclua o tópico em português e inglês quando aplicável.
- Varie entre termos gerais e específicos.
- Use filtros de tempo: "d" (últimas 24h) ou "w" (última semana).
- Não repita consultas quase idênticas.

SAÍDA EXCLUSIVA (JSON):
{
  "queries": [
    { "text": "...", "timeRange": "d" },
    { "text": "...", "timeRange": "w" }
  ]
}`,
    tools: pick("now"),
    toolHandlers: safeHandlers,
    maxIterations: 3,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 2. RECUPERAÇÃO DE MANCHETES
  // ============================================================
  .then({
    model: "qwen3.5:2b",
    system: `Você é o agente de recuperação de notícias.

OBJETIVO
Buscar manchetes e snippets relevantes usando as consultas fornecidas.

PROCEDIMENTO
1. Execute web_search para cada consulta.
2. Coleque títulos, snippets e links.
3. Elimine duplicatas (mesmo URL).
4. Priorize notícias das últimas 24-48h.

NÃO FAÇA
- Não invente URLs.
- Não selecione links genéricos ou institucionais sem notícia real.
- Não busque mais de 4 consultas (economize chamadas).

SAÍDA EXCLUSIVA (JSON):
{
  "headlines": [
    {
      "title": "...",
      "snippet": "...",
      "url": "...",
      "relevance": "high | medium | low"
    }
  ]
}`,
    transform: (prev) =>
      `CONSULTAS PLANEJADAS:\n${prev.content}\n\nExecute as buscas agora.`,
    tools: pick("web_search"),
    toolHandlers: safeHandlers,
    maxIterations: 12,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 3. CURADORIA E RANKING
  // ============================================================
  .then({
    model: "qwen3.5:2b",
    system: `Você é o curador de um digest de notícias.

OBJETIVO
Selecionar as 5-8 melhores histórias e ordenar por relevância.

CRITÉRIOS DE SELEÇÃO
1. Relevância direta ao tópico.
2. Novidade / impacto.
3. Qualidade aparente da fonte.
4. Diversidade de perspectivas.

REGRAS
- Mantenha no mínimo 5 histórias.
- Máximo 8.
- Não inclua notícias sem URL válida.
- Se houver poucas notícias relevantes, mantenha todas.

SAÍDA EXCLUSIVA (JSON):
{
  "top_stories": [
    {
      "title": "...",
      "snippet": "...",
      "url": "...",
      "why": "por que esta história é importante"
    }
  ]
}`,
    transform: (prev) =>
      `MANCHETES RECUPERADAS:\n${prev.content}\n\nCuradorie e classifique.`,
    tools: [],
    toolHandlers: safeHandlers,
    maxIterations: 3,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 4. ENRIQUECIMENTO (web_fetch nas top 3)
  // ============================================================
  .then({
    model: "qwen3.5:2b",
    system: `Você é o agente de enriquecimento de notícias.

OBJETIVO
Ler o conteúdo completo das 3 histórias mais importantes para enriquecer o digest.

PROCEDIMENTO
1. Para cada uma das 3 primeiras histórias, use web_fetch na URL.
2. Extraia: título completo, 1-2 parágrafos-chave, dados numéricos se houver.
3. Se web_fetch falhar, use apenas o snippet original.

NÃO FAÇA
- Não busque mais de 3 URLs.
- Não invente conteúdo não encontrado na página.

SAÍDA EXCLUSIVA (JSON):
{
  "enriched": [
    {
      "title": "...",
      "url": "...",
      "key_points": ["..."],
      "data": ["..."]
    }
  ]
}`,
    transform: (prev) =>
      `HISTÓRIAS SELECIONADAS:\n${prev.content}\n\nEnriqueça as top 3.`,
    tools: pick("web_fetch"),
    toolHandlers: safeHandlers,
    maxIterations: 8,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 5. REDAÇÃO DO DIGEST
  // ============================================================
  .then({
    model: "qwen3.5:2b",
    system: `Você é um redator de digest de notícias.

OBJETIVO
Produzir um digest limpo e pronto para ser exibido com glow (renderizador Markdown).

FORMATO DE SAÍDA — Markdown puro:

# 📰 Digest: ${topic}

> ${
      new Date().toLocaleDateString("pt-BR", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    }

---

## [Título da notícia 1](url)

Snippet ou resumo em 1-2 frases. Dados numéricos quando disponíveis.

---

## [Título da notícia 2](url)

Snippet ou resumo em 1-2 frases.

---

... (repita para cada notícia)

---

*Digest gerado automaticamente em [data/hora].*

REGRAS
1. Use EXATAMENTE o formato acima.
2. Cada notícia vira um heading ## com link.
3. Abaixo do heading, 1-2 frases de resumo.
4. Separe notícias com ---.
5. Não inclua imagens.
6. Não inclua código.
7. Não inclua emojis além do 📰 no título.
8. Use dados numéricos quando disponíveis.
9. Seja conciso: máximo 3 frases por notícia.

SALVE O ARQUIVO COMO: ${OUTPUT_FILE}

RETORNE EXCLUSIVAMENTE:
{
  "path": "${OUTPUT_FILE}",
  "count": número_de_notícias
}`,
    transform: (prev) => {
      const enriched = JSON.parse(prev.content);
      const stories = enriched.enriched || [];
      return (
        `HISTÓRIAS ENRIQUECIDAS:\n${JSON.stringify(stories, null, 2)}\n\n` +
        `Redija o digest em Markdown. Salve com file_write em: ${OUTPUT_FILE}`
      );
    },
    tools: pick("file_write"),
    toolHandlers: safeHandlers,
    maxIterations: 4,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  .execute();

// ── Relatório final ──────────────────────────────────────────────────────────

console.log(`\n✅ Digest concluído.`);
console.log(`📄 Arquivo: ${OUTPUT_FILE}`);
console.log(`🔧 Chamadas de ferramentas: ${totalToolCalls}`);
console.log(`📊 Estágios:`);

results.forEach((result, index) => {
  console.log(
    `  ${index + 1}. ${result.inputTokens}/${result.outputTokens} tokens, ` +
      `${result.toolCalls.length} tool calls`,
  );
});

// ── Verificação ──────────────────────────────────────────────────────────────

let failed = 0;
const assert = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
};

console.log("\n=== Checks ===");

const exists = await Deno.stat(OUTPUT_FILE).then(() => true).catch(() => false);
assert("Arquivo existe", exists, OUTPUT_FILE);

if (exists) {
  const body = await Deno.readTextFile(OUTPUT_FILE);
  assert("Não vazio", body.trim().length > 200);
  assert("Tem heading ##", /^## /m.test(body));
  assert("Tem link http", /https?:\/\//.test(body));
  assert("Tem separador ---", /^---$/m.test(body));
}

if (failed) {
  console.error(`\nFALHOU: ${failed} check(s)`);
  Deno.exit(1);
}
console.log("\nOK — todos os checks passaram.");
