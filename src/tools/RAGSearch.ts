import type { RAG } from "../memories/rag.ts";
import type { ToolDefinition, ToolHandler } from "../ollamaTask.ts";

export interface RAGSearchResult {
  results: {
    content: string;
    source: string | null;
    title: string | null;
    score: number;
  }[];
}

export interface RAGSearchToolOptions {
  k?: number;
}

export function RAGSearchTool(
  rag: RAG,
  options: RAGSearchToolOptions = {},
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
    execute: async (args): Promise<RAGSearchResult> => {
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
