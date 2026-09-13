import type { Message, ToolCall } from "ollama";
import type { Responses } from "openai/resources/responses";
import { MCPBridge, type MCPServerConfig } from "./mcp/client.ts";
import {
  createRAGTool,
  type RAGConfig,
  searchContext,
} from "./ragIntegration.ts";
import {
  type AgentEvent,
  createClient,
  defaultResponsesCall,
  loadRuntimeConfig,
  type PromptPart,
  ReAct,
  type TAgent,
  type TExecutionResult,
  type ThinkingLevel,
  type Tool,
} from "./engine/mod.ts";

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

const DEFAULT_RAG_PROMPT =
  "Você é um assistente que responde usando EXCLUSIVAMENTE os trechos de " +
  "contexto fornecidos. Cite as fontes usadas no formato [1], [2], etc. Se a " +
  "resposta não estiver no contexto, diga que não sabe.";

function mapThinking(thinking: Thinking): ThinkingLevel | undefined {
  switch (thinking) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      // `undefined` (default do provider) e `true` (deixa o provider decidir).
      return undefined;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

async function toDataURI(image: Uint8Array | string): Promise<string> {
  if (image instanceof Uint8Array) {
    return `data:image/png;base64,${bytesToBase64(image)}`;
  }
  if (image.startsWith("data:") || /^https?:\/\//.test(image)) {
    return image;
  }
  const bytes = await Deno.readFile(image);
  return `data:${guessMime(image)};base64,${bytesToBase64(bytes)}`;
}

/** Converte as imagens de uma `Message` do ollama para `input_image` parts. */
async function toImageParts(
  images: (Uint8Array | string)[] | undefined,
): Promise<PromptPart[]> {
  if (!images) return [];
  const parts: PromptPart[] = [];
  for (const image of images) {
    parts.push({
      type: "input_image",
      image_url: await toDataURI(image),
    });
  }
  return parts;
}

/** Converte uma `Message` do ollama para itens de input do Responses API. */
async function toResponseInputItems(
  msg: Message,
): Promise<Responses.ResponseInputItem[]> {
  switch (msg.role) {
    case "system":
      return [{
        role: "system",
        content: [{ type: "input_text", text: msg.content }],
      }];
    case "user": {
      const content: Responses.ResponseInputContent[] = [
        { type: "input_text", text: msg.content },
      ];
      for (const image of msg.images ?? []) {
        content.push({
          type: "input_image",
          image_url: await toDataURI(image),
        } as Responses.ResponseInputContent);
      }
      return [{ role: "user", content }];
    }
    case "assistant": {
      if (msg.tool_calls?.length) {
        const items: Responses.ResponseInputItem[] = [];
        if (msg.content) {
          items.push({
            role: "assistant",
            content: [{ type: "output_text", text: msg.content }],
          } as Responses.ResponseInputItem);
        }
        for (const tc of msg.tool_calls) {
          items.push({
            type: "function_call",
            call_id: `call_seed_${tc.function.name}`,
            name: tc.function.name,
            arguments: typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments),
          } as Responses.ResponseInputItem);
        }
        return items;
      }
      return [{
        role: "assistant",
        content: [{ type: "output_text", text: msg.content }],
      }] as Responses.ResponseInputItem[];
    }
    case "tool":
      return [{
        type: "function_call_output",
        call_id: `call_seed_${msg.tool_name ?? "tool"}`,
        output: msg.content,
      }] as Responses.ResponseInputItem[];
    default:
      return [];
  }
}

