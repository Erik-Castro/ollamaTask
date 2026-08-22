#!/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * deep-research-academic.ts
 *
 * Pipeline de pesquisa profunda orientado a evidências, com recuperação adaptativa.
 *
 * Fluxo:
 *   1. Planejamento
 *   2. Recuperação inicial e curadoria
 *   3. Extração de fontes e evidências
 *   4. Recuperação adaptativa de lacunas + enriquecimento
 *   5. Síntese crítica
 *   6. Redação acadêmica
 *   7. Revisão acadêmica
 *
 * Uso:
 *   ./deep-research-academic.ts "Qual a origem do queijo?"
 */

import { ollamaPipeline } from "../src/ollamaPipeline.ts";
import type {
  ToolArgs,
  ToolDefinition,
  ToolHandler,
} from "../src/ollamaTask.ts";
import { MCPBridge } from "../src/mcp/client.ts";
import { FileRead } from "../src/tools/FileRead.ts";
import { FileWrite } from "../src/tools/FileWrite.ts";

const str = (v: unknown, fallback = "") =>
  v === undefined || v === null ? fallback : String(v);

const num = (v: unknown, fallback: number | null = null) => {
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
    parameters: {
      type: "object",
      properties,
      required,
    },
  },
});

const ALL_TOOLS: ToolDefinition[] = [
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
    "Cria ou sobrescreve um arquivo de texto.",
    {
      path: { type: "string" },
      content: { type: "string" },
    },
    ["path", "content"],
  ),
];

