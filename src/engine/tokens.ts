/**
 * Medição de tokens para o trigger de contexto por tokens (suggests.md §B).
 *
 * A spec pede que o harness condense o histórico quando `_messages` passar
 * de ~80% da janela do modelo. Sem tokenizador offline, o harness usa duas
 * camadas complementares:
 *
 * 1. **Medição real**: o `usage.input_tokens` que o provider reporta no
 *    `response.completed` — contagem exata do que foi enviado no round
 *    anterior (melhor que qualquer tokenizador local).
 * 2. **Estimativa heurística**: quando o provider não reporta uso
 *    (ou no primeiro round), `estimateTokens()` aproxima por ~4 chars/token
 *    para texto latino.
 *
 * A estimativa é determinística e testável; o desvio é documentado no
 * AGENTS.md (system prompt e tools não entram na estimativa).
 *
 * @module tokens
 */

/**
 * Estima a quantidade de tokens de um texto sem tokenizador.
 *
 * Aproximação para texto latino: `ceil(caracteres / 4)`. Em média 1 token ≈
 * 4 caracteres em português/inglês; o erro é aceitável para um *trigger* de
 * contexto (80% da janela) e o provider sempre corrige com o uso real.
 *
 * @param text Texto a medir (pode ser vazio).
 * @returns Número estimado de tokens (>= 0).
 * @example
 * ```ts
 * estimateTokens("Olá mundo");        // ≈ 3 (11 chars / 4)
 * estimateTokens("");                 // 0
 * estimateTokens("a".repeat(10_000)); // 2500
 * ```
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Contrato de um medidor de tokens injetável.
 *
 * Permite plugar um tokenizador real (ex.: `tiktoken`) sem tocar no core.
 * O default do harness é {@link estimateTokens}.
 *
 * @param text Texto a medir.
 * @returns Quantidade de tokens.
 * @example
 * ```ts
 * const tokenizer: TokenEstimator = (text) => myTokenizer(text).length;
 * ```
 */
export type TokenEstimator = (text: string) => number;
