// deno-lint-ignore-file require-await
/**
 * Testes do loop ReAct (src/react.ts) — offline, com provider fake.
 * Não fazem nenhuma chamada de rede.
 */
import type { Responses } from "openai/resources/responses";
import { z } from "zod";
import { assertEquals } from "@std/assert";
import { ReAct, type ResponsesCall } from "./react.ts";
import type { Summarizer } from "./summarizer.ts";
import type { AgentEvent, TExecutionResult, Tool } from "./types.ts";

type ResponseInputItemLike = {
  role?: string;
  content?: unknown;
  type?: string;
};

type Ev = Responses.ResponseStreamEvent;

function streamOf(events: Ev[]): AsyncIterable<Ev> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function usage(input = 1, output = 1) {
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function textRound(text: string): Ev[] {
  return [
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      delta: "p",
      sequence_number: 1,
    } as Ev,
    {
      type: "response.output_text.delta",
      item_id: "m_1",
      output_index: 0,
      content_index: 0,
      delta: text,
      sequence_number: 2,
    } as Ev,
    {
      type: "response.output_text.done",
      item_id: "m_1",
      output_index: 0,
      content_index: 0,
      text,
      sequence_number: 3,
    } as Ev,
    {
      type: "response.completed",
      response: { id: "r", status: "completed", usage: usage(), output: [] },
      sequence_number: 4,
    } as unknown as Ev,
  ];
}

function toolRound(name: string, args: string, callId = "call_1"): Ev[] {
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: callId,
        name,
        arguments: "",
        status: "in_progress",
      },
      sequence_number: 1,
    } as Ev,
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: args,
      sequence_number: 2,
    } as Ev,
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: callId,
        name,
        arguments: args,
        status: "completed",
      },
      sequence_number: 3,
    } as Ev,
    {
      type: "response.completed",
      response: {
        id: "r",
        status: "completed",
        usage: usage(2, 1),
        output: [],
      },
      sequence_number: 4,
    } as unknown as Ev,
  ];
}

function toolRoundMany(
  calls: Array<{ name: string; args: string; call_id: string }>,
): Ev[] {
  const events: Ev[] = [];
  calls.forEach((call, index) => {
    const itemId = `fc_${index}`;
    events.push({
      type: "response.output_item.added",
      output_index: index,
      item: {
        type: "function_call",
        id: itemId,
        call_id: call.call_id,
        name: call.name,
        arguments: "",
        status: "in_progress",
      },
      sequence_number: index * 3 + 1,
    } as Ev);
    events.push({
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: index,
      delta: call.args,
      sequence_number: index * 3 + 2,
    } as Ev);
    events.push({
      type: "response.output_item.done",
      output_index: index,
      item: {
        type: "function_call",
        id: itemId,
        call_id: call.call_id,
        name: call.name,
        arguments: call.args,
        status: "completed",
      },
      sequence_number: index * 3 + 3,
    } as Ev);
  });
  events.push({
    type: "response.completed",
    response: {
      id: "r",
      status: "completed",
      usage: usage(2, calls.length),
      output: [],
    },
    sequence_number: calls.length * 3 + 1,
  } as unknown as Ev);
  return events;
}

async function collect(
  gen: AsyncGenerator<AgentEvent, TExecutionResult, void>,
) {
  const events: AgentEvent[] = [];
  let result: TExecutionResult;
  for (;;) {
    const { value, done } = await gen.next();
    if (done) {
      result = value;
      break;
    }
    events.push(value);
  }
  return { events, result: result as TExecutionResult };
}

function toolRoundNoUsage(name: string, args: string, callId = "call_1"): Ev[] {
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: callId,
        name,
        arguments: "",
        status: "in_progress",
      },
      sequence_number: 1,
    } as Ev,
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: args,
      sequence_number: 2,
    } as Ev,
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: callId,
        name,
        arguments: args,
        status: "completed",
      },
      sequence_number: 3,
    } as Ev,
  ];
}

