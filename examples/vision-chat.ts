/**
 * Exemplo multimodal: descreve uma imagem com o motor ReAct direto.
 *
 * Demonstra três extensões do motor:
 * - `runParts(...)`: primeiro turno do usuário com `input_text` + `input_image`;
 * - `format`: pedido de structured output (JSON) para o round;
 * - `modelParams`: parâmetros nativos do Ollama via `extra_body`.
 *
 * Para uma demo real de visão, use um modelo multimodal:
 *
 * ```bash
 * VISION_MODEL=llava:7b deno run --allow-net=localhost:11434 --allow-env \
 *   examples/vision-chat.ts
 * ```
 *
 * Sem `VISION_MODEL`, usa um 1x1 pixel PNG para provar o fluxo de bytes.
 */
import {
  createClient,
  defaultResponsesCall,
  ReAct,
} from "../src/engine/mod.ts";

const MODEL = Deno.env.get("VISION_MODEL") ?? "llava:7b";
const BASE_URL = Deno.env.get("OPENAI_BASE_URL") ?? "http://127.0.0.1:11434/v1";

// PNG 1x1 branco — suficiente para demonstrar o transporte da imagem.
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+7m+UAAAAASUVORK5CYII=";

const agent = new ReAct(
  {
    model: MODEL,
    system_prompt: "Descreva a imagem com uma frase curta.",
    maxRounds: 3,
  },
  {
    responses: defaultResponsesCall(createClient({
      baseURL: BASE_URL,
      apiKey: "ollama",
      maxRetries: 2,
    })),
    format: "json",
    modelParams: { num_ctx: 4096, keep_alive: "5m" },
  },
);

console.log(`Modelo: ${MODEL}\n`);

for await (
  const event of agent.runParts([
    { type: "input_text", text: "Descreva esta imagem em uma frase curta." },
    { type: "input_image", image_url: `data:image/png;base64,${PIXEL_PNG}` },
  ])
) {
  if (event.type === "content") {
    Deno.stdout.writeSync(new TextEncoder().encode(event.token));
  } else if (event.type === "reasoning") {
    Deno.stdout.writeSync(
      new TextEncoder().encode(`\x1b[90m[raciocínio: ${event.token}]\x1b[0m\n`),
    );
  }
}

console.log("\n\nDone.");
