import { RAG, type RagOptions } from "./memories/rag.ts";
import type { SearchHit } from "./memories/store.ts";
import { type ExecutionResult, ollamaTask } from "./ollamaTask.ts";

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
  #rag: RAG;
  #routes: Map<string, RouteDefinition> = new Map();

  private constructor(rag: RAG) {
    this.#rag = rag;
  }

  static async create(options?: RagOptions): Promise<SemanticRouter> {
    const rag = await RAG.create(options);
    return new SemanticRouter(rag);
  }

  async register(route: RouteDefinition): Promise<void> {
    this.#routes.set(route.name, route);
    for (const example of route.examples) {
      await this.#rag.addText(example, {
        title: `route:${route.name}`,
        source: "route_example",
      });
    }
  }

  async route(
    input: string,
    options?: { contextK?: number; minScore?: number },
  ): Promise<RouteResult> {
    const minScore = options?.minScore ?? 0.5;
    const hits = await this.#rag.search(input, { k: 10 });
    const routeHits = hits.filter((h: SearchHit) =>
      h.source === "route_example"
    );

    const routeScores = new Map<string, number>();
    for (const hit of routeHits) {
      const routeName = hit.title?.replace("route:", "") ?? "";
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

    if (!bestRoute || bestScore < minScore) {
      throw new Error(
        `No route matched above threshold. Best score: ${
          bestScore.toFixed(3)
        }, required: ${minScore}. ` +
          `Registered routes: ${Array.from(this.#routes.keys()).join(", ")}`,
      );
    }

    const routeDef = this.#routes.get(bestRoute)!;
    const contextK = options?.contextK ?? 3;
    const contextHits = await this.#rag.search(input, { k: contextK });

    let systemPrompt = routeDef.systemPrompt ?? "You are a helpful assistant.";
    if (contextHits.length > 0) {
      const ctx = contextHits
        .map((h: SearchHit) => `- ${h.content}`)
        .join("\n");
      systemPrompt +=
        `\n\nRelevant context from previous interactions:\n${ctx}`;
    }

    const task = new ollamaTask(routeDef.model)
      .system(systemPrompt)
      .user(input);

    const result = await task.execute();

    return {
      route: bestRoute,
      score: bestScore,
      result,
      contextHits: contextHits.length,
    };
  }

  getRag(): RAG {
    return this.#rag;
  }
}
