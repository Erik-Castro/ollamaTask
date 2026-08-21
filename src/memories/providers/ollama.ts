import { Ollama } from "ollama";
import type { ChatMessage, ChatResult, LLMProvider } from "./types.ts";

export interface OllamaProviderOptions {
  host?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly #client: Ollama;

  constructor(options: OllamaProviderOptions = {}) {
    this.#client = new Ollama({
      host: options.host ?? "http://localhost:11434",
    });
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    const response = await this.#client.embed({ model, input });
    return response.embeddings;
  }

  async chat(model: string, messages: ChatMessage[]): Promise<ChatResult> {
    const response = await this.#client.chat({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    });
    return {
      content: response.message.content,
      model: response.model,
      totalDuration: response.total_duration,
      evalCount: response.eval_count,
    };
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
  ): AsyncGenerator<string, void, unknown> {
    const stream = await this.#client.chat({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });
    for await (const chunk of stream) {
      if (chunk.message?.content) yield chunk.message.content;
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.#client.list();
    return response.models.map((m) => m.name);
  }

  async hasModel(name: string): Promise<boolean> {
    const models = await this.listModels();
    const target = name.replace(/:latest$/, "");
    return models.some((m) => m.replace(/:latest$/, "") === target);
  }

  async pull(
    model: string,
    onProgress?: (status: string) => void,
  ): Promise<void> {
    const stream = await this.#client.pull({ model, stream: true });
    for await (const event of stream) {
      onProgress?.(event.status);
    }
  }
}
