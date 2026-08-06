import { assertEquals } from "@std/assert";
import { ollamaTask } from "./ollamaTask.ts";

Deno.test("ollamaTask - builder methods return this for chaining", () => {
  const task = new ollamaTask("test-model");
  const result = task
    .system("sys")
    .user("usr")
    .format("json")
    .maxIterations(5)
    .onThinking(() => {})
    .onContent(() => {})
    .onToolCall(() => {})
    .onToolResult(() => {});

  assertEquals(result, task);
});

Deno.test("ollamaTask - constructor stores model name", () => {
  const task = new ollamaTask("my-model");
  assertEquals(task["_model"], "my-model");
});

Deno.test("ollamaTask - system and user add messages", () => {
  const task = new ollamaTask("m")
    .system("Be helpful")
    .user("Hello");

  assertEquals(task["_messages"].length, 2);
  assertEquals(task["_messages"][0].role, "system");
  assertEquals(task["_messages"][0].content, "Be helpful");
  assertEquals(task["_messages"][1].role, "user");
  assertEquals(task["_messages"][1].content, "Hello");
});

Deno.test("ollamaTask - tools and handlers stored", () => {
  const toolDef = {
    type: "function" as const,
    function: {
      name: "test",
      description: "test tool",
      parameters: { type: "object" as const, properties: {} },
    },
  };
  const handler = { name: "test", execute: () => "ok" };

  const task = new ollamaTask("m")
    .tools([toolDef])
    .toolHandlers([handler]);

  assertEquals(task["_tools"]?.length, 1);
  assertEquals(task["_handlers"]?.length, 1);
});

Deno.test("ollamaTask - format and maxIterations stored", () => {
  const task = new ollamaTask("m")
    .format("json")
    .maxIterations(3);

  assertEquals(task["_format"], "json");
  assertEquals(task["_maxIterations"], 3);
});

Deno.test("ollamaTask - callbacks stored", () => {
  const onThinking = () => {};
  const onContent = () => {};
  const onToolCall = () => {};
  const onToolResult = () => {};

  const task = new ollamaTask("m")
    .onThinking(onThinking)
    .onContent(onContent)
    .onToolCall(onToolCall)
    .onToolResult(onToolResult);

  assertEquals(task["_onThinking"], onThinking);
  assertEquals(task["_onContent"], onContent);
  assertEquals(task["_onToolCall"], onToolCall);
  assertEquals(task["_onToolResult"], onToolResult);
});
