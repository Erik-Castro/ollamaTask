#!/bin/env -S deno run -WRNE

const rootDir = new URL(".", import.meta.url).pathname;
Deno.chdir(rootDir);

/**
 * news-digest.ts
 *
 * Pipeline de notícias recentes → Markdown limpo para glow
 *
 * Usa MCP remoto (Exa) para busca e fetch de conteúdo.
 *
 * Fluxo:
 *   1. Planejamento de consultas (6-10 queries diversificadas)
 *   2. Recuperação de manchetes (web_search_exa via MCP)
 *   3. Curadoria e ranking (8-12 histórias)
 *   4. Enriquecimento (web_fetch_exa via MCP nas top 5-7, batch)
 *   5. Escolha da notícia + leitura de todas as fontes
 *   6. Redação da matéria completa (merge das fontes)
 *   7. Redação do digest (estilo glow, com matéria em destaque)
 *   8. Checklist final (file_read para verificar)
 *
 * Uso:
 *   ./news-digest.ts                (notas gerais)
 *   ./news-digest.ts "tecnologia"   (tema específico)
 *   deno task news "economia"       (via task do deno.json — cron-friendly)
 *   glow $(ls -t data/news/*.md | head -1)
 *
 * Agendamento (cron):
 *   0 7 * * *  cd <repo> && deno task news >/dev/null 2>&1
 */

import { ollamaPipeline } from "../src/ollamaPipeline.ts";
import type {
  ToolArgs,
  ToolDefinition,
  ToolHandler,
} from "../src/ollamaTask.ts";
import { MCPBridge } from "../src/mcp/client.ts";
import { Now } from "../src/tools/Now.ts";
import { FileRead } from "../src/tools/FileRead.ts";
import { FileWrite } from "../src/tools/FileWrite.ts";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ── Helpers ──────────────────────────────────────────────────────────────────

const zodFormat = <T extends z.ZodType>(schema: T) =>
  zodToJsonSchema(schema, { target: "openApi3" }) as Record<string, unknown>;

const str = (v: unknown, fb = ""): string =>
  v === undefined || v === null ? fb : String(v);

const num = (
  v: unknown,
  fallback: number | null = null,
): number | undefined => {
  if (v === undefined || v === null) return fallback ?? undefined;
  if (typeof v === "string" && !v.trim()) return fallback ?? undefined;
  const value = Number(v);
  return Number.isFinite(value) ? value : fallback ?? undefined;
};

// ── JSON / structured-output helpers ─────────────────────────────────────────

const normalizeText = (s: string): string =>
  s.replace(/\u00a0/g, " ").replace(/[\u2010-\u2015]/g, "-");

const extractBalancedBlocks = (s: string): string[] => {
  const blocks: string[] = [];
  const stack: number[] = [];
  const closing: Record<string, string> = { "{": "}", "[": "]" };
  const opening: Record<string, string> = { "}": "{", "]": "[" };
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (closing[ch]) {
      stack.push(i);
    } else if (opening[ch]) {
      const start = stack.pop();
      if (start === undefined) {
        stack.length = 0;
        continue;
      }
      if (s[start] !== opening[ch]) {
        stack.length = 0;
        continue;
      }
      if (stack.length === 0) blocks.push(s.slice(start, i + 1));
    }
  }
  return blocks;
};

