import { EmbeddingStore } from "./store.ts";
import { ollamaTask, type ExecutionResult } from "../ollamaTask.ts";

export interface CacheOptions {
  minScore?: number;
  model: string;
  systemPrompt?: string;
}

export interface CacheResult {
  result: ExecutionResult;
  fromCache: boolean;
}

export async function cachedRun(
  store: EmbeddingStore,
  input: string,
  options: CacheOptions,
): Promise<CacheResult> {
  const minScore = options.minScore ?? 0.93;

  const hits = await store.search({
    query: input,
    topK: 1,
    kind: "cache",
    minScore,
  });

  if (hits.length > 0) {
    const cached = hits[0];
    const output = cached.metadata.fullOutput as string;
    const inputTokens = (cached.metadata.inputTokens as number) ?? 0;
    const outputTokens = (cached.metadata.outputTokens as number) ?? 0;

    return {
      result: {
        content: output,
        inputTokens,
        outputTokens,
        toolCalls: [],
        parse<T>(): T {
          return JSON.parse(output) as T;
        },
      },
      fromCache: true,
    };
  }

  const task = new ollamaTask(options.model)
    .system(options.systemPrompt ?? "You are a helpful assistant.")
    .user(input);

  const result = await task.execute();

  await store.add({
    text: input,
    kind: "cache",
    metadata: {
      fullOutput: result.content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: options.model,
    },
  });

  return { result, fromCache: false };
}