/** Converte `args` (JSON string do engine) para objeto `ToolArgs`. */
function parseArgs(json: string): ToolArgs {
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ) {
      return parsed as ToolArgs;
    }
  } catch {
    // fallback abaixo
  }
  return {};
}

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
  private _numCtx?: number;
  private _temperature?: number;
  private _keepAlive?: string | number;
  private _stop?: string[];
  private _numPredict?: number;
  private _seed?: number;
  private _options?: Record<string, unknown>;

  constructor(model: string) {
    this._model = model;
  }

  public system(content: string): this {
    this._messages.push({ role: "system", content });
    return this;
  }

  public user(
    content: string,
    options?: { images?: (Uint8Array | string)[] },
  ): this {
    const msg: Message = { role: "user", content };
    if (options?.images) msg.images = options.images as Message["images"];
    this._messages.push(msg);
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

  public numCtx(n: number): this {
    this._numCtx = n;
    return this;
  }

  public temperature(t: number): this {
    this._temperature = t;
    return this;
  }

  public keepAlive(duration: string | number): this {
    this._keepAlive = duration;
    return this;
  }

  public stop(sequences: string[]): this {
    this._stop = sequences;
    return this;
  }

  public numPredict(n: number): this {
    this._numPredict = n;
    return this;
  }

  public seed(n: number): this {
    this._seed = n;
    return this;
  }

  public options(opts: Record<string, unknown>): this {
    this._options = opts;
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
    // ---- Seed da execução: uma chamada única ao motor ReAct --------------
    const lastUserIdx = this._messages.map((m) => m.role).lastIndexOf("user");
    const promptMsg = lastUserIdx >= 0
      ? this._messages[lastUserIdx]
      : undefined;
    const seedMessages = this._messages.filter((_, i) => i !== lastUserIdx);

    const systemPrompts = seedMessages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .filter((c) => c.trim())
      .join("\n\n");

    let systemPrompt = systemPrompts;
    if (this._ragConfig) {
      const query = promptMsg?.content ?? "";
      const context = await searchContext(
        this._ragConfig.rag,
        query,
        { k: this._ragConfig.k },
      );
      if (context) {
        const ragPrompt = this._ragConfig.systemPrompt ?? DEFAULT_RAG_PROMPT;
        const ragBlock =
          `Contexto relevante:\n${context}\n\n---\n\n${ragPrompt}`;
        systemPrompt = systemPrompts
          ? `${ragBlock}\n\n${systemPrompts}`
          : ragBlock;
      }
    }

    const initialMessages: Responses.ResponseInputItem[] = [];
    for (const msg of seedMessages) {
      if (msg.role === "system") continue; // system vai em `instructions`
      initialMessages.push(...await toResponseInputItems(msg));
    }

    const agentConfig: TAgent = {
      model: this._model,
      system_prompt: systemPrompt,
      maxRounds: this._maxIterations,
      thinking: mapThinking(this._resoaning),
    };

    const modelParams: Record<string, unknown> = {
      ...this._options,
      ...(this._numCtx !== undefined && { num_ctx: this._numCtx }),
      ...(this._temperature !== undefined &&
        { temperature: this._temperature }),
      ...(this._keepAlive !== undefined && { keep_alive: this._keepAlive }),
      ...(this._stop !== undefined && { stop: this._stop }),
      ...(this._numPredict !== undefined && { num_predict: this._numPredict }),
      ...(this._seed !== undefined && { seed: this._seed }),
    };

    const options = {
      initialMessages,
      format: this._format,
      modelParams,
      responses: defaultResponsesCall(createClient(loadRuntimeConfig())),
    };

    const agent = new ReAct(agentConfig, options);

    // ---- Adaptador ToolDefinition/ToolHandler → engine.Tool -------------
    // `lastRawResults` preserva o valor estruturado (unknown) do handler para
    // o `StreamEvent.tool_result` — em vez do JSON string que o motor usa.
    const lastRawResults = new Map<string, unknown>();
    const toEngineTool = (
      def: ToolDefinition,
      handler?: ToolHandler,
    ): Tool => ({
      name: def.function.name,
      description: def.function.description,
      parametersJsonSchema: def.function.parameters,
      execute: async (params) => {
        const raw: unknown = handler
          ? await handler.execute(params)
          : { error: `No handler for tool: ${def.function.name}` };
        lastRawResults.set(def.function.name, raw);
        return typeof raw === "string" ? raw : JSON.stringify(raw);
      },
    });

    for (const def of this._tools ?? []) {
      const handler = this._handlers?.find((h) => h.name === def.function.name);
      agent.registryTool(toEngineTool(def, handler));
    }

    // ---- Prompt corrente: última mensagem do usuário ---------------------
    const imageParts = await toImageParts(promptMsg?.images);
    const parts: PromptPart[] = imageParts.length > 0
      ? [{ type: "input_text", text: promptMsg?.content ?? "" }, ...imageParts]
      : [{ type: "input_text", text: promptMsg?.content ?? "" }];
    const generator = imageParts.length > 0
      ? agent.runParts(parts)
      : agent.run(promptMsg?.content ?? "");

    // ---- Tradução AgentEvent → StreamEvent -------------------------------
    const roundArgs = new Map<string, ToolArgs>();
    let execResult: TExecutionResult | undefined;

    for (;;) {
      const { done, value } = await generator.next();
      if (done) {
        execResult = value as TExecutionResult;
        break;
      }
      switch ((value as AgentEvent).type) {
        case "reasoning":
          this._onThinking?.((value as { token: string }).token);
          yield {
            type: "thinking",
            data: (value as { token: string }).token,
          };
          break;
        case "content":
          this._onContent?.((value as { token: string }).token);
          yield {
            type: "content",
            data: (value as { token: string }).token,
          };
          break;
        case "tool_call": {
          const evt = value as { tool: string; args: string };
          const argsObj = parseArgs(evt.args);
          roundArgs.set(evt.tool, argsObj);
          this._onToolCall?.(evt.tool, argsObj);
          yield {
            type: "tool_call",
            data: {
              function: { name: evt.tool, arguments: parseArgs(evt.args) },
            },
          };
          break;
        }
        case "tool_result": {
          const evt = value as { tool: string; output: string };
          const args = roundArgs.get(evt.tool) ?? {};
          const structured = lastRawResults.get(evt.tool);
          const result = structured ?? evt.output;
          const toolResult: ToolCallResult = {
            name: evt.tool,
            arguments: args,
            result,
          };
          this._onToolResult?.(evt.tool, args, result);
          yield { type: "tool_result", data: toolResult };
          break;
        }
        case "tool_denied": {
          const evt = value as {
            tool: string;
            args: string;
            reason: "user" | "timeout";
          };
          yield {
            type: "tool_result",
            data: {
              name: evt.tool,
              arguments: parseArgs(evt.args),
              result: { error: "denied by user" },
            },
          };
          break;
        }
        case "error":
          throw (value as { error: unknown }).error;
        case "aborted":
          return;
        case "reasoning.done":
        case "content.done":
          break;
      }
    }

    yield {
      type: "done",
      data: {
        inputTokens: execResult?.inputTokens ?? 0,
        outputTokens: execResult?.outputTokens ?? 0,
      },
    };
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

    if (fullContent) {
      this._messages.push({ role: "assistant", content: fullContent });
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
