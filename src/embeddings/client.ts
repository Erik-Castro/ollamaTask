import ollama from "ollama";

export class EmbeddingClient {
  private model: string;
  private useTaskPrefixes: boolean;

  constructor(
    model = "nomic-embed-text",
    options?: { useTaskPrefixes?: boolean },
  ) {
    this.model = model;
    this.useTaskPrefixes = options?.useTaskPrefixes ?? true;
  }

  embedQuery(text: string): Promise<Float32Array> {
    const input = this.useTaskPrefixes ? `search_query: ${text}` : text;
    return this.embed(input);
  }

  embedDocument(text: string): Promise<Float32Array> {
    const input = this.useTaskPrefixes ? `search_document: ${text}` : text;
    return this.embed(input);
  }

  async embedBatch(
    texts: string[],
    as: "query" | "document",
    options?: { concurrency?: number },
  ): Promise<Float32Array[]> {
    const prefix = as === "query" ? "search_query: " : "search_document: ";
    const inputs = this.useTaskPrefixes
      ? texts.map((t) => `${prefix}${t}`)
      : texts;

    const concurrency = options?.concurrency ?? 5;
    const results: Float32Array[] = [];

    for (let i = 0; i < inputs.length; i += concurrency) {
      const batch = inputs.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((input) => this.embed(input)),
      );
      results.push(...batchResults);
    }

    return results;
  }

  private async embed(input: string): Promise<Float32Array> {
    const res = await ollama.embeddings({
      model: this.model,
      prompt: input,
    });
    return new Float32Array(res.embedding);
  }
}
