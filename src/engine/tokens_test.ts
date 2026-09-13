/**
 * Testes da medição de tokens (src/tokens.ts) — puros, offline.
 */
import { assertEquals } from "@std/assert";
import { estimateTokens } from "./tokens.ts";

Deno.test("tokens: estimativa para texto vazio é 0", () => {
  assertEquals(estimateTokens(""), 0);
});

Deno.test("tokens: heurística ~4 chars por token com teto", () => {
  assertEquals(estimateTokens("a".repeat(4)), 1);
  assertEquals(estimateTokens("a".repeat(5)), 2); // ceil(5/4)
  assertEquals(estimateTokens("a".repeat(10_000)), 2500);
});

Deno.test("tokens: texto real em pt-BR", () => {
  const text = "O usuário pediu para somar 3 + 4 e o modelo devolveu 7.";
  const estimated = estimateTokens(text);
  assertEquals(estimated, Math.ceil(text.length / 4));
  assertEquals(estimated > 0, true);
});