function textRoundNoUsage(text: string): Ev[] {
  return [
    {
      type: "response.output_text.delta",
      item_id: "m_1",
      output_index: 0,
      content_index: 0,
      delta: text,
      sequence_number: 1,
    } as Ev,
    {
      type: "response.output_text.done",
      item_id: "m_1",
      output_index: 0,
      content_index: 0,
      text,
      sequence_number: 2,
    } as Ev,
  ];
}

const uppercaseTool: Tool = {
  name: "uppercase",
  description: "Converte o texto para maiúsculas.",
  parameters: z.object({ text: z.string() }).strict(),
  execute: (params) => String(params["text"]).toUpperCase(),
};

function makeAgent(
  responses: ResponsesCall,
  options: ConstructorParameters<typeof ReAct>[1] = {},
) {
  const agent = new ReAct(
    {
      model: "model-x",
      thinking: "low",
      system_prompt: "sys-prompt",
      maxRounds: 6,
    },
    { responses, ...options },
  );
  agent.registryTool(uppercaseTool);
  return agent;
}

const sensitiveTool: Tool = {
  name: "sensitive_upper",
  description: "Converte para maiúsculas (requer aprovação humana).",
  parameters: z.object({ text: z.string() }).strict(),
  execute: (params) => String(params["text"]).toUpperCase(),
  sensitive: true,
};

Deno.test("round único de texto retorna conteúdo, raciocínio e usage", async () => {
  const agent = makeAgent(async (request) => {
    assertEquals(request.instructions, "sys-prompt");
    assertEquals(request.reasoning, { effort: "low" });
    return streamOf(textRound("Olá mundo"));
  });

  const tokens: string[] = [];
  agent.onReasoning((t) => tokens.push(`r:${t}`));
  agent.onContent((t) => tokens.push(`c:${t}`));

  const { events, result } = await collect(agent.run("oi"));
  assertEquals(result.content.content, "Olá mundo");
  assertEquals(result.content.reasoning, "p");
  assertEquals(result.rounds, 1);
  assertEquals(result.toolCalls, 0);
  assertEquals(result.totalTokens, 2);
  assertEquals(tokens, ["r:p", "c:Olá mundo"]);
  assertEquals(events.map((e) => e.type), [
    "reasoning",
    "content",
    "content.done",
  ]);
});

Deno.test("tool calling: executa a ferramenta e devolve o resultado no ciclo", async () => {
  let requestCount = 0;
  const responses: ResponsesCall = async (request) => {
    requestCount++;
    if (requestCount === 1) {
      assertEquals((request.tools[0] as { name: string }).name, "uppercase");
      return streamOf(toolRound("uppercase", '{"text":"oi"}'));
    }
    // Segundo round: o resultado da tool deve constar no histórico.
    assertEquals(request.tools.length, 1);
    const withOutput = request.input.filter(
      (item) => (item as { type?: string }).type === "function_call_output",
    );
    assertEquals(withOutput.length, 1);
    assertEquals((withOutput[0] as { output?: string }).output, "OI");
    return streamOf(textRound("OI"));
  };
  const agent = makeAgent(responses);

  const calls: Array<[string, string]> = [];
  const responsesCb: string[] = [];
  agent.onToolCalling((name, args) => calls.push([name, args]));
  agent.onToolResponse((_name, response) => responsesCb.push(response));

  const { events, result } = await collect(agent.run("deixa maiúsculo"));
  assertEquals(calls, [["uppercase", '{"text":"oi"}']]);
  assertEquals(responsesCb, ["OI"]);
  assertEquals(events.filter((e) => e.type === "tool_call").length, 1);
  assertEquals(events.filter((e) => e.type === "tool_result").length, 1);
  assertEquals(events.find((e) => e.type === "tool_result"), {
    type: "tool_result",
    tool: "uppercase",
    ok: true,
    output: "OI",
  });
  assertEquals(result.rounds, 2);
  assertEquals(result.toolCalls, 1);
  assertEquals(result.content.content, "OI");
});

