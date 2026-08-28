#!/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * news-digest.ts
 *
 * Pipeline de notícias recentes → Markdown limpo para glow
 *
 * Usa MCP remoto (Exa) para busca e fetch de conteúdo.
 *
 * Fluxo:
 *   1. Planejamento de consultas (6-10 queries diversificadas)
 *   2. Recuperação de manchetes (exa_search via MCP)
 *   3. Curadoria e ranking (8-12 histórias)
 *   4. Enriquecimento (exa_fetch via MCP nas top 5-7)
 *   5. Redação do digest (estilo glow)
 *   6. Checklist final (file_read para verificar)
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
import { MCPBridge } from "../src/mcp/client.ts";
import { Now } from "../src/tools/Now.ts";
import { FileRead } from "../src/tools/FileRead.ts";
import { FileWrite } from "../src/tools/FileWrite.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

const OUT_DIR = "data/news";
await Deno.mkdir(OUT_DIR, { recursive: true });

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

const results = await ollamaPipeline
  .create(topic)
  // ============================================================
  // 1. PLANEJAMENTO DE CONSULTAS (numCtx: 16K)
  // ============================================================
  .stage({
    model: "gemma4:31b-cloud",
    numCtx: 16384,
    system: `Você é o planejador de um digest de notícias mundiais.

DATA/HORA ATUAL: use a tool "now" se disponível.

OBJETIVO
Gerar de 6 a 10 consultas de busca diversificadas e atuais para recuperar as principais notícias do mundo nas últimas 24–48 horas.

COBERTURA OBRIGATÓRIA
- Manchetes gerais / top stories
- Política internacional
- Economia / mercados
- Tecnologia / ciência
- Conflitos / geopolítica
- Clima / meio ambiente (se houver relevância)
- Uma query em inglês e o restante em português (ou misto)

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
    maxIterations: 3,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
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
    tools: pick("exa_search"),
    toolHandlers: ALL_HANDLERS,
    maxIterations: 14,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
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
    transform: (prev) =>
      `MANCHETES RECUPERADAS:\n${prev.content}\n\nCuradorie e classifique.`,
    tools: [],
    toolHandlers: ALL_HANDLERS,
    maxIterations: 3,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
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

PARA CADA URL DAS 5–7 HISTÓRIAS MAIS IMPORTANTES:
1. Use a ferramenta de fetch de conteúdo para ler a página.
2. Extraia um resumo factual de 2 a 4 frases.
3. Identifique data de publicação se disponível.
4. Extraia 1–2 fatos-chave (números, nomes, locais).

REGRAS
- Não invente informações.
- Se a página falhar, mantenha apenas o título + snippet original.
- Mantenha o tom neutro e informativo.

SAÍDA
Retorne a lista enriquecida no mesmo formato, adicionando os campos:
"summary", "published", "key_facts"`,
    transform: (prev) =>
      `HISTÓRIAS SELECIONADAS:\n${prev.content}\n\nEnriqueça as 5–7 mais importantes.`,
    tools: pick("exa_fetch"),
    toolHandlers: ALL_HANDLERS,
    maxIterations: 16,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 5. REDAÇÃO DO DIGEST — estilo glow (numCtx: 32K)
  // ============================================================
  .then({
    model: "gpt-oss:120b-cloud",
    numCtx: 32768,
    system: `Você é o redator final de um digest de notícias para terminal.

OBJETIVO
Produzir um Markdown limpo, elegante e legível no glow.

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

SALVE O ARQUIVO COM file_write em:
"${OUTPUT_FILE}"

RETORNE:
{
  "path": "${OUTPUT_FILE}",
  "ok": true,
  "stories": número_de_historias
}`,
    transform: (prev) => {
      let enriched = [];
      try {
        enriched = JSON.parse(prev.content).enriched ||
          JSON.parse(prev.content);
      } catch {
        enriched = [];
      }
      return (
        `HISTÓRIAS ENRIQUECIDAS:\n${JSON.stringify(enriched, null, 2)}\n\n` +
        `Redija o digest em Markdown seguindo a estrutura obrigatória.\n` +
        `Salve com file_write em: ${OUTPUT_FILE}`
      );
    },
    tools: pick("file_write"),
    toolHandlers: ALL_HANDLERS,
    maxIterations: 4,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  // ============================================================
  // 6. CHECKLIST FINAL (numCtx: 16K)
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
    maxIterations: 4,
    onThinking: gray,
    onContent: (chunk) => writeChunk(chunk),
    onToolCall,
    onToolResult,
  })
  .execute();

// ── Cleanup ──────────────────────────────────────────────────────────────────

if (mcp.bridge) {
  await mcp.bridge.close();
}

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
  assert("Não vazio", body.trim().length > 300);
  assert("Tem título h1", /^# /m.test(body));
  assert("Tem heading ##", /^## /m.test(body));
  assert("Tem link Markdown", /\[.*\]\(https?:\/\/.*\)/.test(body));
  assert("Tem separador ---", /^---$/m.test(body));
  assert("Seção Destaques", /Destaques/i.test(body));
  assert("Seção Por categoria", /Por categoria/i.test(body));
}

if (failed) {
  console.error(`\nFALHOU: ${failed} check(s)`);
  Deno.exit(1);
}
console.log("\nOK — todos os checks passaram.");
