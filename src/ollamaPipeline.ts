import {
  type ExecutionResult,
  ollamaTask,
  type ToolArgs,
  type ToolDefinition,
  type ToolHandler,
} from "./ollamaTask.ts";

export interface StageConfig {
  model: string;
  system?: string;
  user?: string;
  transform?: (prev: ExecutionResult, original: string) => string;
  tools?: ToolDefinition[];
  toolHandlers?: ToolHandler[];
  format?: string | object;
  maxIterations?: number;
  onThinking?: (chunk: string) => void;
  onContent?: (chunk: string) => void;
  onToolCall?: (name: string, args: ToolArgs) => void;
  onToolResult?: (name: string, args: ToolArgs, result: unknown) => void;
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

  private _runStage(
    config: StageConfig,
    prev: ExecutionResult | null,
  ): Promise<ExecutionResult> {
    const task = new ollamaTask(config.model);

    if (config.system) task.system(config.system);

    let userMessage: string;
    if (prev && config.transform) {
      userMessage = config.transform(prev, this._prompt);
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
    if (config.format) task.format(config.format);
    if (config.maxIterations) task.maxIterations(config.maxIterations);
    if (config.onThinking) task.onThinking(config.onThinking);
    if (config.onContent) task.onContent(config.onContent);
    if (config.onToolCall) task.onToolCall(config.onToolCall);
    if (config.onToolResult) task.onToolResult(config.onToolResult);

    return task.execute();
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
