import { RAG } from "../src/memories/rag.ts";
import { OpenAIProvider } from "../src/memories/providers/openai.ts";
import { assert, assertEquals } from "@std/assert";

Deno.test({
  name: "RAG pipeline with ollama provider",
  permissions: {
    net: true,
    read: true,
    write: true,
    env: true,
    sys: true,
    ffi: true,
  },
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      const rag = await RAG.create({
        dbPath: `${dir}/rag.db`,
        keyPath: `${dir}/.key`,
        vectorExtensionPath: "./bin/vector.so",
        provider: "ollama",
        maxChars: 300,
        overlapChars: 60,
        topK: 2,
      });
      using _ragRef = rag;
      await rag.ensureModel();

      const docId = await rag.addText(
        `## Criptografia
O banco de dados é protegido com SQLCipher. A chave é um arquivo de 16 bytes convertido em hexadecimal e aplicada via PRAGMA key.

## Embedding
O modelo nomic-embed-text gera vetores de 768 dimensões no formato Float32.

## Busca
A extensão sqlite-vector realiza busca KNN com distância cosine. A função vector_full_scan retorna os k vizinhos mais próximos.`,
        { title: "Sobre o projeto memories" },
      );
      assert(docId > 0);
      assertEquals(rag.chunkCount() > 0, true);

      const hits = await rag.search("como o banco é protegido");
      assertEquals(hits.length, 2);
      assert(
        hits[0].content.includes("criptografia") ||
          hits[0].content.includes("SQLCipher"),
        `Melhor hit deveria mencionar criptografia: ${
          hits[0].content.slice(0, 80)
        }`,
      );

      const result = await rag.query(
        "Quais modelos de embedding o projeto usa?",
      );
      assert(result.answer.length > 0, "Resposta não deveria ser vazia");
      assert(result.sources.length > 0, "Fontes não deveriam ser vazias");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "RAG pipeline with openai provider",
  permissions: {
    net: true,
    read: true,
    write: true,
    env: true,
    sys: true,
    ffi: true,
  },
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      const rag = await RAG.create({
        dbPath: `${dir}/rag.db`,
        keyPath: `${dir}/.key`,
        vectorExtensionPath: "./bin/vector.so",
        provider: "openai",
        openaiBaseUrl: "http://localhost:11434/v1",
        maxChars: 300,
        overlapChars: 60,
        topK: 2,
      });
      using _ragRef = rag;

      const docId = await rag.addText(
        `## Criptografia
O banco de dados é protegido com SQLCipher. A chave é um arquivo de 16 bytes convertido em hexadecimal e aplicada via PRAGMA key.

## Embedding
O modelo nomic-embed-text gera vetores de 768 dimensões no formato Float32.

## Busca
A extensão sqlite-vector realiza busca KNN com distância cosine. A função vector_full_scan retorna os k vizinhos mais próximos.`,
        { title: "Sobre o projeto memories" },
      );
      assert(docId > 0);

      const hits = await rag.search("busca vetorial");
      assertEquals(hits.length, 2);
      assert(
        hits[0].content.includes("sqlite-vector") ||
          hits[0].content.includes("KNN"),
        `Melhor hit deveria mencionar busca: ${hits[0].content.slice(0, 80)}`,
      );

      const result = await rag.query("Como o embedding funciona?");
      assert(result.answer.length > 0, "Resposta não deveria ser vazia");
      assert(result.sources.length > 0, "Fontes não deveriam ser vazias");

      try {
        await rag.ensureModel();
      } catch (error) {
        const err = error as Error;
        assert(
          err.message.includes("Gerenciamento de modelos"),
          `Erro inesperado: ${err.message}`,
        );
      }

      const openaiProvider = new OpenAIProvider();
      try {
        await openaiProvider.pull("test-model");
        assert(false, "pull deveria lançar erro no provider openai");
      } catch (err) {
        const error = err as Error;
        assert(error.message.includes("Gerenciamento de modelos"));
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
