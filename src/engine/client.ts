/**
 * Fábrica do cliente OpenAI (spec §2) — única dependência do projeto.
 * Comunica com APIs compatíveis com a OpenAI (ex.: Ollama em `/v1/responses`).
 *
 * O cliente é construído a partir de uma {@link RuntimeConfig} validada por
 * {@link loadRuntimeConfig} e só é usado como transporte default: o loop do
 * harness conversa com um provider injetável (`ResponsesCall`), o que
 * permite testes offline.
 *
 * @module client
 */
import OpenAI from "openai";
import type { RuntimeConfig } from "./config.ts";
export type { RuntimeConfig };

/**
 * Cria o cliente OpenAI/SDK para o runtime informado.
 *
 * @param config Configuração validada (veja {@link loadRuntimeConfig}).
 * @returns Cliente `OpenAI` pronto para `client.responses.create(...)`.
 * @example
 * ```ts
 * import { loadRuntimeConfig } from "./src/config.ts";
 * import { createClient } from "./src/client.ts";
 *
 * const client = createClient(loadRuntimeConfig());
 * const stream = await client.responses.create({
 *   model: "qwen3:4b",
 *   input: "Olá",
 *   stream: true,
 * });
 * ```
 */
export function createClient(config: RuntimeConfig): OpenAI {
  return new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    maxRetries: config.maxRetries,
  });
}
