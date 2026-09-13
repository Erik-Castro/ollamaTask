/**
 * Testes da camada de tradução de eventos (src/events.ts) — offline, sem rede.
 * Alimenta mapResponseStream com eventos fake do SDK (cast de forma para
 * evitar verbosidade; a função só lê os campos usados).
 */
import type { Responses } from "openai/resources/responses";
import { assertEquals } from "@std/assert";
import { mapResponseStream, mapUsage, type RoundOutcome } from "./events.ts";
import type { AgentEvent } from "./types.ts";

type Ev = Responses.ResponseStreamEvent;

function streamOf(events: Ev[]): AsyncIterable<Ev> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

async function run(events: Ev[], signal?: AbortSignal) {
  const eventsOut: AgentEvent[] = [];
  const iterator = mapResponseStream(streamOf(events), signal);
  let outcome: RoundOutcome = null as unknown as RoundOutcome;
  for (;;) {
    const { done, value } = await iterator.next();
    if (done) {
      outcome = value;
      break;
    }
    eventsOut.push(value);
  }
  return { events: eventsOut, outcome };
}

Deno.test("mapeia reasoning e content, com marcadores de done", async () => {
  const events: Ev[] = [
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      delta: "Pens",
      sequence_number: 1,
    } as Ev,
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      delta: "ando",
      sequence_number: 2,
    } as Ev,
    {
      type: "response.reasoning_summary_text.done",
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      text: "Pensando",
      sequence_number: 3,
    } as Ev,
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "Olá",
      sequence_number: 4,
    } as Ev,
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: " mundo",
      sequence_number: 5,
    } as Ev,
    {
      type: "response.output_text.done",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text: "Olá mundo",
      sequence_number: 6,
    } as Ev,
  ];
  const { events: got, outcome } = await run(events);
  assertEquals(
    got.map((e) => e.type),
    [
      "reasoning",
      "reasoning",
      "reasoning.done",
      "content",
      "content",
      "content.done",
    ],
  );
  assertEquals(got[0], { type: "reasoning", token: "Pens" });
  assertEquals(got[3], { type: "content", token: "Olá" });
  assertEquals(outcome, {
    reasoning: "Pensando",
    content: "Olá mundo",
    items: [],
    calls: [],
    usage: null,
    aborted: false,
    errored: null,
  });
});

Deno.test("suporta reasoning_text.delta (rastro completo)", async () => {
  const events: Ev[] = [
    {
      type: "response.reasoning_text.delta",
      item_id: "rs_1",
      delta: "trace",
      sequence_number: 1,
    } as Ev,
    {
      type: "response.reasoning_text.done",
      item_id: "rs_1",
      text: "trace",
      sequence_number: 2,
    } as Ev,
  ];
  const { events: got, outcome } = await run(events);
  assertEquals(got[0], { type: "reasoning", token: "trace" });
  assertEquals(got[1], { type: "reasoning.done" });
  assertEquals(outcome.reasoning, "trace");
});

Deno.test("acumula function_call e emite tool_call", async () => {
  const events: Ev[] = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "uppercase",
        arguments: "",
        status: "in_progress",
      },
      sequence_number: 1,
    } as Ev,
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: '{"text":',
      sequence_number: 2,
    } as Ev,
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: '"oi"}',
      sequence_number: 3,
    } as Ev,
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "uppercase",
        arguments: '{"text":"oi"}',
        status: "completed",
      },
      sequence_number: 4,
    } as Ev,
  ];
  const { events: got, outcome } = await run(events);
  assertEquals(got, [{
    type: "tool_call",
    tool: "uppercase",
    args: '{"text":"oi"}',
  }]);
  assertEquals(outcome.calls, [
    { id: "fc_1", call_id: "call_1", name: "uppercase", args: '{"text":"oi"}' },
  ]);
  assertEquals(outcome.items.length, 1);
  assertEquals(outcome.items[0].type, "function_call");
});

Deno.test("extrai usage de response.completed", async () => {
  const events: Ev[] = [
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        output: [],
      },
      sequence_number: 1,
    } as unknown as Ev,
  ];
  const { outcome } = await run(events);
  assertEquals(outcome.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});

Deno.test("falha e error viram errored", async () => {
  const failed = await run([
    {
      type: "response.failed",
      response: { id: "r", status: "failed" },
      sequence_number: 1,
    } as unknown as Ev,
  ]);
  assertEquals(failed.outcome.errored !== null, true);

  const err = await run([
    {
      type: "error",
      code: "e",
      message: "boom",
      param: null,
      sequence_number: 1,
    } as Ev,
  ]);
  assertEquals(err.outcome.errored, {
    type: "error",
    code: "e",
    message: "boom",
    param: null,
    sequence_number: 1,
  });
});

Deno.test("aborta quando o sinal é cortado", async () => {
  const controller = new AbortController();
  const events: Ev[] = [
    {
      type: "response.output_text.delta",
      item_id: "m",
      output_index: 0,
      content_index: 0,
      delta: "a",
      sequence_number: 1,
    } as Ev,
    {
      type: "response.output_text.delta",
      item_id: "m",
      output_index: 0,
      content_index: 0,
      delta: "b",
      sequence_number: 2,
    } as Ev,
    {
      type: "response.output_text.done",
      item_id: "m",
      output_index: 0,
      content_index: 0,
      text: "ab",
      sequence_number: 3,
    } as Ev,
  ];
  const eventsOut: AgentEvent[] = [];
  const iterator = mapResponseStream(streamOf(events), controller.signal);
  let outcome: RoundOutcome = null as unknown as RoundOutcome;
  for (;;) {
    const { done, value } = await iterator.next();
    if (done) {
      outcome = value;
      break;
    }
    eventsOut.push(value);
    controller.abort();
  }
  assertEquals(eventsOut, [{ type: "content", token: "a" }]);
  assertEquals(outcome.aborted, true);
  assertEquals(outcome.errored, null);
});

Deno.test("mapUsage lida com ausência de dados", () => {
  assertEquals(mapUsage(null), null);
  assertEquals(mapUsage(undefined), null);
  assertEquals(
    mapUsage({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 0,
      input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    }),
    { inputTokens: 1, outputTokens: 2, totalTokens: 0 },
  );
});