Deno.test("self-healing: erro de tool volta ao contexto e o loop continua", async () => {
  let requestCount = 0;
  const responses: ResponsesCall = async (request) => {
    requestCount++;
    if (requestCount === 1) {
      return streamOf(toolRound("ferramenta_inexistente", "{}", "call_9"));
    }
    // O erro deve ter sido injetado como mensagem de sistema (§C).
    const systemMessages = request.input.filter(
      (item) => (item as { role?: string }).role === "system",
    );
    assertEquals(systemMessages.length, 1);
    const content = (systemMessages[0] as { content?: unknown })
      ?.content;
    assertEquals(
      String(content).includes('Erro na ferramenta "ferramenta_inexistente"'),
      true,
    );
    return streamOf(textRound("OK, corrigido"));
  };
  const agent = makeAgent(responses);

  const { events, result } = await collect(agent.run("tente"));
  const failed = events.find((e) => e.type === "tool_result");
  assertEquals(failed, {
    type: "tool_result",
    tool: "ferramenta_inexistente",
    ok: false,
    output:
      'Ferramenta desconhecida "ferramenta_inexistente". Disponível: uppercase',
  });
  assertEquals(result.rounds, 2);
  assertEquals(result.content.content, "OK, corrigido");
});

Deno.test("maxRounds interrompe loop infinito e poda limita o contexto", async () => {
  let maxSeen = 0;
  const responses: ResponsesCall = async (request) => {
    maxSeen = Math.max(maxSeen, request.input.length);
    return streamOf(toolRound("uppercase", '{"text":"oi"}'));
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 3 },
    { responses, maxContextItems: 3 },
  );
  agent.registryTool(uppercaseTool);

  const { result } = await collect(agent.run("repita"));
  assertEquals(result.rounds, 3);
  assertEquals(maxSeen <= 3, true);
});

Deno.test("cancel() aborta o stream com um evento aborted e sem lançar", async () => {
  const slow = (): AsyncIterable<Ev> => ({
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        yield {
          type: "response.output_text.delta",
          item_id: "m",
          output_index: 0,
          content_index: 0,
          delta: String(i),
          sequence_number: i,
        } as Ev;
      }
    },
  });
  const agent = makeAgent(async () => slow());

  const generator = agent.run("lento");
  const events: AgentEvent[] = [];
  let result;
  for (;;) {
    const { value, done } = await generator.next();
    if (done) {
      result = value;
      break;
    }
    events.push(value);
    if (value.type === "content") agent.cancel();
  }
  assertEquals(events.at(-1)?.type, "aborted");
  assertEquals(result !== undefined, true);
  assertEquals(result.rounds, 1);
});

Deno.test("erro no provider vira evento error e retorna resultado parcial", async () => {
  const agent = makeAgent(async () => {
    throw new Error("rede caiu");
  });
  const { events, result } = await collect(agent.run("x"));
  assertEquals(events.at(-1)?.type, "error");
  assertEquals(result.rounds, 1);
  assertEquals(result.content.content, "");
});

