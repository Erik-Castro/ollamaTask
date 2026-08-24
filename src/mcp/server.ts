import { Server } from "@modelcontextprotocol/sdk/server";
import { z } from "zod";

import { Now } from "../tools/Now.ts";
import { Calculator } from "../tools/Calculator.ts";
import { ListDir } from "../tools/ListDir.ts";
import { FileRead } from "../tools/FileRead.ts";
import { FileWrite } from "../tools/FileWrite.ts";
import { CodeSearch } from "../tools/CodeSearch.ts";
import { Which } from "../tools/Which.ts";
import { RunCommand } from "../tools/RunCommand.ts";
import { WebSearch } from "../tools/WebSearch.ts";
import { WebFetch } from "../tools/WebFetch.ts";
import { StateStore, StateStoreAllTools } from "../tools/StateStore.ts";
import type { ToolHandler } from "../ollamaTask.ts";

const ListToolsRequestSchema = z.object({
  method: z.literal("tools/list"),
  params: z.object({ cursor: z.string().optional() }).optional(),
});

const CallToolRequestSchema = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.unknown()).optional(),
  }),
});

const str = (v: unknown, fb = ""): string =>
  v === undefined || v === null ? fb : String(v);

const splitArgs = (v: unknown): string[] =>
  str(v)
    .split(/\s+/)
    .map((p: string) => p.trim())
    .filter(Boolean);

interface DenoTransport {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

class DenoStdioServerTransport implements DenoTransport {
  private _readBuffer = "";
  private _started = false;

  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  start(): Promise<void> {
    if (this._started) return Promise.resolve();
    this._started = true;

    const reader = Deno.stdin.readable.getReader();
    const decoder = new TextDecoder();

    const readLoop = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          this._readBuffer += decoder.decode(value, { stream: true });

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
      } catch (err) {
        this.onerror?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      } finally {
        this.onclose?.();
      }
    };

    readLoop();
  }

  async send(message: unknown): Promise<void> {
    const json = JSON.stringify(message) + "\n";
    const encoded = new TextEncoder().encode(json);
    await Deno.stdout.write(encoded);
  }

  close(): void {
    this.onclose?.();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const store = new StateStore();
const stateTools = StateStoreAllTools(store);

const stateHandlerMap = new Map<string, ToolHandler>(
  stateTools.handlers.map((h) => [h.name, h]),
);

const TOOLS: ToolDef[] = [
  {
    name: "now",
    description: "Current date/time (ISO, unix, timezone, utcOffsetMinutes).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "calculate",
    description:
      "Evaluate a math expression (+ - * / % ^, parens, pi/e/tau, sqrt abs round floor ceil log ln min max).",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Math expression" },
      },
      required: ["expression"],
    },
  },
  {
    name: "list_dir",
    description: "List directory entries (dirs first, then alphabetical).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
      },
    },
  },
  {
    name: "file_read",
    description: "Read a text file from a byte offset.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        maxChars: { type: "integer", description: "Max characters" },
        offset: { type: "integer", description: "Byte offset" },
      },
      required: ["path"],
    },
  },
  {
    name: "file_write",
    description: "Create or overwrite a text file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "code_search",
    description: "Regex search over the codebase.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        include: {
          type: "string",
          description: "Comma-separated extensions",
        },
        limit: { type: "integer", description: "Max results" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "which",
    description: "Check if a binary exists on PATH.",
    inputSchema: {
      type: "object",
      properties: {
        binary: { type: "string", description: "Binary name" },
      },
      required: ["binary"],
    },
  },
  {
    name: "run_command",
    description: "Run a whitelisted shell command.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run" },
        args: { type: "string", description: "Space-separated arguments" },
      },
      required: ["command"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web via DuckDuckGo. Use offset to paginate (0=first page, 10=second, etc.). Check nextOffset in the response for the next page.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        offset: {
          type: "integer",
          description: "Page offset (0=first page, 10=second, 20=third, etc.)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and extract visible text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
  ...stateTools.definitions.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    inputSchema: d.function.parameters,
  })),
];

type ToolArgs = Record<string, unknown>;

async function handleToolCall(
  name: string,
  args: ToolArgs,
): Promise<{ type: string; text: string }[]> {
  const stateHandler = stateHandlerMap.get(name);
  if (stateHandler) {
    const result = await stateHandler.execute(args);
    return [{ type: "text", text: JSON.stringify(result) }];
  }

  let result: unknown;

  switch (name) {
    case "now":
      result = Now();
      break;
    case "calculate":
      result = Calculator(str(args.expression));
      break;
    case "list_dir":
      result = await ListDir(str(args.path, "."));
      break;
    case "file_read":
      result = await FileRead(str(args.path), {
        maxChars: args.maxChars != null ? Number(args.maxChars) : undefined,
        offset: args.offset != null ? Number(args.offset) : undefined,
      });
      break;
    case "file_write":
      result = await FileWrite(str(args.path), str(args.content));
      break;
    case "code_search":
      result = await CodeSearch(str(args.pattern), {
        include: str(args.include)
          .split(",")
          .map((e: string) => e.trim())
          .filter(Boolean),
        limit: args.limit != null ? Number(args.limit) : undefined,
      });
      break;
    case "which":
      result = await Which(str(args.binary));
      break;
    case "run_command":
      result = await RunCommand(str(args.command), splitArgs(args.args));
      break;
    case "web_search":
      result = await WebSearch(str(args.query), {
        offset: args.offset != null ? Number(args.offset) : undefined,
      });
      break;
    case "web_fetch":
      result = await WebFetch(str(args.url));
      break;
    default:
      result = { error: `Unknown tool: ${name}` };
  }

  return [{ type: "text", text: JSON.stringify(result) }];
}

export function buildServer(): Server {
  const server = new Server(
    { name: "ollama-task-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      const { name, arguments: args } = request.params;
      const content = await handleToolCall(name, args ?? {});
      return { content };
    },
  );

  return server;
}

export async function startServer(): Promise<void> {
  const transport = new DenoStdioServerTransport();
  const server = buildServer();
  await server.connect(transport as never);
}

if (import.meta.main) {
  await startServer();
}