const handlers: ToolHandler[] = [
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

const safeHandlers: ToolHandler[] = handlers.map((h) => ({
  name: h.name,
  execute: async (args: ToolArgs) => {
    try {
      return await h.execute(args);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
}));

const EXA_URL = "https://mcp.exa.ai/mcp";
console.log("Connecting to Exa MCP server...");
const mcpBridge = await MCPBridge.connect({
  type: "remote",
  url: EXA_URL,
});
const { definitions: mcpDefinitions, handlers: mcpHandlers } =
  mcpBridge.getTools();
console.log(`Found ${mcpDefinitions.length} MCP tools:`);
for (const d of mcpDefinitions) {
  console.log(`  - ${d.function.name}: ${d.function.description}`);
}

const ALL_DEFINITIONS = [...ALL_TOOLS, ...mcpDefinitions];
const ALL_HANDLERS = [...safeHandlers, ...mcpHandlers];

const pick = (...names: string[]) =>
  ALL_DEFINITIONS.filter((t) => names.includes(t.function.name));

const pickAll = () => ALL_DEFINITIONS;

const query = Deno.args[0]?.trim();
if (!query) {
  console.error('Uso: deep-research-academic <"consulta">');
  Deno.exit(1);
}

const OUT_DIR = "data/research";
await Deno.mkdir(OUT_DIR, { recursive: true });
const OUTPUT_FILE = `${OUT_DIR}/article-${Date.now()}.md`;

let totalToolCalls = 0;
const encoder = new TextEncoder();
const writeChunk = (chunk: string) =>
  Deno.stdout.writeSync(encoder.encode(chunk));
const gray = (chunk: string) => writeChunk(`\x1b[90m${chunk}\x1b[0m`);

const onToolCall = (name: string, args: ToolArgs) => {
  totalToolCalls++;
  console.log(`\n🔧 [${totalToolCalls}] ${name}(${JSON.stringify(args)})`);
};

const onToolResult = (name: string, _args: ToolArgs, result: unknown) => {
  const json = JSON.stringify(result);
  console.log(
    `📦 ${name} → ${json.length > 240 ? json.slice(0, 240) + "…" : json}`,
  );
};

const results = await ollamaPipeline
  .create(query)
  // ============================================================
  // 1. PLANEJAMENTO
  // ============================================================
  .stage({
    model: "gemma4:31b-cloud",
    system: `Você é o planejador de uma investigação bibliográfica.

PERGUNTA
"${query}"

OBJETIVO
Transformar a pergunta em consultas de busca complementares. O objetivo é encontrar evidências, não responder à pergunta nesta etapa.

PRODUZA ATÉ 10 CONSULTAS.

A cobertura deve incluir, quando aplicável:
- pergunta principal em linguagem natural;
- termos históricos e cronológicos;
- termos arqueológicos ou documentais;
- termos técnicos e científicos;
- localização geográfica ou culturas relacionadas;
- estudos de revisão ou estado da arte;
- evidências primárias e institucionais;
- controvérsias, hipóteses alternativas ou termos usados pela literatura.

REGRAS
1. Evite consultas quase idênticas.
2. Use a língua mais provável das fontes relevantes; inclua inglês quando isso ampliar significativamente a cobertura.
3. Não use operadores ou filtros excessivamente restritivos.
4. Não limite a pesquisa a artigos acadêmicos: fontes de museus, universidades, órgãos públicos e referências históricas podem ser essenciais.
5. Não conclua nada nesta etapa.

SAÍDA EXCLUSIVA
{
  "queries": ["...", "..."]
}`,
    tools: [],
    toolHandlers: ALL_HANDLERS,
    format: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" } },
      },
      required: ["queries"],
    },
    maxIterations: 2,
    onThinking: gray,
    onToolCall,
    onToolResult,
    think: true,
  })
  // ============================================================
  // 2. RECUPERAÇÃO INICIAL
  // ============================================================
  .then({
    model: "gemma4:31b-cloud",
    system: `Você é o agente de recuperação bibliográfica.

PERGUNTA
"${query}"

OBJETIVO
Encontrar um conjunto robusto e diversificado de fontes potencialmente úteis para responder à pergunta.

PROCEDIMENTO
1. Execute buscas para todas as consultas úteis recebidas.
2. Examine títulos, URLs e snippets.
3. Quando uma consulta produzir resultados fracos, reformule-a e faça nova busca.
4. Priorize fontes que possam conter evidência substantiva.
5. Elimine duplicatas.

HIERARQUIA PRÁTICA DE FONTES
Preferência aproximada:
1. estudos acadêmicos e revisões;
2. documentos de universidades e centros de pesquisa;
3. museus, bibliotecas, arquivos e sociedades científicas;
4. órgãos governamentais e instituições internacionais;
5. livros/enciclopédias e fontes de referência reconhecidas;
6. fontes secundárias confiáveis.

IMPORTANTE
Uma fonte não precisa ser acadêmica para ser válida. Uma pergunta histórica ou arqueológica pode exigir museus, arquivos ou instituições culturais.

QUANTIDADE
Tente obter entre 6 e 12 fontes distintas. Menos fontes só é aceitável quando a pesquisa realmente não oferece alternativas relevantes.

NÃO FAÇA
- não invente URLs;
- não selecione links apenas porque parecem sofisticados;
- não conclua que não existem evidências só porque uma busca falhou.

SAÍDA EXCLUSIVA
{
  "sources": [
    {
      "url": "https://...",
      "reason": "por que esta fonte parece relevante"
    }
  ]
}`,
    transform: (previous) =>
      `CONSULTAS PLANEJADAS:\n${previous.content}\n\nFaça a recuperação das fontes agora.`,
    tools: pickAll(),
    toolHandlers: ALL_HANDLERS,
    format: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              reason: { type: "string" },
            },
            required: ["url", "reason"],
          },
        },
      },
      required: ["sources"],
    },
    maxIterations: 18,
    onThinking: gray,
    onToolCall,
    onToolResult,
    think: true,
  })
  // ============================================================
  // 3. EXTRAÇÃO DE FONTES E EVIDÊNCIAS
  // ============================================================
  .then({
    model: "gemma4:31b-cloud",
    system: `Você é um analista de fontes para uma pesquisa acadêmica.

PERGUNTA
"${query}"

OBJETIVO
Ler as fontes recuperadas e extrair informações factuais e atribuíveis que possam sustentar um artigo posterior.

PARA CADA URL
1. Use a ferramenta de obtenção de conteúdo para ler a página.
2. Identifique título, autor(es), data/ano e instituição quando essas informações estiverem presentes.
3. Classifique a fonte como academic, institutional, governmental, museum_archive, reference, secondary, news ou other.
4. Determine se a fonte é realmente relevante.
5. Extraia de 2 a 8 claims importantes, quando existirem.
6. Para cada claim, registre evidência ou contexto textual da própria página.
7. Registre limitações ou ressalvas explícitas.

METADADOS OBRIGATÓRIOS PARA CITAÇÃO
Para cada fonte, capture o máximo possível de:
- title (título completo da página ou do trabalho)
- authors (lista de autores; se não houver, use a instituição)
- year (ano de publicação ou de atualização; se não houver, "s.d.")
- institution (instituição, revista, museu, universidade etc.)
- url (obrigatório)

Esses campos serão usados depois para montar footnotes. Nunca deixe title ou url vazios se a página os contiver.

REGRAS CRÍTICAS
- 'Sem informação suficiente no conteúdo recuperado' NÃO significa 'não existe evidência sobre o assunto'.
- Uma página indisponível significa apenas que aquela URL não pôde ser analisada.
- Não transforme falha de acesso em inexistência de evidência.
- Não descarte uma fonte relevante apenas por não ser um artigo científico.
- Não invente metadados ausentes.
- Preserve números, datas, nomes e qualificadores da fonte.
- Separe claramente claim de interpretação do agente.
- EXIGÊNCIAS DE DENSIDADE FACTUAL:
  - Sempre que a página contiver, extraia e registre:
    • datas concretas (dia/mês/ano ou pelo menos ano);
    • números (vendas, streams, posições em charts, quantidades de shows, tiragens etc.);
    • nomes próprios de álbuns, singles, produtores, integrantes, gravadoras, prêmios;
    • citações textuais curtas (entre aspas) quando a fonte trouxer afirmações relevantes.
  - Prefira claims específicos e verificáveis a afirmações genéricas ("ascensão meteórica", "grande sucesso", "impacto nacional").
  - Se a página trouxer apenas generalidades, registre isso explicitamente em limitations e reduza o número de claims.

IMPORTANTE
Quando uma fonte contém evidência relevante, registre-a mesmo que seja secundária. A etapa posterior avaliará sua força.

SAÍDA EXCLUSIVA
{
  "sources": [
    {
      "id": "S1",
      "url": "https://...",
      "title": "...",
      "authors": ["..."],
      "year": "...",
      "institution": "...",
      "source_type": "academic",
      "relevant": true,
      "access_status": "ok",
      "summary": "...",
      "claims": [
        {
          "text": "...",
          "evidence": "..."
        }
      ],
      "limitations": ["..."]
    }
  ]
}

Valores permitidos para access_status: ok, unavailable, insufficient.
Valores permitidos para source_type: academic, institutional, governmental, museum_archive, reference, secondary, news, other.`,
    transform: (previous) =>
      `FONTES RECUPERADAS:\n${previous.content}\n\nAnalise cada fonte usando a ferramenta de obtenção de conteúdo.`,
    tools: pickAll(),
    toolHandlers: ALL_HANDLERS,
    format: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              url: { type: "string" },
              title: { type: "string" },
              authors: { type: "array", items: { type: "string" } },
              year: { type: "string" },
              institution: { type: "string" },
              source_type: { type: "string" },
              relevant: { type: "boolean" },
              access_status: { type: "string" },
              summary: { type: "string" },
              claims: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    evidence: { type: "string" },
                  },
                  required: ["text", "evidence"],
                },
              },
              limitations: { type: "array", items: { type: "string" } },
            },
            required: [
              "id",
              "url",
              "title",
              "authors",
              "year",
              "institution",
              "source_type",
              "relevant",
              "access_status",
              "summary",
              "claims",
              "limitations",
            ],
          },
        },
      },
      required: ["sources"],
    },
    maxIterations: 24,
    onThinking: gray,
    onToolCall,
    onToolResult,
    think: true,
  })
  // ============================================================
  // 4. RECUPERAÇÃO ADAPTATIVA
  // ============================================================
  .then({
    model: "gemma4:31b-cloud",
    system: `Você é um agente de recuperação adaptativa.

PERGUNTA
"${query}"

OBJETIVO
Garantir que a pesquisa não seja encerrada prematuramente por causa de uma coleta incompleta.

VOCÊ RECEBERÁ
Um inventário de fontes já analisadas.

TAREFA
1. Examine quais partes da pergunta já possuem evidência.
2. Identifique lacunas de cobertura.
3. Identifique fontes que falharam no acesso.
4. Identifique claims importantes apoiados por apenas uma fonte quando uma confirmação independente seria plausível.
5. Gere novas buscas para cobrir as lacunas.
6. Use a ferramenta de busca para pesquisar e, para novas URLs promissoras, use a ferramenta de obtenção de conteúdo.
7. Adicione as novas fontes ao inventário.

REGRAS
- Não repita URLs já analisadas com sucesso.
- Não descarte as fontes anteriores.
- Não transforme ausência de dados numa conclusão.
- Não faça buscas infinitas: concentre-se nas lacunas mais importantes.
- Uma pesquisa é 'insuficiente' somente quando ainda falta suporte relevante depois desta etapa de recuperação.
- Se o conjunto já for bom, apenas preserve-o e não invente lacunas artificiais.
- Ao identificar lacunas, priorize a busca por dados quantitativos, datas precisas, discografias, charts e fontes primárias ou institucionais.
- Se o inventário atual estiver dominado por afirmações genéricas, trate isso como lacuna de densidade factual e gere consultas específicas para números, datas e nomes de obras.

CRITÉRIO
Tente finalizar com pelo menos 5 fontes relevantes e 8 claims factuais, quando o tema permitir. Se o tema não permitir, mantenha todas as evidências válidas encontradas e registre a limitação.

SAÍDA EXCLUSIVA
Retorne o inventário consolidado, incluindo fontes antigas e novas, no mesmo formato do estágio anterior.`,
    transform: (previous) =>
      `INVENTÁRIO DE EVIDÊNCIAS:\n${previous.content}\n\nFaça uma auditoria de cobertura e recupere as lacunas relevantes.`,
    tools: pickAll(),
    toolHandlers: ALL_HANDLERS,
    format: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              url: { type: "string" },
              title: { type: "string" },
              authors: { type: "array", items: { type: "string" } },
              year: { type: "string" },
              institution: { type: "string" },
              source_type: { type: "string" },
              relevant: { type: "boolean" },
              access_status: { type: "string" },
              summary: { type: "string" },
              claims: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    evidence: { type: "string" },
                  },
                  required: ["text", "evidence"],
                },
              },
              limitations: { type: "array", items: { type: "string" } },
            },
            required: [
              "id",
              "url",
              "title",
              "authors",
              "year",
              "institution",
              "source_type",
              "relevant",
              "access_status",
              "summary",
              "claims",
              "limitations",
            ],
          },
        },
      },
      required: ["sources"],
    },
    maxIterations: 16,
    onThinking: gray,
    onToolCall,
    onToolResult,
    think: true,
  })
  // ============================================================
  // 5. SÍNTESE CRÍTICA
  // ============================================================
  .then({
    model: "gemma4:31b-cloud",
    system:
      `Você é um pesquisador responsável pela síntese crítica das evidências.

PERGUNTA
"${query}"

OBJETIVO
Construir uma síntese fiel às fontes, mostrando o que pode ser afirmado, com que força, onde há convergência, onde há divergência e onde ainda há incerteza.

PROCEDIMENTO
1. Agrupe claims equivalentes.
2. Associe cada finding às fontes que realmente o sustentam.
3. Diferencie fontes independentes de fontes que provavelmente repetem a mesma informação.
4. Identifique consensos e controvérsias.
5. Identifique lacunas reais.
6. Distinga evidência direta de inferência histórica ou interpretativa.
7. Nunca use 'ausência de evidência' para concluir 'evidência de ausência'.

CLASSIFICAÇÃO OBRIGATÓRIA DE CADA FINDING
Para cada finding, além de support, classifique:
- evidence_type: "primary" | "secondary" | "tertiary"
- nature: "quantitative" | "qualitative" | "mixed"
- independence: "independent" | "likely_derivative" | "unknown"

Evite findings que sejam apenas reformulações genéricas. Prefira claims que contenham data, número, nome próprio ou citação atribuível.

FORÇA DO SUPORTE
Use high, medium, low ou uncertain.
Considere qualidade aparente, natureza da fonte, consistência e independência das fontes, sem inventar critérios não disponíveis.

REGRA FUNDAMENTAL
Se existirem fontes relevantes e claims sustentados, a saída NÃO PODE declarar que 'não existem evidências' apenas porque não existe uma resposta definitiva.
Uma conclusão aceitável pode ser: 'as evidências disponíveis situam X em determinado período, mas não permitem estabelecer um ponto único de origem'.

Mantenha os IDs originais das fontes (S1, S2…). Eles serão convertidos em footnotes na redação.

SAÍDA EXCLUSIVA
{
  "research_question": "...",
  "overall_assessment": "...",
  "findings": [
    {
      "claim": "...",
      "sources": ["S1", "S2"],
      "support": "high",
      "basis": "..."
    }
  ],
  "consensus": ["..."],
  "controversies": ["..."],
  "uncertainties": ["..."],
  "gaps": ["..."]
}`,
    transform: (previous) =>
      `INVENTÁRIO CONSOLIDADO:\n${previous.content}\n\nProduza agora a síntese crítica.`,
    tools: [],
    toolHandlers: ALL_HANDLERS,
    format: {
      type: "object",
      properties: {
        research_question: { type: "string" },
        overall_assessment: { type: "string" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string", description: "afirmação específica, preferencialmente com data, número ou nome próprio" },
              sources: { type: "array", items: { type: "string" } },
              support: { type: "string" },
              basis: { type: "string" },
              evidence_type: { type: "string", enum: ["primary", "secondary", "tertiary"] },
              nature: { type: "string", enum: ["quantitative", "qualitative", "mixed"] },
              independence: { type: "string", enum: ["independent", "likely_derivative", "unknown"] },
            },
            required: ["claim", "sources", "support", "basis", "evidence_type", "nature", "independence"],
          },
        },
        consensus: { type: "array", items: { type: "string" } },
        controversies: { type: "array", items: { type: "string" } },
        uncertainties: { type: "array", items: { type: "string" } },
        gaps: { type: "array", items: { type: "string" } },
      },
      required: [
        "research_question",
        "overall_assessment",
        "findings",
        "consensus",
        "controversies",
        "uncertainties",
        "gaps",
      ],
    },
    maxIterations: 4,
    onThinking: gray,
    onToolCall,
    onToolResult,
    think: true,
  })
  // ============================================================
  // 6. REDAÇÃO ACADÊMICA
  // ============================================================
  .then({
    model: "gemma4:31b-cloud",
    system: `Você é um redator acadêmico especializado em revisão bibliográfica.

PERGUNTA DE PESQUISA
"${query}"

TIPO DE ARTIGO
Artigo acadêmico de revisão bibliográfica exploratória baseado nas fontes efetivamente recuperadas pelo pipeline.

IMPORTANTE SOBRE A METODOLOGIA
Não chame a pesquisa de 'revisão sistemática' a menos que um protocolo sistemático tenha sido explicitamente executado. Descreva honestamente que a pesquisa utilizou buscas na web, seleção de fontes, extração de conteúdo e síntese crítica.

ESTRUTURA
# Título

## Resumo
Inclua: objetivo, abordagem, principais achados e conclusão.

## Palavras-chave
3 a 6 termos.

## 1. Introdução
Contextualização, problema, pergunta, relevância e objetivo.

## 2. Metodologia
Descreva somente o que realmente ocorreu no pipeline:
- elaboração de consultas;
- buscas na web;
- seleção e curadoria de URLs;
- leitura das páginas recuperadas;
- extração de claims/evidências;
- recuperação adaptativa de lacunas;
- síntese crítica.
Não invente bases de dados, períodos, amostras, critérios estatísticos ou protocolos que não existiram.

## 3. Resultados
Apresente os principais achados em ordem temática. Esta é a seção central e deve conter conteúdo factual substantivo.

## 4. Discussão
Compare os achados, trate convergências, divergências, limitações e grau de certeza.

## 5. Conclusão
Responda diretamente à pergunta. Uma conclusão pode ser parcial ou condicional; não transforme uma limitação em desconhecimento absoluto.

CITAÇÕES NO TEXTO (FORMATO OBRIGATÓRIO)
Use exclusivamente o formato de footnote Markdown:
- No corpo do texto: ... afirmação[^S1]. ou ... afirmação[^S1][^S3].
- Nunca use [S1] entre colchetes simples.
- Nunca invente números de footnote. Use exatamente os IDs das fontes (S1, S2, S3…).

REFERÊNCIAS / FOOTNOTES
No final do artigo, após a Conclusão, coloque a seção de footnotes no formato Markdown puro, uma linha por fonte, assim:

[^S1]: Autor(es) ou Instituição. Título completo. Ano. URL
[^S2]: Autor(es) ou Instituição. Título completo. Ano. URL

Regras para o conteúdo de cada footnote:
1. Use os metadados reais extraídos (title, authors, year, institution, url).
2. Se faltar autor, comece pela institution.
3. Se faltar ano, use "s.d.".
4. Sempre termine com a URL completa.
5. Nunca escreva "Título/Instituição não disponível". Se o dado realmente não existir, omita apenas aquele campo e mantenha os demais.
6. Não crie uma seção "## Referências" separada. As footnotes já são as referências.

REGRAS DE CONTEÚDO
1. A seção Resultados não pode ficar vazia se a síntese contiver findings.
2. Não diga 'não existem fontes' se existirem fontes recuperadas.
3. Não diga 'não existem evidências' quando o conjunto possuir claims sustentados; nesse caso explique o que as evidências mostram e qual é a limitação.
4. Não extrapole além das fontes.
5. Não invente fatos.
6. Não invente referências.
7. Não transforme uma fonte secundária em evidência primária.
8. Não substitua fatos por generalidades introdutórias.
9. Preserve números, datas, lugares, nomes e processos quando suportados pelas fontes.
10. Evite preencher espaço com prosa genérica.
11. A seção Resultados deve privilegiar densidade factual. Inclua o máximo possível de:
    - datas concretas;
    - números (vendas, streams, posições, quantidades);
    - nomes de obras, pessoas, instituições e eventos;
    - citações curtas entre aspas quando suportadas pelas fontes.
12. Evite frases abstratas ou retóricas do tipo "ascensão meteórica", "estratégia comercial agressiva", "marco da música nordestina" sem que imediatamente em seguida apareça o dado ou a fonte que as sustenta.
13. Se um finding da síntese for genérico, reformule-o na redação de forma mais precisa ou rebaixe seu peso, em vez de amplificá-lo com linguagem enfeitada.
14. Todas as citações no texto devem estar no formato [^S1], [^S2] etc.
15. Todas as fontes utilizadas devem aparecer como footnotes no final do documento, no formato Markdown padrão de footnotes.

CRITÉRIO DE QUALIDADE
Priorize substância factual sobre fluência retórica. Um parágrafo com três dados concretos é preferível a um parágrafo eloquente sem números, datas ou nomes próprios. O artigo deve responder à pergunta usando a maior quantidade possível de conteúdo factual sustentado pelo inventário e pela síntese, mantendo linguagem acadêmica.

SALVE O TEXTO COMPLETO COM file_write EM:
"${OUTPUT_FILE}"

RETORNE EXCLUSIVAMENTE:
{
  "path": "${OUTPUT_FILE}",
  "ok": true
}`,
    transform: (previous) =>
      `SÍNTESE DE EVIDÊNCIAS:\n${previous.content}\n\nRedija o artigo acadêmico completo. Preserve os findings e seus IDs de fonte.`,
    tools: pick("file_write"),
    toolHandlers: ALL_HANDLERS,
    format: {
      type: "object",
      properties: {
        path: { type: "string" },
        ok: { type: "boolean" },
      },
      required: ["path", "ok"],
    },
    maxIterations: 6,
    onThinking: gray,
    onToolCall,
    onToolResult,
    think: true,
  })
  // ============================================================
  // 7. REVISÃO ACADÊMICA
  // ============================================================
  .then({
    model: "gpt-oss:20b-cloud",
    system: `Você é o revisor final de um artigo acadêmico.

ARQUIVO
Leia primeiro:
"${OUTPUT_FILE}"

OBJETIVO
Melhorar o texto sem empobrecê-lo.

VERIFIQUE
- gramática e ortografia;
- clareza e precisão;
- estrutura acadêmica;
- coerência entre resultados e conclusão;
- presença de conteúdo factual na seção de resultados;
- consistência dos IDs [S1], [S2] etc.;
- correspondência entre citações e referências;
- ausência de afirmações mais fortes que as evidências;
- ausência de metodologia inventada;
- se todas as citações estão no formato de footnote Markdown ([^S1], [^S2]…);
- se existe a definição correspondente no final do arquivo para cada footnote usada;
- se nenhuma referência aparece como "Título/Instituição não disponível";
- se as footnotes contêm pelo menos título + URL (e autor/ano quando disponíveis).

REGRAS
1. Não faça novas pesquisas.
2. Não adicione fatos externos.
3. Não remova dados factuais apenas para encurtar o artigo.
4. Não substitua resultados substantivos por generalidades.
5. Se o artigo afirmar que não há evidência, verifique se isso é realmente compatível com as fontes apresentadas no próprio texto. Se houver fontes e claims, prefira uma formulação proporcional como 'as fontes recuperadas indicam...' ou 'as evidências não permitem estabelecer...'.
6. Preserve todas as referências válidas.
7. Corrija apenas problemas de conteúdo que possam ser resolvidos usando o próprio artigo; caso contrário, mantenha a formulação cautelosa.
8. Se encontrar citações no formato antigo [S1], converta-as para [^S1] e garanta que a footnote correspondente exista no final.
9. Se alguma footnote estiver com texto genérico ("não disponível"), reescreva-a com os melhores metadados possíveis presentes no próprio artigo ou deixe apenas os campos existentes + URL.

SALVE SOBRE O MESMO ARQUIVO
"${OUTPUT_FILE}"

SAÍDA EXCLUSIVA
{
  "revised": true,
  "path": "${OUTPUT_FILE}"
}`,
    transform: (previous) =>
      `ARTIGO GERADO EM:\n${OUTPUT_FILE}\n\nLEIA O ARQUIVO, REVISE E SOBRESCREVA COM A VERSÃO FINAL.`,
    tools: pick("file_read", "file_write"),
    toolHandlers: ALL_HANDLERS,
    format: {
      type: "object",
      properties: {
        revised: { type: "boolean" },
        path: { type: "string" },
      },
      required: ["revised", "path"],
    },
    maxIterations: 7,
    think: "max",
    onThinking: gray,
    onToolCall,
    onToolResult,
  })
  .execute();

console.log(`\n✅ Pesquisa concluída.`);
console.log(`📄 Artigo final: ${OUTPUT_FILE}`);
console.log(`🔧 Chamadas de ferramentas: ${totalToolCalls}`);
console.log("\nResumo dos estágios:");

results.forEach((result, index) => {
  console.log(
    `  Estágio ${index + 1}: ` +
      `${result.inputTokens}/${result.outputTokens} tokens, ` +
      `${result.toolCalls.length} chamadas de ferramentas`,
  );
});

await mcpBridge.close();