Deno.test("HITL: tool sensível aprovada via resume(true) executa normalmente", async () => {
  let requestCount = 0;
  const responses: ResponsesCall = async (request) => {
    requestCount++;
    if (requestCount === 1) {
      return streamOf(toolRound("sensitive_upper", '{"text":"oi"}'));
    }
    const outputs = request.input.filter(
      (item) => (item as { type?: string }).type === "function_call_output",
    );
    assertEquals(outputs.length, 1);
    assertEquals((outputs[0] as { output?: string }).output, "OI");
    return streamOf(textRound("OI"));
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys-prompt", maxRounds: 6 },
    { responses },
  );
  agent.registryTool(sensitiveTool);

  const generator = agent.run("maiúsculo");
  const events: AgentEvent[] = [];
  let result: TExecutionResult;
  let pausedSeen = false;
  for (;;) {
    const { value, done } = await generator.next();
    if (done) {
      result = value;
      break;
    }
    events.push(value);
    if (value.type === "tool_interrupt") {
      pausedSeen = agent.state === "paused";
      agent.resume(true);
    }
  }
  assertEquals(pausedSeen, true);
  assertEquals(events.filter((e) => e.type === "tool_interrupt").length, 1);
  assertEquals(events.filter((e) => e.type === "tool_denied").length, 0);
  assertEquals(events.find((e) => e.type === "tool_result"), {
    type: "tool_result",
    tool: "sensitive_upper",
    ok: true,
    output: "OI",
  });
  assertEquals(result!.toolCalls, 1);
  assertEquals(result!.rounds, 2);
  assertEquals(agent.state, "idle");
});

Deno.test("HITL: tool sensível recusada via resume(false) não executa", async () => {
  let requestCount = 0;
  const responses: ResponsesCall = async (request) => {
    requestCount++;
    if (requestCount === 1) {
      return streamOf(toolRound("sensitive_upper", '{"text":"oi"}'));
    }
    const outputs = request.input.filter(
      (item) => (item as { type?: string }).type === "function_call_output",
    );
    assertEquals(outputs.length, 1);
    assertEquals(
      (outputs[0] as { output?: string }).output,
      'Ação recusada pelo usuário. Não execute a ferramenta "sensitive_upper".',
    );
    return streamOf(textRound("ok, desisto"));
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys-prompt", maxRounds: 6 },
    { responses },
  );
  agent.registryTool(sensitiveTool);

  const generator = agent.run("maiúsculo");
  const events: AgentEvent[] = [];
  let result: TExecutionResult;
  for (;;) {
    const { value, done } = await generator.next();
    if (done) {
      result = value;
      break;
    }
    events.push(value);
    if (value.type === "tool_interrupt") agent.resume(false);
  }
  assertEquals(events.filter((e) => e.type === "tool_interrupt").length, 1);
  assertEquals(events.find((e) => e.type === "tool_denied"), {
    type: "tool_denied",
    tool: "sensitive_upper",
    args: '{"text":"oi"}',
    reason: "user",
  });
  assertEquals(events.filter((e) => e.type === "tool_result").length, 0);
  assertEquals(result!.toolCalls, 0);
  assertEquals(result!.rounds, 2);
  assertEquals(result!.content.content, "ok, desisto");
});

Deno.test("HITL: duas sensíveis no mesmo round, uma aprovada e uma recusada", async () => {
  let requestCount = 0;
  const responses: ResponsesCall = async (request) => {
    requestCount++;
    if (requestCount === 1) {
      return streamOf(
        toolRoundMany([
          { name: "sensitive_upper", args: '{"text":"a"}', call_id: "call_1" },
          { name: "sensitive_upper", args: '{"text":"b"}', call_id: "call_2" },
        ]),
      );
    }
    const outputs = request.input.filter(
      (item) => (item as { type?: string }).type === "function_call_output",
    );
    assertEquals(outputs.length, 2);
    return streamOf(textRound("fim"));
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys-prompt", maxRounds: 6 },
    { responses },
  );
  agent.registryTool(sensitiveTool);

  const generator = agent.run("dois");
  const events: AgentEvent[] = [];
  let interrupted = 0;
  let result: TExecutionResult;
  for (;;) {
    const { value, done } = await generator.next();
    if (done) {
      result = value;
      break;
    }
    events.push(value);
    if (value.type === "tool_interrupt") {
      interrupted++;
      agent.resume(interrupted === 1);
    }
  }
  assertEquals(interrupted, 2);
  assertEquals(events.filter((e) => e.type === "tool_result").length, 1);
  assertEquals(events.filter((e) => e.type === "tool_denied").length, 1);
  assertEquals(result!.toolCalls, 1);
  assertEquals(result!.rounds, 2);
});

