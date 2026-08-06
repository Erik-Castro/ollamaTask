import { EmbeddingStore } from "./store.ts";
import { ollamaTask, type ExecutionResult } from "../ollamaTask.ts";

export interface RouteDefinition {
  name: string;
  examples: string[];
  model: string;
  systemPrompt?: string;
}

export interface RouteResult {
  route: string;
  score: number;
  result: ExecutionResult;
  contextHits: number;
}

export class SemanticRouter {
  private store: EmbeddingStore;
  private routes: Map<string, RouteDefinition> = new Map();

  constructor(store: EmbeddingStore) {
    this.store = store;
  }

  async register(route: RouteDefinition): Promise<void> {
    this.routes.set(route.name, route);

    await this.store.addBatch(
      route.examples.map((example) => ({
        text: example,
        kind: "route_example" as const,
        metadata: { route: route.name },
      })),
    );
  }

  async route(
    input: string,
    options?: { contextK?: number },
  ): Promise<RouteResult> {
    const hits = await this.store.search({
      query: input,
      topK: 3,
      kind: "route_example",
    });

    if (hits.length === 0) {
      throw new Error("No routes registered. Call register() first.");
    }

    const routeScores = new Map<string, number>();
    for (const hit of hits) {
      const routeName = hit.metadata.route as string;
      const existing = routeScores.get(routeName) ?? 0;
      routeScores.set(routeName, Math.max(existing, hit.score));
    }

    let bestRoute = "";
    let bestScore = 0;
    for (const [name, score] of routeScores) {
      if (score > bestScore) {
        bestScore = score;
        bestRoute = name;
      }
    }

    const routeDef = this.routes.get(bestRoute)!;

    const contextK = options?.contextK ?? 3;
    const contextHits = await this.store.search({
      query: input,
      topK: contextK,
      kind: "run",
    });

    let systemPrompt = routeDef.systemPrompt ?? "You are a helpful assistant.";
    if (contextHits.length > 0) {
      const contextBlock = contextHits
        .map((h) => `- ${h.text}`)
        .join("\n");
      systemPrompt += `\n\nRelevant context from previous interactions:\n${contextBlock}`;
    }

    const task = new ollamaTask(routeDef.model)
      .system(systemPrompt)
      .user(input);

    const result = await task.execute();

    await this.store.add({
      text: input,
      kind: "run",
      metadata: {
        route: bestRoute,
        model: routeDef.model,
        outputPreview: result.content.slice(0, 300),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        contextHits: contextHits.length,
      },
    });

    return {
      route: bestRoute,
      score: bestScore,
      result,
      contextHits: contextHits.length,
    };
  }
}
