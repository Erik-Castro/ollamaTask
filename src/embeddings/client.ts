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

  async embedQuery(text: string): Promise<Float32Array> {
    const input = this.useTaskPrefixes ? `search_query: ${text}` : text;
    return this.embed(input);
  }

  async embedDocument(text: string): Promise<Float32Array> {
    const input = this.useTaskPrefixes ? `search_document: ${text}` : text;
    return this.embed(input);
  }

  async embedBatch(
    texts: string[],
    as: "query" | "document",
  ): Promise<Float32Array[]> {
    const prefix = as === "query" ? "search_query: " : "search_document: ";
    const inputs = this.useTaskPrefixes
      ? texts.map((t) => `${prefix}${t}`)
      : texts;

    const results = await Promise.all(
      inputs.map((input) => this.embed(input)),
    );
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