Deno.test("HITL: resume() sem pendência lança erro claro", () => {
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys-prompt", maxRounds: 6 },
    { responses: async () => streamOf([]) },
  );
  let thrown = "";
  try {
    agent.resume(true);
  } catch (cause) {
    thrown = cause instanceof Error ? cause.message : String(cause);
  }
  assertEquals(thrown, "resume() sem tool_interrupt pendente.");
});

Deno.test("HITL: cancel() estando pausado encerra sem deadlock", async () => {
  const responses: ResponsesCall = async () =>
    streamOf(toolRound("sensitive_upper", '{"text":"oi"}'));
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys-prompt", maxRounds: 6 },
    { responses },
  );
  agent.registryTool(sensitiveTool);

  const generator = agent.run("x");
  const events: AgentEvent[] = [];
  let result: TExecutionResult | undefined;
  for (;;) {
    const { value, done } = await generator.next();
    if (done) {
      result = value;
      break;
    }
    events.push(value);
    if (value.type === "tool_interrupt") agent.cancel();
  }
  assertEquals(
    events.find((e) => e.type === "tool_interrupt") !== undefined,
    true,
  );
  assertEquals(events.at(-1)?.type, "aborted");
  assertEquals(result !== undefined, true);
  assertEquals(agent.state, "idle");
});

Deno.test("poda §B: summarizer condensa o prefixo e mantém as últimas interações", async () => {
  const summarizedPrefixes: Array<ResponseInputItemLike[]> = [];
  const responses: ResponsesCall = async (request) => {
    if (
      request.input[0] &&
      (request.input[0] as { role?: string }).role === "system"
    ) {
      const first = request.input[0] as { content?: unknown };
      assertEquals(
        String(first.content).startsWith("Resumo do contexto anterior:"),
        true,
      );
      assertEquals(String(first.content).includes("CONTEXTO RESUMIDO"), true);
      assertEquals(
        (request.input.at(-1) as { type?: string }).type,
        "function_call_output",
      );
      assertEquals(request.input.length, 3);
    }
    return streamOf(toolRound("uppercase", '{"text":"oi"}'));
  };
  const summarizer: Summarizer = async ({ messages }) => {
    summarizedPrefixes.push(messages as ResponseInputItemLike[]);
    return "CONTEXTO RESUMIDO";
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 4 },
    { responses, summarizer, summarizeKeepRecent: 2, maxContextItems: 3 },
  );
  agent.registryTool(uppercaseTool);

  const { result } = await collect(agent.run("loop de tools"));
  assertEquals(summarizedPrefixes.length, 2);
  const firstPrefix = summarizedPrefixes[0];
  assertEquals(firstPrefix.length, 3);
  assertEquals(
    (firstPrefix[0] as { role?: string }).role,
    "user",
  );
  assertEquals(result.summaries, 2);
  assertEquals(result.rounds, 4);
  assertEquals(result.toolCalls, 4);
});

Deno.test("poda §B: summarizer que lança/retorna vazio cai na poda determinística", async () => {
  let calls = 0;
  const responses: ResponsesCall = async () => {
    calls++;
    return streamOf(toolRound("uppercase", '{"text":"oi"}'));
  };
  const thrower: Summarizer = async () => {
    throw new Error("sumarizador fora do ar");
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 3 },
    {
      responses,
      summarizer: thrower,
      summarizeKeepRecent: 2,
      maxContextItems: 3,
    },
  );
  agent.registryTool(uppercaseTool);

  const { result } = await collect(agent.run("loop"));
  assertEquals(result.summaries, 0);
  assertEquals(result.rounds, 3);
  assertEquals(agent.state, "idle");
});

