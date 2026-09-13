/**
 * Configuração de ambiente (spec §2) com fallbacks locais e validação por
 * **Zod** (schemas tipados com coersão; mensagens de erro estruturais).
 *
 * As variáveis lidas são:
 * - `OPENAI_BASE_URL`    — URL base da API compatível com a OpenAI (default: `http://localhost:11434/v1`)
 * - `OPENAI_API_KEY`     — chave de API (default: `ollama`, o valor que o Ollama aceita)
 * - `OPENAI_MAX_RETRIES` — tentativas do cliente HTTP (default: `5`, inteiro >= 0)
 *
 * Valores ausentes ou em branco caem no default; valores inválidos lançam
 * erro com os issues do Zod.
 *
 * @module config
 */
import { z } from "zod";

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_API_KEY = "ollama";
const DEFAULT_MAX_RETRIES = 5;

/** Schema de env: campos opcionais (ausente/vazio → default no código). */
const envSchema = z.object({
  OPENAI_BASE_URL: z
    .string()
    .url()
    .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
      message: "deve usar http/https",
    })
    .optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MAX_RETRIES: z.coerce.number().int().nonnegative().optional(),
});

/**
 * Configuração do runtime derivada do ambiente.
 *
 * Consumida por {@link createClient} para montar o cliente OpenAI.
 *
 * @example
 * ```ts
 * const config: RuntimeConfig = {
 *   baseURL: "http://localhost:11434/v1",
 *   apiKey: "ollama",
 *   maxRetries: 5,
 * };
 * ```
 */
export interface RuntimeConfig {
  /** URL base da API (ex.: `http://localhost:11434/v1` do Ollama). */
  baseURL: string;
  /** Chave de API. O Ollama aceita qualquer valor, por isso o default é `ollama`. */
  apiKey: string;
  /** Número de tentativas do cliente HTTP diante de falhas transientes. */
  maxRetries: number;
}

/**
 * Lê e valida as variáveis de ambiente via Zod.
 * Aceita um objeto de env injetado para testes (default: `Deno.env`).
 *
 * Validações aplicadas:
 * - `OPENAI_BASE_URL` precisa ser uma URL `http`/`https` válida.
 * - `OPENAI_API_KEY` não vazia (trim).
 * - `OPENAI_MAX_RETRIES` inteiro >= 0 (coerção; não-numérico lança erro).
 *
 * @param env Mapa de variáveis de ambiente. Omita para usar `Deno.env`.
 * @returns Configuração validada pronta para o cliente.
 * @throws {Error} Com os issues do Zod quando alguma variável for inválida.
 * @example Como usar com o cliente (sem injeção, usa `Deno.env`):
 * ```ts
 * import { loadRuntimeConfig } from "./src/config.ts";
 * const runtime = loadRuntimeConfig();
 * console.log(runtime.baseURL); // "http://localhost:11434/v1" (default)
 * ```
 *
 * @example Teste com env injetado:
 * ```ts
 * const config = loadRuntimeConfig({
 *   OPENAI_BASE_URL: "https://api.openai.com/v1",
 *   OPENAI_API_KEY: "sk-...",
 *   OPENAI_MAX_RETRIES: "2",
 * });
 * assertEquals(config.maxRetries, 2);
 * ```
 */
export function loadRuntimeConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): RuntimeConfig {
  const normalized: Record<string, string | undefined> = {
    OPENAI_BASE_URL: env.OPENAI_BASE_URL?.trim() || undefined,
    OPENAI_API_KEY: env.OPENAI_API_KEY?.trim() || undefined,
    OPENAI_MAX_RETRIES: env.OPENAI_MAX_RETRIES?.trim() || undefined,
  };

  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((issue) => {
        const key = issue.path.join(".") || "env";
        return `${key}: ${issue.message}`;
      })
      .join("; ");
    throw new Error(`Configuração inválida: ${messages}`);
  }

  return {
    baseURL: parsed.data.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: parsed.data.OPENAI_API_KEY ?? DEFAULT_API_KEY,
    maxRetries: parsed.data.OPENAI_MAX_RETRIES ?? DEFAULT_MAX_RETRIES,
  };
}
