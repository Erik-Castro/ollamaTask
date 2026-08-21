import type { RAG } from "./memories/rag.ts";
import type { SearchHit } from "./memories/store.ts";
import type { ToolDefinition, ToolHandler } from "./ollamaTask.ts";

export interface RAGConfig {
  rag: RAG;
  k?: number;
  systemPrompt?: string;
  autoIndex?: boolean;
  minScore?: number;
}

export interface RAGSearchOptions {
  k?: number;
}

export async function searchContext(
  rag: RAG,
  query: string,
  options: RAGSearchOptions = {},
): Promise<string> {
  const hits = await rag.search(query, { k: options.k ?? 5 });
  if (hits.length === 0) return "";
  return formatContext(hits);
}

export function formatContext(hits: SearchHit[]): string {
  return hits
    .map(
      (hit, i) =>
        `[${i + 1}] (fonte: ${
          hit.title ?? hit.source ?? "desconhecida"
        })\n${hit.content}`,
    )
    .join("\n\n---\n\n");
}

export function createRAGTool(
  rag: RAG,
  options: RAGSearchOptions = {},
): { definition: ToolDefinition; handler: ToolHandler } {
  const k = options.k ?? 5;

  const definition: ToolDefinition = {
    type: "function",
    function: {
      name: "rag_search",
      description:
        "Busca documentos relevantes no banco de conhecimento vetorial. Use quando precisar encontrar informações específicas antes de responder.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Termos de busca para encontrar documentos relevantes",
          },
          k: {
            type: "number",
            description: `Número de resultados a retornar (padrão: ${k})`,
          },
        },
        required: ["query"],
      },
    },
  };

  const handler: ToolHandler = {
    name: "rag_search",
    execute: async (args) => {
      const query = args.query as string;
      const resultK = (args.k as number) ?? k;
      const hits = await rag.search(query, { k: resultK });
      return {
        results: hits.map((h) => ({
          content: h.content,
          source: h.source,
          title: h.title,
          score: h.score,
        })),
      };
    },
  };

  return { definition, handler };
}