Deno.test("poda §B: cancel() durante a sumarização encerra sem deadlock", async () => {
  const hanging: Summarizer = async ({ signal }) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("abortado", "AbortError")),
      );
    });
  const responses: ResponsesCall = async () =>
    streamOf(toolRound("uppercase", '{"text":"oi"}'));
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 4 },
    {
      responses,
      summarizer: hanging,
      summarizeKeepRecent: 2,
      maxContextItems: 3,
    },
  );
  agent.registryTool(uppercaseTool);

  const generator = agent.run("loop");
  let result: TExecutionResult | undefined;
  let cancelled = false;
  for (;;) {
    const pending = generator.next();
    if (!cancelled) {
      cancelled = true;
      setTimeout(() => agent.cancel(), 1);
    }
    const { value, done } = await pending;
    if (done) {
      result = value;
      break;
    }
  }
  assertEquals(cancelled, true);
  assertEquals(result !== undefined, true);
  assertEquals(agent.state, "idle");
});
Deno.test("HITL avançado: resume(true, params) executa o override revalidado", async () => {
  let requestCount = 0;
  const responses: ResponsesCall = async (request) => {
    requestCount++;
    if (requestCount === 1) {
      return streamOf(toolRound("sensitive_upper", '{"text":"oi"}'));
    }
    const outputs = request.input.filter(
      (item) => (item as { type?: string }).type === "function_call_output",
    );
    assertEquals(outputs.length, 1);
    assertEquals((outputs[0] as { output?: string }).output, "OVERRIDE");
    const systems = request.input.filter(
      (item) => (item as { role?: string }).role === "system",
    );
    assertEquals(
      systems.some((s) =>
        String((s as { content?: unknown }).content).includes(
          "ajustados pelo usuário",
        )
      ),
      true,
    );
    return streamOf(textRound("ok"));
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 6 },
    { responses },
  );
  agent.registryTool(sensitiveTool);

  const generator = agent.run("x");
  const events: AgentEvent[] = [];
  let result: TExecutionResult;
  for (;;) {
    const { value, done } = await generator.next();
    if (done) {
      result = value;
      break;
    }
    if (value.type === "tool_interrupt") {
      agent.resume(true, { text: "override" });
    }
    events.push(value);
  }
  assertEquals(events.find((e) => e.type === "tool_result"), {
    type: "tool_result",
    tool: "sensitive_upper",
    ok: true,
    output: "OVERRIDE",
  });
  assertEquals(result!.toolCalls, 1);
  assertEquals(result!.rounds, 2);
});

Deno.test("HITL avançado: override inválido vira self-healing", async () => {
  let requestCount = 0;
  const responses: ResponsesCall = async (request) => {
    requestCount++;
    if (requestCount === 1) {
      return streamOf(toolRound("sensitive_upper", '{"text":"oi"}'));
    }
    const systems = request.input.filter(
      (item) => (item as { role?: string }).role === "system",
    );
    assertEquals(
      systems.some((s) =>
        String((s as { content?: unknown }).content).includes(
          "Erro na ferramenta",
        )
      ),
      true,
    );
    return streamOf(textRound("corrigido"));
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 6 },
    { responses },
  );
  agent.registryTool(sensitiveTool);

  const generator = agent.run("x");
  const events: AgentEvent[] = [];
  let result: TExecutionResult;
  for (;;) {
    const { value, done } = await generator.next();
    if (done) {
      result = value;
      break;
    }
    if (value.type === "tool_interrupt") agent.resume(true, { text: 123 });
    events.push(value);
  }
  const toolResult = events.find((e) => e.type === "tool_result");
  assertEquals(toolResult !== undefined, true);
  assertEquals(toolResult!.ok, false);
  assertEquals(result!.rounds, 2);
  assertEquals(result!.content.content, "corrigido");
});

