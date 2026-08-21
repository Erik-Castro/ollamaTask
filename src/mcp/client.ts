import { Client } from "@modelcontextprotocol/sdk/client";
import type { ToolArgs, ToolDefinition, ToolHandler } from "../ollamaTask.ts";

// ── Config types ──────────────────────────────────────────────────────────────

/** Local MCP server launched via stdio. */
export interface StdioServerConfig {
  type?: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Remote MCP server reached via HTTP (Streamable HTTP or SSE). */
export interface RemoteServerConfig {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
}

export type MCPServerConfig = StdioServerConfig | RemoteServerConfig;

function isRemote(config: MCPServerConfig): config is RemoteServerConfig {
  return config.type === "remote" || "url" in config;
}

// ── Transport: stdio (Deno) ───────────────────────────────────────────────────

interface MCPTransport {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

class DenoStdioTransport implements MCPTransport {
  private _process?: Deno.ChildProcess;
  private _readBuffer = "";
  private _serverParams: StdioServerConfig;

  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(server: StdioServerConfig) {
    this._serverParams = server;
  }

  start(): Promise<void> {
    this._process = new Deno.Command(this._serverParams.command, {
      args: this._serverParams.args,
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
      env: this._serverParams.env,
    }).spawn();

    this._process.stdout.pipeTo(
      new WritableStream({
        write: (chunk: Uint8Array) => {
          this._readBuffer += new TextDecoder().decode(chunk);
          this._processReadBuffer();
        },
        close: () => {
          this.onclose?.();
        },
      }),
    ).catch((err: unknown) => {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    });

    return Promise.resolve();
  }

  private _processReadBuffer(): void {
    while (true) {
      const newlineIdx = this._readBuffer.indexOf("\n");
      if (newlineIdx === -1) break;

      const line = this._readBuffer.slice(0, newlineIdx);
      this._readBuffer = this._readBuffer.slice(newlineIdx + 1);

      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);
        this.onmessage?.(message);
      } catch {
        // Skip non-JSON lines
      }
    }
  }

  async send(message: unknown): Promise<void> {
    if (!this._process) throw new Error("Transport not started");

    const json = JSON.stringify(message) + "\n";
    const encoded = new TextEncoder().encode(json);
    const writer = this._process.stdin.getWriter();
    await writer.write(encoded);
    writer.releaseLock();
  }

  close(): Promise<void> {
    if (this._process) {
      try {
        this._process.kill("SIGTERM");
      } catch {
        // Process may already be closed
      }
      this._process = undefined;
    }
    this.onclose?.();
    return Promise.resolve();
  }
}

// ── Transport: HTTP (manual fetch) ────────────────────────────────────────────

/**
 * Minimal HTTP transport that speaks the MCP Streamable HTTP protocol
 * directly via fetch — no SDK transport wrappers.
 */
class HttpTransport implements MCPTransport {
  private _url: URL;
  private _headers?: Record<string, string>;
  private _sessionId?: string;

  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(config: RemoteServerConfig) {
    this._url = new URL(config.url);
    this._headers = config.headers;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  async send(message: unknown): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this._headers) Object.assign(headers, this._headers);
    if (this._sessionId) headers["mcp-session-id"] = this._sessionId;

    const response = await fetch(this._url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    // Capture session ID if present
    const sid = response.headers.get("mcp-session-id");
    if (sid) this._sessionId = sid;

    const ct = response.headers.get("content-type") ?? "";

    // 202 Accepted — notification acknowledged, no response body
    if (response.status === 202) return;

    if (ct.includes("text/event-stream")) {
      // Parse SSE stream from response body
      const body = response.body;
      if (!body) return;

      const reader = body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;

        // Process complete SSE event blocks (separated by double newline)
        while (true) {
          const idx = buffer.indexOf("\n\n");
          if (idx === -1) break;
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              try {
                this.onmessage?.(JSON.parse(data));
              } catch {
                /* skip non-JSON data lines */
              }
            }
          }
        }
      }
    } else {
      // Direct JSON response
      const body = await response.text();
      if (body) {
        try {
          this.onmessage?.(JSON.parse(body));
        } catch {
          /* skip non-JSON */
        }
      }
    }
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }
}

// ── Schema conversion helpers ─────────────────────────────────────────────────

function mcpTypeToOllama(type: string): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return "string";
  }
}

function convertSchema(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): ToolDefinition {
  const properties: Record<
    string,
    { type: string; description?: string; enum?: unknown[] }
  > = {};
  const required: string[] = [];

  const props = inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const req = inputSchema.required as string[] | undefined;

  if (props) {
    for (const [key, schema] of Object.entries(props)) {
      properties[key] = {
        type: mcpTypeToOllama(String(schema.type ?? "string")),
        description: schema.description
          ? String(schema.description)
          : undefined,
        enum: schema.enum as unknown[] | undefined,
      };
    }
  }

  if (req) {
    required.push(...req);
  }

  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required: required.length > 0 ? required : undefined,
      },
    },
  };
}

// ── MCPBridge ─────────────────────────────────────────────────────────────────

export class MCPBridge {
  private client: Client;
  private transport: MCPTransport;
  private _tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> = [];

  private constructor(config: MCPServerConfig) {
    this.transport = isRemote(config)
      ? new HttpTransport(config)
      : new DenoStdioTransport(config);
    this.client = new Client(
      { name: "ollama-task-client", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  private async init(): Promise<void> {
    await this.client.connect(this.transport as never);

    const { tools } = await this.client.listTools();
    this._tools = tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  getToolDefinitions(): ToolDefinition[] {
    return this._tools.map((t) =>
      convertSchema(t.name, t.description, t.inputSchema)
    );
  }

  getToolHandlers(): ToolHandler[] {
    return this._tools.map((t) => ({
      name: t.name,
      execute: async (args: ToolArgs): Promise<unknown> => {
        const result = await this.client.callTool({
          name: t.name,
          arguments: args as Record<string, unknown>,
        });

        const content = result.content as Array<
          { type: string; text?: string }
        >;
        if (!content?.length) return result;

        const textContent = content.find((c) => c.type === "text");
        if (textContent?.text) {
          try {
            return JSON.parse(textContent.text);
          } catch {
            return textContent.text;
          }
        }

        return result;
      },
    }));
  }

  getTools(): {
    definitions: ToolDefinition[];
    handlers: ToolHandler[];
  } {
    return {
      definitions: this.getToolDefinitions(),
      handlers: this.getToolHandlers(),
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  static async connect(config: MCPServerConfig): Promise<MCPBridge> {
    const bridge = new MCPBridge(config);
    await bridge.init();
    return bridge;
  }
}
