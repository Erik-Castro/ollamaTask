/**
 * Helpers dos testes de integração (tests/integration) — reutilizam o padrão
 * de `collect()` do react_test, agora contra o provider real (Ollama).
 */
import type { Responses } from "openai/resources/responses";
import {
  type AgentEvent,
  createClient,
  loadRuntimeConfig,
  type ResponsesCall,
  type TExecutionResult,
} from "../../src/engine/mod.ts";

/** Consome o gerador de eventos e devolve eventos + resultado final. */
export async function collect(
  gen: AsyncGenerator<AgentEvent, TExecutionResult, void>,
): Promise<{ events: AgentEvent[]; result: TExecutionResult }> {
  const events: AgentEvent[] = [];
  let result: TExecutionResult;
  for (;;) {
    const { value, done } = await gen.next();
    if (done) {
      result = value;
      break;
    }
    events.push(value);
  }
  return { events, result: result as TExecutionResult };
}

/**
 * Verifica se o Ollama está de pé e com o modelo pedido, com erro claro.
 * Rodada no início de cada teste para não falhar "no susto" no meio do E2E.
 */
export async function assertOllamaAvailable(model: string): Promise<void> {
  const baseURL = loadRuntimeConfig().baseURL;
  const origin = new URL(baseURL).origin;

  const version = await fetch(`${origin}/api/version`).catch(() => null);
  if (!version?.ok) {
    throw new Error(
      `Ollama indisponível em ${origin} (teste de integração). Saiu o servidor?`,
    );
  }

  const tags = await fetch(`${origin}/api/tags`).catch(() => null);
  const installed: string[] = tags?.ok
    ? (await tags.json() as { models?: { name: string }[] }).models?.map((m) =>
      m.name
    ) ?? []
    : [];
  if (!installed.includes(model)) {
    throw new Error(
      `Modelo "${model}" não encontrado no Ollama (${origin}). Instale ou defina OPENAI_MODEL.`,
    );
  }
}

/**
 * Wiring do provider real (mesmo do main.ts): cliente + ResponsesCall injetável.
 * Retorna um objeto pronto para passar a `new ReAct(agent, { responses })`.
 */
export function makeResponses(): ResponsesCall {
  const client = createClient(loadRuntimeConfig());
  return async (request) => {
    const stream = await client.responses.create(
      {
        model: request.model,
        instructions: request.instructions,
        input: request.input as unknown as Responses.ResponseInput,
        tools: request.tools,
        reasoning: request.reasoning ?? undefined,
        stream: true,
      },
      { signal: request.signal },
    );
    return stream;
  };
}
