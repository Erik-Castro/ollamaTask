import ollama, { type Message, type ToolCall } from "ollama";
import { MCPBridge, type MCPServerConfig } from "./mcp/client.ts";
import {
  createRAGTool,
  type RAGConfig,
  searchContext,
} from "./ragIntegration.ts";

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

export type Thinking = true | "low" | "medium" | "high" | undefined;

export class ollamaTask {
  private _messages: Message[] = [];
  private _model: string;
  private _tools?: ToolDefinition[];
  private _handlers?: ToolHandler[];
  private _format?: string | object;
  private _maxIterations = 10;
  private _resoaning: Thinking = undefined;
  private _ragConfig?: RAGConfig;
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

  public reasoning(reasonig: Thinking) {
    this._resoaning = reasonig;
    return this;
  }

  public rag(config: RAGConfig): this {
    this._ragConfig = config;
    const { definition, handler } = createRAGTool(config.rag, { k: config.k });
    const hasRagTool = this._tools?.some((t) =>
      t.function.name === "rag_search"
    );
    if (!hasRagTool) {
      this._tools = [...(this._tools ?? []), definition];
      this._handlers = [...(this._handlers ?? []), handler];
    }
    return this;
  }

  public async useMCP(config: MCPServerConfig): Promise<this> {
    const bridge = await MCPBridge.connect(config);
    const { definitions, handlers } = await bridge.getTools();
    this._tools = [...(this._tools ?? []), ...definitions];
    this._handlers = [...(this._handlers ?? []), ...handlers];
    return this;
  }

  public async useMCPServers(configs: MCPServerConfig[]): Promise<this> {
    for (const config of configs) {
      await this.useMCP(config);
    }
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
    if (this._ragConfig) {
      const lastUserMsg = [...this._messages]
        .reverse()
        .find((m) => m.role === "user");
      if (lastUserMsg) {
        const context = await searchContext(
          this._ragConfig.rag,
          lastUserMsg.content,
          { k: this._ragConfig.k },
        );
        if (context) {
          const ragPrompt = this._ragConfig.systemPrompt ??
            "Você é um assistente que responde usando EXCLUSIVAMENTE os trechos de contexto fornecidos. Cite as fontes usadas no formato [1], [2], etc. Se a resposta não estiver no contexto, diga que não sabe.";
          const systemIdx = this._messages.findIndex((m) =>
            m.role === "system"
          );
          const contextMsg =
            `Contexto relevante:\n${context}\n\n---\n\n${ragPrompt}`;
          if (systemIdx >= 0) {
            this._messages[systemIdx] = {
              role: "system",
              content: contextMsg,
            };
          } else {
            this._messages.unshift({ role: "system", content: contextMsg });
          }
        }
      }
    }

    for (let i = 0; i < this._maxIterations; i++) {
      const response = await ollama.chat({
        model: this._model,
        messages: this._messages,
        tools: this._tools,
        format: this._format,
        think: this._resoaning,
        stream: true,
      });

      let iterationContent = "";
      let iterationToolCalls: ToolCall[] = [];
      let buf = "";
      let inThink = false;
      const onThinking = this._onThinking;
      const onContent = this._onContent;

      const flush = function* (
        type: "thinking" | "content",
        text: string,
      ): Generator<StreamEvent, void, void> {
        if (!text) return;
        if (type === "thinking") {
          onThinking?.(text);
          yield { type: "thinking", data: text };
        } else {
          iterationContent += text;
          onContent?.(text);
          yield { type: "content", data: text };
        }
      };

      for await (const chunk of response) {
        const { thinking, content, tool_calls } = chunk.message;

        if (thinking) {
          this._onThinking?.(thinking);
          yield { type: "thinking", data: thinking };
        } else if (content) {
          buf += content;

          const LT = String.fromCharCode(60);
          const GT = String.fromCharCode(62);
          const THINK_OPEN = LT + "think" + GT;
          const THINK_CLOSE = LT + "/think" + GT;
          const isPartial = (s: string) =>
            !!s &&
            (THINK_OPEN.startsWith(s) || THINK_CLOSE.startsWith(s));

          while (true) {
            if (inThink) {
              const closeIdx = buf.indexOf(THINK_CLOSE);
              if (closeIdx === -1) break;
              yield* flush("thinking", buf.slice(0, closeIdx));
              buf = buf.slice(closeIdx + THINK_CLOSE.length);
              inThink = false;
            } else {
              const openIdx = buf.indexOf(THINK_OPEN);
              if (openIdx === -1) break;
              yield* flush("content", buf.slice(0, openIdx));
              buf = buf.slice(openIdx + THINK_OPEN.length);
              inThink = true;
            }
          }

          let keep = buf.length;
          for (let i = buf.length; i >= 0; i--) {
            if (isPartial(buf.slice(i))) {
              keep = i;
              break;
            }
          }
          yield* flush(inThink ? "thinking" : "content", buf.slice(0, keep));
          buf = buf.slice(keep);
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

    if (this._ragConfig?.autoIndex && fullContent) {
      const lastUserMsg = [...this._messages]
        .reverse()
        .find((m) => m.role === "user");
      if (lastUserMsg) {
        await this._ragConfig.rag.addText(
          `Pergunta: ${lastUserMsg.content}\nResposta: ${fullContent}`,
          { title: "cache" },
        );
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
