export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  model: string;
  totalDuration?: number;
  evalCount?: number;
}

export interface LLMProvider {
  embed(model: string, input: string[]): Promise<number[][]>;
  chat(model: string, messages: ChatMessage[]): Promise<ChatResult>;
  chatStream(
    model: string,
    messages: ChatMessage[],
  ): AsyncGenerator<string, void, unknown>;
  listModels(): Promise<string[]>;
  hasModel(name: string): Promise<boolean>;
  pull(model: string, onProgress?: (status: string) => void): Promise<void>;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
