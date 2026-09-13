/**
 * Camada de tradução entre o stream real do SDK (OpenAI Responses API) e os
 * eventos do harness (spec §4, com os nomes reais de delta).
 *
 * Mapeamento (spec → real):
 *   thinking            → `response.reasoning_summary_text.delta`
 *                           (alguns modelos expõem `response.reasoning_text.delta`)
 *   thinking.end        → `response.reasoning_summary_text.done` (ou `reasoning_text.done`)
 *   content             → `response.output_text.delta`
 *   content.end         → `response.output_text.done`
 *   chamada de tool     → `response.output_item.added/.done` (item `function_call`)
 *                         + `response.function_call_arguments.delta` (acúmulo por `output_index`)
 *   métricas de tokens  → `response.completed` (`response.usage`)
 *
 * Esta função é pura: não faz rede, apenas consome um iterável de eventos.
 *
 * @module events
 */
import type { Responses } from "openai/resources/responses";
import type { AgentEvent, TokenUsage, ToolCall } from "./types.ts";

/**
 * Mapeia `ResponseUsage` do SDK para `TokenUsage` do harness.
 *
 * Campos ausentes ou `null`/`undefined` viram `0` no resultado; `totalTokens`
 * cai sobre o total informado ou na soma `input + output`.
 *
 * @param usage Uso retornado em `response.completed` (pode ser nulo).
 * @returns Uso normalizado, ou `null` quando a entrada é nula/indefinida.
 * @example
 * ```ts
 * const usage = mapUsage({ input_tokens: 10, output_tokens: 5 });
 * // { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
 * ```
 */
export function mapUsage(
  usage: Responses.ResponseUsage | null | undefined,
): TokenUsage | null {
  if (!usage) return null;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

/**
 * Resumo do processamento de um round completo (o valor de retorno do gerador).
 *
 * `items` reúne tudo que o round produziu e **precisa voltar ao histórico**
 * (messages, reasoning e function_call) para o próximo round enxergar o que
 * o modelo já raciocinou/callou.
 *
 * @example
 * ```ts
 * const outcome = await firstValueFrom(mapper);
 * // outcome = {
 * //   reasoning: "Passo 1...", content: "", items: [...], calls: [...],
 * //   usage: { inputTokens: 120, outputTokens: 34, totalTokens: 154 },
 * //   aborted: false, errored: null,
 * // }
 * ```
 */
export interface RoundOutcome {
  /** Texto de raciocínio acumulado no round (stream). */
  reasoning: string;
  /** Texto de resposta acumulado no round (stream). */
  content: string;
  /** Itens emitidos (mensagem/function_call/reasoning) — para reencaminhar no próximo round. */
  items: Responses.ResponseOutputItem[];
  /** Chamadas de ferramenta detectadas (item `function_call` finalizado). */
  calls: ToolCall[];
  /** Uso de tokens do round (null quando o evento `response.completed` não veio). */
  usage: TokenUsage | null;
  /** `true` quando o stream terminou por abort (`signal.aborted`). */
  aborted: boolean;
  /** Erro de stream (evento `error`/`response.failed`/`response.incomplete`). */
  errored: unknown;
}

/**
 * Consome o stream de eventos do SDK e emite `AgentEvent` em tempo real,
 * devolvendo o `RoundOutcome` ao final. Gerador assíncrono: pausa a cada
 * `yield` para o consumidor reagir ao delta e só avança quando pedido.
 *
 * Falhas de stream são capturadas e reportadas em `errored` — nunca lançam:
 * o consumidor decide o que fazer (o harness transforma em `error` event).
 *
 * @param stream Iterável real do SDK (ex.: retorno de `client.responses.create`).
 * @param signal AbortSignal opcional: quando disparado, o stream para de
 *               consumir no próximo evento e o round vira `aborted: true`.
 * @returns Yield de `AgentEvent` enquanto o stream corre; no `return`
 *          entrega o `RoundOutcome` consolidado.
 * @example
 * ```ts
 * const mapper = mapResponseStream(stream);
 * const events: AgentEvent[] = [];
 * let outcome: RoundOutcome;
 * for (;;) {
 *   const { done, value } = await mapper.next();
 *   if (done) {
 *     outcome = value; // RoundOutcome consolidado
 *     break;
 *   }
 *   if (value.type === "tool_call") {
 *     events.push(value); // o modelo pediu uma ferramenta
 *   }
 * }
 * // outcome.usage / outcome.calls / outcome.items para o próximo round
 * ```
 */
export async function* mapResponseStream(
  stream: AsyncIterable<Responses.ResponseStreamEvent>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, RoundOutcome, void> {
  let reasoning = "";
  let content = "";
  const items: Responses.ResponseOutputItem[] = [];
  const calls: ToolCall[] = [];
  // Acúmulo de argumentos por output_index (as deltas chegam picadas).
  const pendingArgs = new Map<number, string>();
  let usage: TokenUsage | null = null;
  let errored: unknown = null;

  const aborted = (): boolean => signal?.aborted === true;

  try {
    for await (const event of stream) {
      if (aborted()) break;

      switch (event.type) {
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          reasoning += event.delta;
          yield { type: "reasoning", token: event.delta };
          break;

        case "response.reasoning_summary_text.done":
        case "response.reasoning_text.done":
          yield { type: "reasoning.done" };
          break;

        case "response.output_text.delta":
          content += event.delta;
          yield { type: "content", token: event.delta };
          break;

        case "response.output_text.done":
          yield { type: "content.done" };
          break;

        case "response.output_item.added":
          if (event.item.type === "function_call") {
            pendingArgs.set(event.output_index, event.item.arguments ?? "");
          }
          break;

        case "response.function_call_arguments.delta":
          pendingArgs.set(
            event.output_index,
            (pendingArgs.get(event.output_index) ?? "") + event.delta,
          );
          break;

        case "response.output_item.done":
          items.push(event.item);
          if (event.item.type === "function_call") {
            const call: ToolCall = {
              id: event.item.id ?? "",
              call_id: event.item.call_id,
              name: event.item.name,
              args: event.item.arguments ??
                pendingArgs.get(event.output_index) ?? "",
            };
            calls.push(call);
            yield { type: "tool_call", tool: call.name, args: call.args };
          }
          break;

        case "response.completed":
          usage = mapUsage(event.response.usage);
          break;

        case "error":
          errored = event;
          break;

        case "response.failed":
        case "response.incomplete":
          errored = event;
          break;
      }
    }
  } catch (cause) {
    errored = aborted() ? null : cause;
  }

  return {
    reasoning,
    content,
    items,
    calls,
    usage,
    aborted: aborted(),
    errored,
  };
}
