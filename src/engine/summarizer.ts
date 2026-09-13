/**
 * Poda de contexto por LLM (suggests.md §B completa): quando o histórico
 * estoura o limite, o prefixo mais antigo é condensado em um resumo factual
 * por uma chamada única de geração (sem ferramentas). Opt-in — sem
 * `ReActOptions.summarizer`, o harness mantém a poda determinística.
 */
import type { Responses } from "openai/resources/responses";
import type { ResponsesCall } from "./react.ts";

/**
 * Prompt interno do sumarizador (o resumo volta ao contexto do agente).
 * Prioriza dados ainda acionáveis: resultados de ferramentas, IDs, valores,
 * timestamps, restrições do usuário e tarefas abertas.
 */
export const SUMMARIZER_INSTRUCTIONS =
  "You condense an old agent conversation into a short factual summary.\n" +
  "Keep every fact that is still actionable: tool names and their results, IDs, " +
  "names, numbers, timestamps, user constraints and preferences, and open tasks.\n" +
  "Output a compact paragraph of 3-8 sentences. Do not omit actionable data.";

/** Entrada para uma chamada de sumarização. */
export interface SummarizeContext {
  messages: Responses.ResponseInputItem[];
  instructions: string;
  model: string;
  signal: AbortSignal;
}

/** Condensa o prefixo do histórico. Retorna "" para indicar "não resumir". */
export type Summarizer = (context: SummarizeContext) => Promise<string>;

/**
 * Implementação default: reusa o provider do harness (round único, sem tools)
 * e coleta o texto final do stream. Compartilha o AbortSignal para que
 * `cancel()` encerre também a sumarização.
 */
export function createLLMSummarizer(responses: ResponsesCall): Summarizer {
  return async ({ messages, model, signal }) => {
    const stream = await responses({
      model,
      instructions: SUMMARIZER_INSTRUCTIONS,
      input: messages,
      tools: [],
      signal,
    });
    let text = "";
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        text += event.delta;
      }
    }
    return text.trim();
  };
}