Deno.test("HITL avançado: approvalTimeoutMs auto-recusa sem decisão", async () => {
  let requestCount = 0;
  const responses: ResponsesCall = async () => {
    requestCount++;
    if (requestCount === 1) {
      return streamOf(toolRound("sensitive_upper", '{"text":"oi"}'));
    }
    return streamOf(textRound("final"));
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 6 },
    { responses, approvalTimeoutMs: 5 },
  );
  agent.registryTool(sensitiveTool);

  const { events, result } = await collect(agent.run("x"));
  const denied = events.find((e) => e.type === "tool_denied");
  assertEquals(denied, {
    type: "tool_denied",
    tool: "sensitive_upper",
    args: '{"text":"oi"}',
    reason: "timeout",
  });
  assertEquals(events.filter((e) => e.type === "tool_interrupt").length, 1);
  assertEquals(result.toolCalls, 0);
  assertEquals(result.rounds, 2);
  assertEquals(result.content.content, "final");
  assertEquals(agent.state, "idle");
});

Deno.test("HITL avançado: resume(false, params) ignora params e recusa", async () => {
  const responses: ResponsesCall = async () =>
    streamOf(toolRound("sensitive_upper", '{"text":"oi"}'));
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 3 },
    { responses, approvalTimeoutMs: 200 },
  );
  agent.registryTool(sensitiveTool);

  const generator = agent.run("x");
  const events: AgentEvent[] = [];
  for (;;) {
    const { value, done } = await generator.next();
    if (done) break;
    events.push(value);
    if (value.type === "tool_interrupt") {
      agent.resume(false, { text: "substituir" });
    }
  }
  assertEquals(events.find((e) => e.type === "tool_denied"), {
    type: "tool_denied",
    tool: "sensitive_upper",
    args: '{"text":"oi"}',
    reason: "user",
  });
  assertEquals(
    events.some((e) => e.type === "tool_result"),
    false,
  );
});

Deno.test("poda §B (tokens): uso real do provider dispara a condensação", async () => {
  const summarized: Array<ResponseInputItemLike[]> = [];
  let sawSummary = false;
  const responses: ResponsesCall = async (request) => {
    const first = request.input[0] as ResponseInputItemLike | undefined;
    if (first?.role === "system") {
      sawSummary = true;
      assertEquals(String(first.content).includes("CONTEXTO RESUMIDO"), true);
    }
    return streamOf(toolRound("uppercase", '{"text":"oi"}'));
  };
  const summarizer: Summarizer = async ({ messages }) => {
    summarized.push(messages as ResponseInputItemLike[]);
    return "CONTEXTO RESUMIDO";
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 4 },
    {
      responses,
      summarizer,
      summarizeKeepRecent: 2,
      maxContextTokens: 2, // budget 1.6 — o uso real (2) estoura
      tokenEstimator: () => 0, // desliga o estimador: gatilho só via medição
    },
  );
  agent.registryTool(uppercaseTool);

  const { result } = await collect(agent.run("loop"));
  assertEquals(sawSummary, true);
  assertEquals(result.summaries >= 1, true);
  assertEquals(summarized.length >= 1, true);
});

Deno.test("poda §B (tokens): sem usage da API, o estimador dispara o trigger", async () => {
  let requestCount = 0;
  const longText = "a".repeat(300);
  const responses: ResponsesCall = async (request) => {
    requestCount++;
    if (requestCount === 1) {
      return streamOf(
        toolRoundNoUsage("uppercase", JSON.stringify({ text: longText })),
      );
    }
    const first = request.input[0] as ResponseInputItemLike | undefined;
    assertEquals(first?.role, "system");
    assertEquals(first === undefined, false);
    assertEquals(
      String(first!.content).startsWith("Resumo do contexto anterior:"),
      true,
    );
    return streamOf(textRoundNoUsage("fim"));
  };
  const summarizer: Summarizer = async () => "CONTEXTO RESUMIDO";
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 3 },
    { responses, summarizer, summarizeKeepRecent: 2, maxContextTokens: 4 },
  );
  agent.registryTool(uppercaseTool);

  const { result } = await collect(agent.run("loop"));
  assertEquals(requestCount, 2);
  assertEquals(result.summaries, 1);
  assertEquals(result.rounds, 2);
});