const safeParseJSON = (content: string): unknown => {
  const cleaned = normalizeText(content)
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```+/g, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    for (const block of extractBalancedBlocks(cleaned)) {
      try {
        return JSON.parse(block);
      } catch {
        // tenta o próximo bloco balanceado
      }
    }
  }
  return null;
};

const asStories = (
  parsed: unknown,
  ...variants: string[]
): Array<Record<string, unknown>> => {
  if (parsed === null || typeof parsed !== "object") return [];
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  for (const key of variants) {
    const v = (parsed as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  }
  return [];
};

const parseMarkdownTable = (
  content: string,
): Array<Record<string, unknown>> => {
  const normalized = normalizeText(content);
  if (!normalized.includes("|")) return [];

  const lines = normalized.split("\n");
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("Título") || lines[i].includes("Title")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];

  const headers = lines[headerIdx]
    .split("|")
    .slice(1, -1)
    .map((h) => h.trim().toLowerCase());

  const rows: Record<string, string>[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|") || /^\|\s*-{2,}/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < headers.length) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] ?? "";
    });
    rows.push(row);
  }

  return rows.map((row) => ({
    title: row["título"] ?? row["title"] ?? "",
    url: row["url"] ?? "",
    source: row["fonte"] ?? row["source"] ?? "",
    category: row["categoria"] ?? row["category"] ?? "",
    snippet: row["snippet"] ?? "",
    summary: row["resumo"] ?? row["summary"] ?? "",
    published: row["publicado"] ?? row["published"] ?? "",
    key_facts: row["fatos-chave"] ?? row["key_facts"] ?? "",
    why: row["por que"] ?? row["razão"] ?? row["why"] ?? "",
  }));
};

const parseStories = (
  content: string,
  ...variants: string[]
): Array<Record<string, unknown>> => {
  const fromJson = asStories(safeParseJSON(content), ...variants);
  if (fromJson.length > 0) return fromJson;
  return parseMarkdownTable(content);
};

const TRACKING_PARAMS =
  /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|source|via)/i;

const normalizeUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const u = new URL(trimmed);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.host.toLowerCase() + u.pathname + u.search;
  } catch {
    return trimmed.toLowerCase();
  }
};

const dedupeStories = <T extends Record<string, unknown>>(items: T[]): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = normalizeUrl(String(item.url ?? ""));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

const assertStories = (
  label: string,
  items: Array<Record<string, unknown>>,
): void => {
  if (items.length === 0) {
    throw new Error(
      `ABORTADO: ${label} retornou lista vazia. Nada a digerir — re-execute com outro tema.`,
    );
  }
};

const saveArtifact = async (name: string, data: unknown): Promise<string> => {
  const path = `${OUT_DIR}/artifact-${name}`;
  await Deno.writeTextFile(path, JSON.stringify(data ?? [], null, 2));
  return path;
};

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

// ── Local tool definitions ───────────────────────────────────────────────────

const LOCAL_TOOLS: ToolDefinition[] = [
  tool(
    "now",
    "Data/hora atual: { iso, unix, timezone, utcOffsetMinutes }.",
    {},
  ),
  tool(
    "file_read",
    "Lê um arquivo de texto existente.",
    {
      path: { type: "string" },
      maxChars: { type: "integer" },
      offset: { type: "integer" },
    },
    ["path"],
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

const LOCAL_HANDLERS: ToolHandler[] = [
  { name: "now", execute: () => Now() },
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
];

const safeLocalHandlers: ToolHandler[] = LOCAL_HANDLERS.map((h) => ({
  name: h.name,
  execute: async (args: ToolArgs) => {
    try {
      return await h.execute(args);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
}));

// ── MCP connection (Exa) ─────────────────────────────────────────────────────

const EXA_URL = "https://mcp.exa.ai/mcp";

async function connectMCP(url: string, retries = 3): Promise<{
  bridge: MCPBridge | null;
  definitions: ToolDefinition[];
  handlers: ToolHandler[];
}> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(
        `Connecting to Exa MCP server (attempt ${attempt}/${retries})...`,
      );
      const bridge = await MCPBridge.connect({ type: "remote", url });
      const { definitions, handlers } = bridge.getTools();
      console.log(`Found ${definitions.length} MCP tools:`);
      for (const d of definitions) {
        console.log(`  - ${d.function.name}: ${d.function.description}`);
      }
      return { bridge, definitions, handlers };
    } catch (error) {
      console.error(
        `MCP connection attempt ${attempt} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (attempt < retries) {
        console.log(`Retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  console.warn(
    "⚠️  MCP connection failed. Continuing without MCP tools.",
  );
  return { bridge: null, definitions: [], handlers: [] };
}

const mcp = await connectMCP(EXA_URL);

// ── Merged tools ─────────────────────────────────────────────────────────────

const ALL_DEFINITIONS = [...LOCAL_TOOLS, ...mcp.definitions];
const ALL_HANDLERS = [...safeLocalHandlers, ...mcp.handlers];

const pick = (...names: string[]) =>
  ALL_DEFINITIONS.filter((t) => names.includes(t.function.name));

// ── CLI ──────────────────────────────────────────────────────────────────────

const topic = Deno.args[0]?.trim() || "notícias recentes do mundo";

const OUT_DIR = `${
  Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "."
}/news`;
await Deno.mkdir(OUT_DIR, { recursive: true });

// Debug console.log(OUT_DIR); Deno.exit(0);

const now = new Date();
const dateStamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUTPUT_FILE = `${OUT_DIR}/digest-${dateStamp}.md`;

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

let enrichedSnapshot: Array<Record<string, unknown>> = [];
const fetchedSources: Array<{
  url: string;
  title: string;
  content: string;
}> = [];

const MAX_SOURCE_CHARS = 1600;
const MAX_SOURCES = 6;

const parseFetchedMarkdown = (
  text: string,
): Array<{ url: string; title: string; content: string }> => {
  const out: Array<{ url: string; title: string; content: string }> = [];
  const sections = String(text).split(/\n(?=#\s)/);
  for (const section of sections) {
    const urlMatch = section.match(/^URL:\s*(https?:\/\/\S+)/im);
    if (!urlMatch) continue;
    const url = urlMatch[1];
    const title = section.match(/^#\s+(.+)$/im)?.[1]?.trim() ?? url;
    const content = section.replace(/^#\s+.*$/im, "").replace(/^URL:.*$/im, "")
      .trim();
    if (content) out.push({ url, title, content });
  }
  return out;
};

const captureFetchResult = (result: unknown): void => {
  const parsed = parseFetchedMarkdown(typeof result === "string" ? result : "");
  if (parsed.length === 0) return;
  const seen = new Set(fetchedSources.map((s) => s.url));
  for (const src of parsed) {
    if (seen.has(src.url)) continue;
    seen.add(src.url);
    fetchedSources.push({
      url: src.url,
      title: src.title,
      content: src.content.slice(0, MAX_SOURCE_CHARS),
    });
  }
};

const boundedSources = (
  sources: Array<{ url: string; title: string; content: string }> =
    fetchedSources,
): Array<{ url: string; title: string; content: string }> =>
  sources
    .filter((s) => s.url && s.content)
    .slice(0, MAX_SOURCES)
    .map((s) => ({
      url: s.url,
      title: s.title || s.url,
      content: s.content.slice(0, MAX_SOURCE_CHARS),
    }));

const results = await ollamaPipeline
  .create(topic)
  // ============================================================
  // 1. PLANEJAMENTO DE CONSULTAS (numCtx: 16K)
  // ============================================================
  .stage({
    model: "gemma4:31b-cloud",
    numCtx: 16384,
    system: `Você é o planejador de um digest de notícias mundiais.

TEMA/PESQUISA: "${topic}"

DATA/HORA ATUAL: use a tool "now" se disponível.

OBJETIVO
Gerar de 6 a 10 consultas de busca diversificadas e atuais sobre o tema "${topic}", recuperando as principais notícias relacionadas nas últimas 24–48 horas.

COBERTURA OBRIGATÓRIA
- Foco principal no tema "${topic}"
- Manchetes gerais / top stories
- Politica Internacional
- Economia / Mercados
- Tecnologias / Ciência
- Conflitos / Geopolitica
- Clima / Meio ambiente (se houver relevância)
- Saúde / Educação
- Uma query em inglês e o restante em português (ou misto)
- Complemente com cobertura de manchetes gerais se o tema permitir

REGRAS
- Prefira termos que puxem notícias recentes ("hoje", "últimas horas", "breaking", "latest")
- Evite queries genéricas demais ("notícias")
- Não inclua sites específicos na query (deixe o buscador decidir)

SAÍDA EXCLUSIVA
{
  "queries": ["...", "..."]
}`,
    tools: pick("now"),
    toolHandlers: ALL_HANDLERS,
    format: zodFormat(z.object({
      queries: z.array(z.string()),
    })),
    maxIterations: 3,
    onThinking: gray,
    //onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 2. RECUPERAÇÃO DE MANCHETES — Exa MCP (numCtx: 16K)
  // ============================================================
  .then({
    model: "nemotron-3-nano:30b-cloud",
    numCtx: 16384,
    system: `Você é o agente de recuperação de notícias.

OBJETIVO
Executar as consultas recebidas e coletar um conjunto diversificado de manchetes promissoras.

PROCEDIMENTO
1. Use a ferramenta de busca para cada query útil.
2. Analise título + snippet + URL.
3. Descarte links irrelevantes, clickbait óbvio ou muito antigos.
4. Priorize fontes reconhecidas (BBC, Reuters, AP, Guardian, Folha, G1, CNN, NYT, etc.).
5. Elimine duplicatas de praticamente a mesma história.

QUANTIDADE
Tente ficar entre 10 e 18 manchetes distintas.

SAÍDA EXCLUSIVA
{
  "headlines": [
    {
      "title": "...",
      "url": "https://...",
      "source": "nome da fonte",
      "snippet": "resumo curto do snippet",
      "category": "política|economia|tecnologia|conflito|clima|geral"
    }
  ]
}`,
    transform: (prev) =>
      `CONSULTAS PLANEJADAS:\n${prev.content}\n\nExecute as buscas agora.`,
    tools: pick("web_search_exa"),
    toolHandlers: ALL_HANDLERS,
    format: zodFormat(z.object({
      headlines: z.array(z.object({
        title: z.string(),
        url: z.string(),
        source: z.string(),
        snippet: z.string(),
        category: z.string(),
      })),
    })),
    maxIterations: 14,
    onThinking: gray,
    //onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 3. CURADORIA E RANKING (numCtx: 16K)
  // ============================================================
  .then({
    model: "nemotron-3-nano:30b-cloud",
    numCtx: 16384,
    system: `Você é o editor-chefe de um digest diário de notícias.

OBJETIVO
Selecionar as 8 a 12 histórias mais importantes e interessantes do conjunto recebido.

CRITÉRIOS DE PRIORIDADE
1. Impacto global ou relevância geopolítica
2. Novidade (preferir as mais recentes)
3. Diversidade de temas e regiões
4. Qualidade da fonte
5. Interesse humano / clareza da manchete

REGRAS
- Não invente notícias.
- Não repita a mesma história com URLs diferentes.
- Prefira qualidade a quantidade.

SAÍDA EXCLUSIVA
{
  "selected": [
    {
      "title": "...",
      "url": "...",
      "source": "...",
      "category": "...",
      "why": "razão curta da escolha"
    }
  ]
}`,
    transform: (prev) => {
      const headlines = dedupeStories(
        parseStories(prev.content, "headlines"),
      );
      assertStories("Estágio 2 (manchetes recuperadas)", headlines);
      return (
        `MANCHETES RECUPERADAS (JSON limpo):\n` +
        `${JSON.stringify(headlines, null, 2)}\n\nCuradorie e classifique.`
      );
    },
    tools: [],
    toolHandlers: ALL_HANDLERS,
    format: zodFormat(z.object({
      selected: z.array(z.object({
        title: z.string(),
        url: z.string(),
        source: z.string(),
        category: z.string(),
        why: z.string(),
      })),
    })),
    maxIterations: 3,
    onThinking: gray,
    //onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 4. ENRIQUECIMENTO — Exa MCP (numCtx: 32K)
  // ============================================================
  .then({
    model: "gpt-oss:120b-cloud",
    numCtx: 32768,
    system: `Você enriquece as notícias selecionadas.

PARA AS 5–7 HISTÓRIAS MAIS IMPORTANTES:
1. Chame a ferramenta de fetch UMA ÚNICA VEZ com TODAS as URLs num único array (o web_fetch_exa aceita múltiplas URLs) — não chame uma URL por vez.
2. Extraia um resumo factual de 2 a 4 frases de cada página retornada.
3. Identifique data de publicação se disponível.
4. Extraia 1–2 fatos-chave de cada (números, nomes, locais).

REGRAS
- Não invente informações.
- Se a página falhar, mantenha apenas o título + snippet original.
- Mantenha o tom neutro e informativo.

SAÍDA EXCLUSIVA — RETORNE APENAS JSON VÁLIDO, NÃO TABELA MARKDOWN:
{
  "enriched": [
    {
      "title": "...",
      "url": "...",
      "source": "...",
      "category": "...",
      "summary": "...",
      "published": "...",
      "key_facts": ["..."]
    }
  ]
}`,
    transform: (prev) => {
      const selected = dedupeStories(
        parseStories(prev.content, "selected"),
      );
      assertStories("Estágio 3 (histórias selecionadas)", selected);
      return (
        `HISTÓRIAS SELECIONADAS (JSON limpo):\n` +
        `${
          JSON.stringify(selected, null, 2)
        }\n\nEnriqueça as 5–7 mais importantes.`
      );
    },
    tools: pick("web_fetch_exa"),
    toolHandlers: ALL_HANDLERS,
    format: zodFormat(z.object({
      enriched: z.array(z.object({
        title: z.string(),
        url: z.string(),
        source: z.string(),
        category: z.string(),
        summary: z.string(),
        published: z.string().optional(),
        key_facts: z.array(z.string()).optional(),
      })),
    })),
    maxIterations: 6,
    onThinking: gray,
    //onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 5. ESCOLHA DA NOTÍCIA MAIS RELEVANTE + LEITURA DE FONTES (numCtx: 128K)
  // ============================================================
  .then({
    model: "gpt-oss:120b-cloud",
    numCtx: 131072,
    system: `Você é o editor executivo de um digest de notícias.

OBJETIVO
Dentre as notícias enriquecidas recebidas, escolha a ÚNICA notícia mais relevante e impactante para aprofundar. Depois, busque TODO o conteúdo disponível sobre ela.

CRITÉRIOS DE ESCOLHA
1. Impacto global ou relevância geopolítica (peso maior)
2. Urgência / quebra de notícia recente
3. Audiência e interesse público amplo
4. Profundidade potencial (quantas fontes cobrem o tema)
5. Novidade / exclusividade

PROCEDIMENTO
1. Analise todas as notícias enriquecidas e escolha a mais relevante.
2. Use web_fetch_exa para buscar TODAS as URLs relacionadas à notícia escolhida — inclua a URL principal e quaisquer outras URLs/referências que apareçam no conteúdo retornado.
3. Chame web_fetch_exa com TODAS as URLs num único array (aceita múltiplas URLs).
4. Se o primeiro fetch retornar mais URLs relevantes, faça fetch delas também.

REGRAS
- Escolha APENAS UMA notícia.
- Não invente URLs — use apenas as que encontrar no conteúdo.
- Busque no mínimo 3 fontes diferentes sobre o tema.
- O conteúdo das páginas é capturado automaticamente pelo sistema — NÃO repita o conteúdo das fontes na sua resposta.

SAÍDA EXCLUSIVA — RETORNE APENAS JSON VÁLIDO:
{
  "chosen": {
    "title": "...",
    "url": "...",
    "source": "...",
    "category": "...",
    "why": "razão da escolha"
  }
}`,
    transform: (prev) => {
      const enriched = dedupeStories(
        parseStories(prev.content, "enriched"),
      );
      assertStories("Estágio 4 (histórias enriquecidas)", enriched);
      enrichedSnapshot = enriched;
      return (
        `HISTÓRIAS ENRIQUECIDAS (JSON limpo):\n` +
        `${JSON.stringify(enriched, null, 2)}\n\n` +
        `Escolha a notícia mais relevante e busque TODAS as fontes disponíveis via web_fetch_exa.`
      );
    },
    tools: pick("web_fetch_exa"),
    toolHandlers: ALL_HANDLERS,
    format: zodFormat(z.object({
      chosen: z.object({
        title: z.string(),
        url: z.string(),
        source: z.string(),
        category: z.string(),
        why: z.string(),
      }),
    })),
    numPredict: 4000,
    maxIterations: 8,
    onThinking: gray,
    //onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult: (name, args, result) => {
      onToolResult(name, args, result); // mantém o log
      if (name === "web_fetch_exa") captureFetchResult(result);
    },
  })
  // ============================================================
  // 6. REDAÇÃO DA MATÉRIA COMPLETA (numCtx: 128K)
  // ============================================================
  .then({
    model: "gpt-oss:120b-cloud",
    numCtx: 131072,
    system: `Você é um jornalista redator de matérias aprofundadas.

OBJETIVO
Unir TODAS as fontes coletadas sobre a notícia escolhida em uma matéria completa, coesa e bem escrita.

ENTRADA
Você receberá:
1. A notícia escolhida (título, URL, fonte, categoria)
2. Múltiplas fontes com o conteúdo de cada uma

PROCEDIMENTO
1. Leia todas as fontes fornecidas.
2. Identifique os pontos em comum e as informações complementares.
3. Redija uma matéria completa que una todas as perspectivas.
4. Mantenha fatos verificados — não invente informações.
5. Cite as fontes no corpo do texto quando apropriado.

ESTRUTURA DA MATÉRIA
- Título chamativo e informativo
- Lide (1º parágrafo): resumo em 2-3 frases com os pontos mais importantes
- Desenvolvimento: detalhes, contexto, diferentes perspectivas das fontes
- Citação de especialistas / fontes quando disponível
- Conclusão: impacto e próximos passos

REGRAS
- Tom jornalístico profissional, neutro e informativo.
- Não invente dados ou citações.
- Use dados e números das fontes quando disponíveis.
- Matéria deve ter entre 300 e 600 palavras.
- Mantenha parágrafos curtos (2-4 frases cada).

SAÍDA EXCLUSIVA — RETORNE APENAS JSON VÁLIDO:
{
  "article": {
    "title": "...",
    "body": "matéria completa em markdown",
    "sources": ["url1", "url2", "..."]
  }
}`,
    transform: (prev) => {
      const parsed = safeParseJSON(prev.content) as
        | Record<string, unknown>
        | null;
      const chosen = parsed?.chosen as Record<string, unknown> | undefined;

      let chosenStory: Record<string, unknown>;
      let sources = boundedSources();
      if (chosen) {
        chosenStory = chosen;
      } else if (enrichedSnapshot.length > 0) {
        chosenStory = enrichedSnapshot[0] as Record<string, unknown>;
        console.warn(
          "⚠️ Estágio 5 não retornou 'chosen' válido — usando a 1ª história enriquecida.",
        );
      } else {
        throw new Error(
          "Estágio 5 retornou saída inválida e não há histórias enriquecidas para fallback.",
        );
      }

      if (sources.length === 0) {
        const snippet = String(
          chosenStory.summary ?? chosenStory.snippet ?? "",
        );
        if (snippet) {
          sources = [{
            url: String(chosenStory.url ?? ""),
            title: String(chosenStory.title ?? ""),
            content: snippet,
          }];
        }
        console.warn(
          "⚠️ Nenhuma fonte capturada no estágio 5 — matéria baseada apenas no resumo enriquecido.",
        );
      }

      return (
        `NOTÍCIA ESCOLHIDA:\n${JSON.stringify(chosenStory, null, 2)}\n\n` +
        `FONTES COLETADAS (${sources.length}):\n` +
        sources.map((s, i) =>
          `\n--- Fonte ${i + 1}: ${s.title} (${s.url}) ---\n${s.content}`
        ).join("\n") +
        `\n\nUna todas as fontes em uma matéria completa.`
      );
    },
    tools: [],
    toolHandlers: ALL_HANDLERS,
    format: zodFormat(z.object({
      article: z.object({
        title: z.string(),
        body: z.string(),
        sources: z.array(z.string()),
      }),
    })),
    numPredict: 12000,
    maxIterations: 3,
    onThinking: gray,
    //onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 7. REDAÇÃO DO DIGEST — estilo glow (numCtx: 32K)
  // ============================================================
  .then({
    model: "gpt-oss:120b-cloud",
    numCtx: 32768,
    system: `Você é o redator final de um digest de notícias para terminal.

OBJETIVO
Produzir um Markdown limpo, elegante e legível no glow, com uma matéria em destaque e resumos por categoria.

ESTRUTURA OBRIGATÓRIA

# Digest de Notícias — ${
      now.toLocaleDateString("pt-BR", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    }

> Atualizado em ${
      now.toLocaleTimeString("pt-BR")
    } · Fonte: buscas web + curadoria automática

---

## Matéria em Destaque

### Título da Matéria

Corpo completo da matéria (já fornecido no input).
Cite as fontes no final da seção.

---

## Destaques

- **Título da notícia** — fonte
  Resumo em 2–3 frases. [ler mais](url)

- **Outra notícia** — fonte
  Resumo...

---

## Por categoria

### Política & Geopolítica
...

### Economia
...

### Tecnologia & Ciência
...

### Outros
...

---

_Gerado automaticamente · Pipeline news-digest_

REGRAS DE ESTILO
- Use **negrito** nos títulos.
- Links no formato Markdown: [ler mais](url)
- Frases curtas e objetivas.
- Sem emojis excessivos (no máximo 1–2 se fizer sentido).
- Sem introduções longas ou conclusões filosóficas.
- Prefira legibilidade no terminal (linhas não muito longas).
- A seção "Matéria em Destaque" deve conter o artigo completo fornecido, formatado em Markdown.
- Não resuma a matéria em destaque — inclua-a integralmente.

SALVE O ARQUIVO COM file_write em:
"${OUTPUT_FILE}"

RETORNE:
{
  "path": "${OUTPUT_FILE}",
  "ok": true,
  "stories": número_de_historias
}`,
    transform: (prev) => {
      const stories = dedupeStories(enrichedSnapshot);
      assertStories("Estágio 4 (histórias enriquecidas)", stories);

      let articleTitle = "";
      let articleBody = "";
      try {
        const articleParsed = safeParseJSON(
          prev.content,
        ) as Record<string, unknown> | null;
        const article = articleParsed?.article as
          | Record<string, unknown>
          | undefined;
        if (article) {
          articleTitle = String(article.title ?? "");
          articleBody = String(article.body ?? "");
        }
      } catch {
        // se o parse falhar, segue sem matéria
      }

      return (
        `HISTÓRIAS ENRIQUECIDAS (JSON limpo):\n${
          JSON.stringify(stories, null, 2)
        }\n\n` +
        (articleBody
          ? `MATÉRIA EM DESTAQUE:\n# ${articleTitle}\n\n${articleBody}\n\n` +
            `---\n\n`
          : "") +
        `Redija o digest em Markdown seguindo a estrutura obrigatória.\n` +
        `Inclua a matéria em destaque na seção "Matéria em Destaque".\n` +
        `Salve com file_write em: ${OUTPUT_FILE}`
      );
    },
    tools: pick("file_write"),
    toolHandlers: ALL_HANDLERS,
    maxIterations: 4,
    onThinking: gray,
    //onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 8. CHECKLIST FINAL (numCtx: 16K)
  // ============================================================
  .then({
    model: "gemma4:31b-cloud",
    numCtx: 16384,
    system: `Verifique o arquivo gerado.

1. file_read do digest em: "${OUTPUT_FILE}"
2. Confirme se contém:
   - Título principal (h1)
   - Pelo menos 6 notícias
   - Links Markdown [ler mais](url)
   - Separadores ---
   - Seção "Destaques"
   - Seção "Por categoria"
3. Responda apenas:
{
  "ok": true,
  "path": "${OUTPUT_FILE}",
  "stories": N
}`,
    transform: (prev) =>
      `Resultado da redação: ${prev.content}\n\nLeia o arquivo gerado e verifique.`,
    tools: pick("file_read"),
    toolHandlers: ALL_HANDLERS,
    format: zodFormat(z.object({
      ok: z.boolean(),
      path: z.string(),
      stories: z.number(),
    })),
    maxIterations: 4,
    onThinking: gray,
    //onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  .execute();

// ── .execute() retorna → Cleanup ─────────────────────────────────────────────

if (mcp.bridge) {
  await mcp.bridge.close();
}

// ── Artefatos intermediários (debug / reuso / verificação) ──────────────────

const stageData = results.map((r) => r.content);
const queries = asStories(safeParseJSON(stageData[0] ?? ""), "queries");
await saveArtifact("queries.json", queries);
const headlines = dedupeStories(parseStories(stageData[1] ?? "", "headlines"));
await saveArtifact("headlines.json", headlines);
const selected = dedupeStories(parseStories(stageData[2] ?? "", "selected"));
await saveArtifact("selected.json", selected);
const enriched = dedupeStories(parseStories(stageData[3] ?? "", "enriched"));
await saveArtifact("enriched.json", enriched);
const chosen = (() => {
  const parsed = safeParseJSON(stageData[4] ?? "") as
    | Record<string, unknown>
    | null;
  const c = parsed?.chosen as Record<string, unknown> | undefined;
  const sources = boundedSources(
    fetchedSources.length > 0 ? fetchedSources : results[4]?.toolCalls
      .filter((tc) => tc.name === "web_fetch_exa")
      .flatMap((tc) =>
        parseFetchedMarkdown(
          typeof tc.result === "string" ? tc.result : "",
        )
      ),
  );
  return {
    chosen: c ?? {},
    sources,
    count: sources.length,
  };
})();
await saveArtifact("article.json", chosen);
const fullArticle = (() => {
  const parsed = safeParseJSON(stageData[5] ?? "") as
    | Record<string, unknown>
    | null;
  const a = parsed?.article as Record<string, unknown> | undefined;
  return {
    title: a?.title ?? "",
    body: a?.body ?? "",
    sources: Array.isArray(a?.sources) ? a.sources : [],
  };
})();
await saveArtifact("full-article.json", fullArticle);

// ── Relatório final ──────────────────────────────────────────────────────────

const digestBody = await Deno.readTextFile(OUTPUT_FILE).catch(() => "");
const wordCount = digestBody.trim().split(/\s+/).filter(Boolean).length;
const readMinutes = Math.max(1, Math.round(wordCount / 200));
const totalTokens = results.reduce(
  (acc, r) => acc + r.inputTokens + r.outputTokens,
  0,
);
const perCategory = enriched.reduce<Record<string, number>>((acc, e) => {
  const category = String(e.category ?? "geral").trim() || "geral";
  acc[category] = (acc[category] ?? 0) + 1;
  return acc;
}, {});

const manifest = {
  generated_at: now.toISOString(),
  topic,
  output_file: OUTPUT_FILE,
  artifact_dir: OUT_DIR,
  counts: {
    queries: queries.length,
    headlines: headlines.length,
    selected: selected.length,
    enriched: enriched.length,
    sources: chosen.count,
    article_words: String(fullArticle.body).trim().split(/\s+/)
      .filter(Boolean).length,
  },
  featured_article: {
    title: fullArticle.title,
    sources: fullArticle.sources.length,
  },
  per_category: perCategory,
  tokens: {
    total: totalTokens,
    per_stage: results.map((r) => ({
      input: r.inputTokens,
      output: r.outputTokens,
      tool_calls: r.toolCalls.length,
    })),
  },
  tool_calls_total: totalToolCalls,
  read_time_minutes: readMinutes,
  word_count: wordCount,
};
const manifestPath = await saveArtifact("manifest.json", manifest);

console.log(`\n✅ Digest concluído.`);
console.log(`📄 Arquivo: ${OUTPUT_FILE}`);
console.log(`📦 Manifest: ${manifestPath}`);
console.log(`📖 ${wordCount} palavras · ~${readMinutes} min de leitura`);
console.log(
  `🔧 Chamadas de ferramentas: ${totalToolCalls} · ${totalTokens} tokens`,
);
console.log(
  `ℹ️ queries=${queries.length} manchetes=${headlines.length} selecionadas=${enriched.length} fontes-da-matéria=${chosen.count}`,
);
console.log(
  `🗂️ Por categoria: ${
    Object.entries(perCategory).map(([c, n]) => `${c}=${n}`).join(" ") || "—"
  }`,
);
console.log(`📊 Estágios:`);

results.forEach((result, index) => {
  console.log(
    `  ${index + 1}. ${result.inputTokens}/${result.outputTokens} tokens, ` +
      `${result.toolCalls.length} tool calls`,
  );
});

// ── Verificação programática ─────────────────────────────────────────────────

let failed = 0;
const assert = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
};

console.log("\n=== Checks ===");

const enrichedExists = await Deno.stat(`${OUT_DIR}/artifact-enriched.json`)
  .then(() => true)
  .catch(() => false);
assert("Artefato enriched.json gravado", enrichedExists);

const manifestExists = await Deno.stat(`${OUT_DIR}/artifact-manifest.json`)
  .then(() => true)
  .catch(() => false);
assert("Artefato manifest.json gravado", manifestExists);

const exists = await Deno.stat(OUTPUT_FILE).then(() => true).catch(() => false);
assert("Arquivo existe", exists, OUTPUT_FILE);

if (exists) {
  const body = await Deno.readTextFile(OUTPUT_FILE);
  assert("Não vazio", body.trim().length > 300);
  assert("Tem título h1", /^# /m.test(body));
  assert("Tem heading ##", /^## /m.test(body));
  assert("Tem link Markdown", /\[.*\]\(https?:\/\/.*\)/.test(body));
  assert("Tem separador ---", /^---$/m.test(body));
  assert("Seção Destaques", /Destaques/i.test(body));
  assert("Seção Por categoria", /Por categoria/i.test(body));
  assert("Sem 'nenhuma notícia'", !/nenhuma not[íi]cia/i.test(body));

  const linkCount =
    (body.match(/\[ler mais\]\(https?:\/\/[^)]+\)/g) ?? []).length;
  assert(
    `Digest tem ${linkCount} link(s) 'ler mais'`,
    linkCount >= Math.min(3, enriched.length),
    `esperado >= ${Math.min(3, enriched.length)}`,
  );

  const presentUrls = enriched.filter((e) => {
    const url = String(e.url ?? "");
    return url.length > 0 && body.includes(url);
  }).length;
  assert(
    `URLs do enriquecimento no body (${presentUrls}/${enriched.length})`,
    presentUrls >= Math.min(1, enriched.length),
  );
}

if (failed) {
  console.error(`\nFALHOU: ${failed} check(s)`);
  Deno.exit(1);
}
console.log("\nOK — todos os checks passaram.");
