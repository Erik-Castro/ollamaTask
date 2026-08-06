import ollama, { type Message, type ToolCall } from "ollama";

export interface ExecutionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: ToolCallResult[];
  parse<T>(): T;
}

export type ToolArgs = Record<string, unknown>;

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<
        string,
        {
          type: string;
          description?: string;
          enum?: unknown[];
        }
      >;
      required?: string[];
    };
  };
}

export interface ToolHandler {
  name: string;
  execute: (args: ToolArgs) => unknown | Promise<unknown>;
}

export interface ToolCallResult {
  name: string;
  arguments: ToolArgs;
  result: unknown;
}

export type StreamEvent =
  | { type: "thinking"; data: string }
  | { type: "content"; data: string }
  | { type: "tool_call"; data: ToolCall }
  | { type: "tool_result"; data: ToolCallResult }
  | {
    type: "done";
    data: { inputTokens: number; outputTokens: number };
  };

export class ollamaTask {
  private _messages: Message[] = [];
  private _model: string;
  private _tools?: ToolDefinition[];
  private _handlers?: ToolHandler[];
  private _format?: string | object;
  private _maxIterations = 10;
  private _onThinking?: (chunk: string) => void;
  private _onContent?: (chunk: string) => void;
  private _onToolCall?: (name: string, args: ToolArgs) => void;
  private _onToolResult?: (
    name: string,
    args: ToolArgs,
    result: unknown,
  ) => void;

  constructor(model: string) {
    this._model = model;
  }

  public system(content: string): this {
    this._messages.push({ role: "system", content });
    return this;
  }

  public user(content: string): this {
    this._messages.push({ role: "user", content });
    return this;
  }

  public tools(defs: ToolDefinition[]): this {
    this._tools = defs;
    return this;
  }

  public toolHandlers(handlers: ToolHandler[]): this {
    this._handlers = handlers;
    return this;
  }

  public format(schema: string | object): this {
    this._format = schema;
    return this;
  }

  public maxIterations(n: number): this {
    this._maxIterations = n;
    return this;
  }

  public onThinking(callback: (chunk: string) => void): this {
    this._onThinking = callback;
    return this;
  }

  public onContent(callback: (chunk: string) => void): this {
    this._onContent = callback;
    return this;
  }

  public onToolCall(callback: (name: string, args: ToolArgs) => void): this {
    this._onToolCall = callback;
    return this;
  }

  public onToolResult(
    callback: (name: string, args: ToolArgs, result: unknown) => void,
  ): this {
    this._onToolResult = callback;
    return this;
  }

  private async *_streamEvents(): AsyncGenerator<StreamEvent> {
    for (let i = 0; i < this._maxIterations; i++) {
      const response = await ollama.chat({
        model: this._model,
        messages: this._messages,
        tools: this._tools,
        format: this._format,
        stream: true,
      });

      let isThinking = false;
      let iterationContent = "";
      let iterationToolCalls: ToolCall[] = [];

      for await (const chunk of response) {
        const { thinking, content, tool_calls } = chunk.message;

        if (thinking) {
          this._onThinking?.(thinking as string);
          yield { type: "thinking", data: thinking as string };
        } else if (content) {
          const text = content;

          if (text.includes("<think>")) isThinking = true;
          if (text.includes("</think>")) isThinking = false;

          const cleanText = text.replace(/<\/?think>/g, "");

          if (isThinking) {
            if (cleanText) {
              this._onThinking?.(cleanText);
              yield { type: "thinking", data: cleanText };
            }
          } else if (cleanText) {
            iterationContent += cleanText;
            this._onContent?.(cleanText);
            yield { type: "content", data: cleanText };
          }
        }

        if (tool_calls?.length) iterationToolCalls = tool_calls;

        if (chunk.done) {
          yield {
            type: "done",
            data: {
              inputTokens: chunk.prompt_eval_count ?? 0,
              outputTokens: chunk.eval_count ?? 0,
            },
          };
        }
      }

      if (iterationToolCalls.length === 0) break;

      this._messages.push({
        role: "assistant",
        content: iterationContent,
        tool_calls: iterationToolCalls.map((tc) => ({
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      });

      for (const tc of iterationToolCalls) {
        const { name, arguments: args } = tc.function;
        this._onToolCall?.(name, args);
        yield { type: "tool_call", data: tc };

        const handler = this._handlers?.find((h) => h.name === name);
        const result = handler
          ? await handler.execute(args)
          : { error: `No handler for tool: ${name}` };

        const toolResult: ToolCallResult = { name, arguments: args, result };
        this._onToolResult?.(name, args, result);
        yield { type: "tool_result", data: toolResult };

        this._messages.push({
          role: "tool",
          content: JSON.stringify(result),
          tool_name: name,
        });
      }
    }
  }

  public toReadableStream(): ReadableStream<StreamEvent> {
    const iterator = this._streamEvents();
    let done = false;

    return new ReadableStream({
      async pull(controller) {
        if (done) return;
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          done = true;
        } else {
          controller.enqueue(result.value);
        }
      },
      cancel() {
        iterator.return?.(undefined);
      },
    });
  }

  public async execute(): Promise<ExecutionResult> {
    const toolCalls: ToolCallResult[] = [];
    let input = 0;
    let output = 0;
    let fullContent = "";

    for await (const event of this._streamEvents()) {
      if (event.type === "content") fullContent += event.data;
      if (event.type === "tool_result") toolCalls.push(event.data);
      if (event.type === "done") {
        input += event.data.inputTokens;
        output += event.data.outputTokens;
      }
    }

    return {
      content: fullContent,
      inputTokens: input,
      outputTokens: output,
      toolCalls,
      parse<T>(): T {
        return JSON.parse(fullContent) as T;
      },
    };
  }
}