Deno.test("poda §B (tokens): sem maxContextTokens o trigger fica desligado", async () => {
  let summarizerCalls = 0;
  const responses: ResponsesCall = async () =>
    streamOf(toolRound("uppercase", '{"text":"oi"}'));
  const summarizer: Summarizer = async () => {
    summarizerCalls++;
    return "X";
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 3 },
    {
      responses,
      summarizer,
      summarizeKeepRecent: 2,
      tokenEstimator: () => 1_000_000,
    },
  );
  agent.registryTool(uppercaseTool);

  const { result } = await collect(agent.run("loop"));
  assertEquals(summarizerCalls, 0);
  assertEquals(result.summaries, 0);
  assertEquals(result.toolCalls, 3);
});

Deno.test("initialMessages: histórico semeado entra no primeiro round", async () => {
  const responses: ResponsesCall = async (request) => {
    assertEquals(request.input.length, 3);
    assertEquals((request.input[0] as { role?: string }).role, "system");
    assertEquals((request.input[1] as { role?: string }).role, "user");
    const last = request.input[2] as {
      role?: string;
      content?: unknown[];
    };
    assertEquals(last.content, [{ type: "input_text", text: "nova pergunta" }]);
    return streamOf(textRound("ok"));
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 2 },
    {
      responses,
      initialMessages: [
        { role: "system", content: [{ type: "input_text", text: "seed sys" }] },
        { role: "user", content: [{ type: "input_text", text: "seed user" }] },
      ],
    },
  );

  const { result } = await collect(agent.run("nova pergunta"));
  assertEquals(result.content.content, "ok");
});

Deno.test("modelParams: repassados ao request do round", async () => {
  const responses: ResponsesCall = async (request) => {
    assertEquals(
      (request.modelParams as Record<string, unknown>)["num_ctx"],
      8192,
    );
    assertEquals(
      (request.modelParams as Record<string, unknown>)["temperature"],
      0.2,
    );
    assertEquals((request.modelParams as Record<string, unknown>)["seed"], 42);
    return streamOf(textRound("ok"));
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 2 },
    { responses, modelParams: { num_ctx: 8192, temperature: 0.2, seed: 42 } },
  );

  const { result } = await collect(agent.run("oi"));
  assertEquals(result.content.content, "ok");
});

Deno.test("format: repassado ao request do round", async () => {
  const responses: ResponsesCall = async (request) => {
    assertEquals(request.format, "json");
    return streamOf(textRound("qualquer"));
  };
  const agent = new ReAct(
    { model: "model-x", system_prompt: "sys", maxRounds: 2 },
    { responses, format: "json" },
  );

  await collect(agent.run("oi"));
});

Deno.test("runParts: primeiro item do usuário carrega texto + imagem", async () => {
  const responses: ResponsesCall = async (request) => {
    const first = request.input[0] as {
      role?: string;
      content?: Array<{ type: string; text?: string; image_url?: string }>;
    };
    assertEquals(first.role, "user");
    const parts = first.content as Array<
      { type: string; text?: string; image_url?: string }
    >;
    assertEquals(parts[0], { type: "input_text", text: "O que tem?" });
    assertEquals(parts[1].type, "input_image");
    assertEquals(parts[1].image_url, "data:image/png;base64,AABB");
    return streamOf(textRound("descrevi"));
  };
  const agent = makeAgent(responses);

  const { result } = await collect(agent.runParts([
    { type: "input_text", text: "O que tem?" },
    { type: "input_image", image_url: "data:image/png;base64,AABB" },
  ]));
  assertEquals(result.content.content, "descrevi");
});
