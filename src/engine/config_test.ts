/**
 * Testes da configuração de ambiente (src/config.ts) — offline, com env injetado.
 */
import { assertEquals, assertThrows } from "@std/assert";
import type { RuntimeConfig } from "./config.ts";
import { loadRuntimeConfig } from "./config.ts";

const openAI = {
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  OPENAI_API_KEY: "sk-secreta",
  OPENAI_MAX_RETRIES: "2",
};

Deno.test("loadRuntimeConfig: defaults quando env ausente/vazia", () => {
  const config = loadRuntimeConfig({});
  assertEquals(
    config,
    {
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
      maxRetries: 5,
    } satisfies RuntimeConfig,
  );
});

Deno.test("loadRuntimeConfig: valores válidos com trim", () => {
  const config = loadRuntimeConfig({
    OPENAI_BASE_URL: "  https://api.openai.com/v1  ",
    OPENAI_API_KEY: "  sk-secreta  ",
    OPENAI_MAX_RETRIES: " 3 ",
  });
  assertEquals(
    config,
    {
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-secreta",
      maxRetries: 3,
    } satisfies RuntimeConfig,
  );
});

Deno.test("loadRuntimeConfig: ignora variáveis extras", () => {
  const config = loadRuntimeConfig({ ...openAI, HOME: "/home/x" });
  assertEquals(config.maxRetries, 2);
});

Deno.test("loadRuntimeConfig: URL inválida lança erro com a chave", () => {
  const err = assertThrows(() =>
    loadRuntimeConfig({
      OPENAI_BASE_URL: "not-a-url",
      OPENAI_API_KEY: "k",
      OPENAI_MAX_RETRIES: "1",
    })
  );
  assertEquals(String(err).includes("OPENAI_BASE_URL"), true);
  assertEquals(String(err).includes("Configuração inválida"), true);
});

Deno.test("loadRuntimeConfig: URL não-http(s) lança erro", () => {
  assertThrows(() =>
    loadRuntimeConfig({
      OPENAI_BASE_URL: "ftp://localhost/v1",
      OPENAI_API_KEY: "k",
      OPENAI_MAX_RETRIES: "1",
    })
  );
});

Deno.test("loadRuntimeConfig: maxRetries não-numérico lança erro", () => {
  assertThrows(() =>
    loadRuntimeConfig({ ...openAI, OPENAI_MAX_RETRIES: "abc" })
  );
});

Deno.test("loadRuntimeConfig: maxRetries negativo lança erro", () => {
  assertThrows(() =>
    loadRuntimeConfig({ ...openAI, OPENAI_MAX_RETRIES: "-1" })
  );
});
