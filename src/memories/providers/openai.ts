import OpenAI from "openai";
import type { ChatMessage, ChatResult, LLMProvider } from "./types.ts";

export interface OpenAIProviderOptions {
  baseURL?: string;
  apiKey?: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly #client: OpenAI;

  constructor(options: OpenAIProviderOptions = {}) {
    this.#client = new OpenAI({
      baseURL: options.baseURL ?? "http://localhost:11434/v1",
      apiKey: options.apiKey ?? "ollama",
    });
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    const response = await this.#client.embeddings.create({ model, input });
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.embedding);
  }

  async chat(model: string, messages: ChatMessage[]): Promise<ChatResult> {
    const response = await this.#client.chat.completions.create({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const choice = response.choices[0];
    return {
      content: choice.message?.content ?? "",
      model: response.model,
    };
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
  ): AsyncGenerator<string, void, unknown> {
    const stream = await this.#client.chat.completions.create({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await this.#client.models.list();
      return response.data.map((m) => m.id);
    } catch {
      return [];
    }
  }

  async hasModel(name: string): Promise<boolean> {
    const models = await this.listModels();
    const target = name.replace(/:latest$/, "");
    return models.some((m) => m.replace(/:latest$/, "") === target);
  }

  async pull(
    _model: string,
    _onProgress?: (status: string) => void,
  ): Promise<void> {
    await Promise.reject(
      new Error(
        "Gerenciamento de modelos não suportado no protocolo OpenAI. " +
          "Use 'ollama pull <model>' ou troque para o provider 'ollama'.",
      ),
    );
  }
}
