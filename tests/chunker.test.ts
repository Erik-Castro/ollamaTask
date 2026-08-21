import { chunkText } from "../src/memories/chunker.ts";
import { assert, assertEquals } from "@std/assert";

Deno.test("chunkText returns empty for empty input", () => {
  assertEquals(chunkText(""), []);
  assertEquals(chunkText("   "), []);
});

Deno.test("chunkText single paragraph returns one chunk", () => {
  const result = chunkText("Texto curto.", { maxChars: 200 });
  assertEquals(result.length, 1);
  assertEquals(result[0].index, 0);
  assert(result[0].content.includes("Texto curto."));
});

Deno.test("chunkText splits long text into multiple chunks", () => {
  const paragraphs = Array.from(
    { length: 15 },
    (_, i) =>
      `Parágrafo ${i + 1} com conteúdo relevante sobre o tema abordado.`,
  );
  const text = paragraphs.join("\n\n");
  const result = chunkText(text, { maxChars: 120, overlapChars: 30 });
  assert(
    result.length > 1,
    `Esperado mais de 1 chunk, obtido ${result.length}`,
  );
  for (const chunk of result) {
    assert(chunk.index >= 0);
    assert(
      chunk.content.length <= 120 + 50,
      `Chunk ${chunk.index} excedeu tamanho: ${chunk.content.length}`,
    );
  }
});

Deno.test("chunkText creates new chunk on heading", () => {
  const intro = "Intro.".padEnd(60, " x");
  const contentA = "Conteúdo A.".padEnd(60, " y");
  const contentB = "Conteúdo B.".padEnd(60, " z");
  const text =
    `${intro}\n\n## Título A\n\n${contentA}\n\n## Título B\n\n${contentB}`;
  const result = chunkText(text, { maxChars: 100, overlapChars: 20 });
  assert(
    result.length >= 2,
    `Esperado chunks separados por heading, obtido ${result.length}`,
  );
  assert(result.some((c) => c.content.includes("Título A")));
  assert(result.some((c) => c.content.includes("Título B")));
});

Deno.test("chunkText overlap seeds next chunk with tail of previous", () => {
  const sentences = Array.from(
    { length: 20 },
    (_, i) =>
      `Sentença ${
        String(i).padStart(2, "0")
      } com palavras suficientes para ocupar espaço.`,
  );
  const text = sentences.join(" ");
  const result = chunkText(text, { maxChars: 150, overlapChars: 40 });
  if (result.length >= 2) {
    const prevEnd = result[0].content.slice(-50).toLowerCase();
    const nextStart = result[1].content.slice(0, 50).toLowerCase();
    const overlapFound = prevEnd.split(/\s+/).some((word) =>
      word.length > 3 && nextStart.includes(word)
    );
    assert(overlapFound, `Overlap não detectado entre chunks 0 e 1`);
  }
});

Deno.test("chunkText hard-splits oversized line without spaces", () => {
  const huge = "x".repeat(500);
  const result = chunkText(huge, { maxChars: 200, overlapChars: 40 });
  assert(
    result.length >= 2,
    `Texto sem espaços deveria ser hard-splitado em múltiplos chunks`,
  );
  for (const chunk of result) {
    assert(chunk.content.length <= 200 + 50);
  }
});
