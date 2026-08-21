import { RAG } from "./memories/rag.ts";
import { type ExecutionResult, ollamaTask } from "./ollamaTask.ts";

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
  rag: RAG,
  input: string,
  options: CacheOptions,
): Promise<CacheResult> {
  const minScore = options.minScore ?? 0.93;
  const hits = await rag.search(input, { k: 1 });

  if (hits.length > 0 && hits[0].score >= minScore) {
    return {
      result: {
        content: hits[0].content,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        parse<T>(): T {
          return JSON.parse(hits[0].content) as T;
        },
      },
      fromCache: true,
    };
  }

  const task = new ollamaTask(options.model)
    .system(options.systemPrompt ?? "You are a helpful assistant.")
    .user(input);

  const result = await task.execute();

  await rag.addText(input, { title: "cache" });

  return { result, fromCache: false };
}
