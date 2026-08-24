import {
  type ExecutionResult,
  ollamaTask,
  type Thinking,
  type ToolArgs,
  type ToolDefinition,
  type ToolHandler,
} from "./ollamaTask.ts";
import { MCPBridge, type MCPServerConfig } from "./mcp/client.ts";
import type { RAG } from "./memories/rag.ts";
import { createRAGTool, searchContext } from "./ragIntegration.ts";

export interface StageConfig {
  model: string;
  system?: string;
  user?: string;
  transform?: (
    prev: ExecutionResult,
    original: string,
  ) => string | Promise<string>;
  tools?: ToolDefinition[];
  toolHandlers?: ToolHandler[];
  mcpServers?: MCPServerConfig[];
  format?: string | object;
  maxIterations?: number;
  numCtx?: number;
  temperature?: number;
  onThinking?: (chunk: string) => void;
  onContent?: (chunk: string) => void;
  onToolCall?: (name: string, args: ToolArgs) => void;
  onToolResult?: (name: string, args: ToolArgs, result: unknown) => void;
  think?: Thinking;
}

export interface RAGStageConfig {
  model: string;
  rag: RAG;
  k?: number;
  system?: string;
  user?: string;
  autoIndex?: boolean;
  tools?: ToolDefinition[];
  toolHandlers?: ToolHandler[];
  mcpServers?: MCPServerConfig[];
  format?: string | object;
  maxIterations?: number;
  numCtx?: number;
  temperature?: number;
  onThinking?: (chunk: string) => void;
  onContent?: (chunk: string) => void;
  onToolCall?: (name: string, args: ToolArgs) => void;
  onToolResult?: (name: string, args: ToolArgs, result: unknown) => void;
  think?: Thinking;
}

export class ollamaPipeline {
  private _prompt: string;
  private _stages: StageConfig[] = [];

  private constructor(prompt: string) {
    this._prompt = prompt;
  }

  public static create(prompt: string): ollamaPipeline {
    return new ollamaPipeline(prompt);
  }

  public stage(config: StageConfig): this {
    this._stages.push(config);
    return this;
  }

  public then(config: StageConfig): this {
    this._stages.push(config);
    return this;
  }

  private async _runStage(
    config: StageConfig,
    prev: ExecutionResult | null,
  ): Promise<ExecutionResult> {
    const task = new ollamaTask(config.model);

    if (config.system) task.system(config.system);

    let userMessage: string;
    if (prev && config.transform) {
      userMessage = await config.transform(prev, this._prompt);
    } else if (config.user) {
      userMessage = config.user;
    } else if (prev) {
      userMessage = prev.content;
    } else {
      userMessage = this._prompt;
    }

    task.user(userMessage);

    if (config.tools) task.tools(config.tools);
    if (config.toolHandlers) task.toolHandlers(config.toolHandlers);

    if (config.mcpServers) {
      for (const serverConfig of config.mcpServers) {
        const bridge = await MCPBridge.connect(serverConfig);
        const { definitions, handlers } = await bridge.getTools();
        task.tools([...(config.tools ?? []), ...definitions]);
        task.toolHandlers([...(config.toolHandlers ?? []), ...handlers]);
      }
    }

    if (config.format) task.format(config.format);
    if (config.maxIterations) task.maxIterations(config.maxIterations);
    if (config.numCtx !== undefined) task.numCtx(config.numCtx);
    if (config.temperature !== undefined) task.temperature(config.temperature);
    if (config.onThinking) task.onThinking(config.onThinking);
    if (config.onContent) task.onContent(config.onContent);
    if (config.onToolCall) task.onToolCall(config.onToolCall);
    if (config.onToolResult) task.onToolResult(config.onToolResult);
    if (config.think) task.reasoning(config.think);

    return task.execute();
  }

  public ragStage(config: RAGStageConfig): this {
    const { rag, k, autoIndex, ...stageConfig } = config;
    const tools = [...(config.tools ?? [])];
    const handlers = [...(config.toolHandlers ?? [])];

    if (autoIndex) {
      const { definition, handler } = createRAGTool(rag, { k });
      const hasRagTool = tools.some((t) => t.function.name === "rag_search");
      if (!hasRagTool) {
        tools.push(definition);
        handlers.push(handler);
      }
    }

    this._stages.push({
      ...stageConfig,
      tools,
      toolHandlers: handlers,
      transform: async (_prev, original) => {
        const context = await searchContext(rag, original, { k });
        const ragPrompt = config.system ??
          "Você é um assistente que responde usando EXCLUSIVAMENTE os trechos de contexto fornecidos. Cite as fontes usadas no formato [1], [2], etc.";
        if (context) {
          return `Contexto relevante:\n${context}\n\n---\n\n${ragPrompt}\n\nPergunta: ${original}`;
        }
        return original;
      },
    });
    return this;
  }

  public async execute(): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    let prev: ExecutionResult | null = null;

    for (const stage of this._stages) {
      const result = await this._runStage(stage, prev);
      results.push(result);
      prev = result;
    }

    return results;
  }

  public async run(): Promise<ExecutionResult> {
    const results = await this.execute();
    return results.at(-1)!;
  }
}
