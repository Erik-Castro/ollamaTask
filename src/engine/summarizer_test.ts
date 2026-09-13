// deno-lint-ignore-file require-await
/**
 * Testes do sumarizador por LLM (src/summarizer.ts) — offline, provider fake.
 */
import type { Responses } from "openai/resources/responses";
import { assertEquals } from "@std/assert";
import { createLLMSummarizer, SUMMARIZER_INSTRUCTIONS } from "./summarizer.ts";
import type { ResponsesCall } from "./react.ts";

type Ev = Responses.ResponseStreamEvent;

function streamOf(events: Ev[]): AsyncIterable<Ev> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function delta(text: string): Ev {
  return {
    type: "response.output_text.delta",
    item_id: "m_1",
    output_index: 0,
    content_index: 0,
    delta: text,
    sequence_number: 1,
  } as Ev;
}

Deno.test("default: coleta deltas e devolve o texto concatenado", async () => {
  let seen: Parameters<ResponsesCall>[0] | null = null;
  const responseCall: ResponsesCall = async (request) => {
    seen = request;
    return streamOf([delta("fato A"), delta(", fato B")]);
  };
  const summarizer = createLLMSummarizer(responseCall);
  const controller = new AbortController();
  const messages = [{
    role: "user" as const,
    content: [{ type: "input_text" as const, text: "dado" }],
  }];

  const text = await summarizer({
    messages,
    instructions: "sistema do agente",
    model: "model-x",
    signal: controller.signal,
  });

  const request = seen!;
  assertEquals(request.model, "model-x");
  assertEquals(request.instructions, SUMMARIZER_INSTRUCTIONS);
  assertEquals(request.tools.length, 0);
  assertEquals(request.input, messages);
  assertEquals(request.signal, controller.signal);
  assertEquals(text, "fato A, fato B");
});

Deno.test("default: stream sem deltas vira string vazia", async () => {
  const responseCall: ResponsesCall = async () => streamOf([]);
  const summarizer = createLLMSummarizer(responseCall);
  const text = await summarizer({
    messages: [],
    instructions: "x",
    model: "m",
    signal: new AbortController().signal,
  });
  assertEquals(text, "");
});

Deno.test("default: texto só com espaços vira string vazia (trim)", async () => {
  const responseCall: ResponsesCall = async () => streamOf([delta("   ")]);
  const summarizer = createLLMSummarizer(responseCall);
  const text = await summarizer({
    messages: [],
    instructions: "x",
    model: "m",
    signal: new AbortController().signal,
  });
  assertEquals(text, "");
});
