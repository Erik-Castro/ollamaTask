/**
 * Fake MCP server — implementa o protocolo JSON-RPC mínimo (initialize,
 * tools/list, tools/call) direto sobre stdio, sem depender do SDK MCP.
 *
 * Serve exclusivamente o teste de integração `mcp_test.ts`: é um *test double*
 * independente que prova que `MCPBridge` fala o protocolo de verdade contra
 * qualquer servidor conforme, não apenas contra a nossa própria implementação.
 */
const TOOLS = [
  {
    name: "echo",
    description: "Ecoa o texto de volta (parser JSON).",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "sum",
    description: "Soma dois inteiros.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
    },
  },
];

const decoder = new TextDecoder();
const encoder = new TextEncoder();
let buffer = "";

function send(message: unknown): void {
  Deno.stdout.writeSync(encoder.encode(`${JSON.stringify(message)}\n`));
}

for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });

  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;

    let request: {
      id?: unknown;
      method?: string;
      params?: {
        name?: string;
        arguments?: Record<string, unknown>;
      };
    };
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    switch (request.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-mcp", version: "0.0.1" },
          },
        });
        break;
      case "tools/list":
        send({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } });
        break;
      case "tools/call": {
        const { name, arguments: args } = request.params ?? {};
        if (name === "echo") {
          send({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{
                type: "text",
                text: JSON.stringify({ echoed: args?.text }),
              }],
            },
          });
        } else if (name === "sum") {
          send({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{
                type: "text",
                text: JSON.stringify(Number(args?.a) + Number(args?.b)),
              }],
            },
          });
        } else {
          send({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: `Unknown tool: ${name}` },
          });
        }
        break;
      }
      default:
        // Notificações (ex.: notifications/initialized) não têm resposta.
        if (request.id !== undefined) {
          send({ jsonrpc: "2.0", id: request.id, result: {} });
        }
    }
  }
}
