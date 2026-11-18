// test/responses-adapter-2026-11-17.test.js — OpenAI Responses 协议适配器 (纯函数, 零网络)
// 钉住: system→instructions 分离、tool→扁平 function、content blocks 转换、buildBody 各分支、
// parseResponse 聚合兜底、createStreamAcc SSE 事件聚合。
import test from "node:test";
import assert from "node:assert/strict";
import { openaiResponses } from "../src/llm/adapters/responses.js";

test("responses: buildBody system 走 instructions, user 走 input_text", () => {
  const body = openaiResponses.buildBody({
    model: "o3", messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
    ], maxTokens: 4096,
  });
  assert.equal(body.instructions, "你是助手");
  assert.equal(body.input[0].role, "user");
  assert.equal(body.input[0].content[0].type, "input_text");
  assert.equal(body.input[0].content[0].text, "你好");
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 4096);
  assert.ok(!body.tools, "无工具时不发 tools");
});

test("responses: tool 结果转 function_call_output, assistant tool_calls 转 function_call", () => {
  const body = openaiResponses.buildBody({
    model: "o3", messages: [
      { role: "user", content: "跑命令" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "run_command", arguments: '{"cmd":"echo"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "hi" },
    ],
  });
  assert.ok(body.input.some((x) => x.type === "function_call" && x.call_id === "c1" && x.name === "run_command"));
  assert.ok(body.input.some((x) => x.type === "function_call_output" && x.call_id === "c1" && x.output === "hi"));
});

test("responses: tools 扁平映射 (嵌套 function → 扁平)", () => {
  const body = openaiResponses.buildBody({
    model: "o3", messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read_file", description: "读", parameters: { type: "object" } } }],
  });
  assert.ok(body.tools.length === 1);
  assert.equal(body.tools[0].name, "read_file");
  assert.equal(body.tool_choice, "auto");
});

test("responses: reasoning 档位映射, max 钳制到 high", () => {
  const low = openaiResponses.buildBody({ model: "o3", messages: [{ role: "user", content: "hi" }], reasoning: "low" });
  assert.deepEqual(low.reasoning, { effort: "low" });
  const max = openaiResponses.buildBody({ model: "o3", messages: [{ role: "user", content: "hi" }], reasoning: "max" });
  assert.deepEqual(max.reasoning, { effort: "high" }, "max 钳制到 high");
  const off = openaiResponses.buildBody({ model: "o3", messages: [{ role: "user", content: "hi" }] });
  assert.ok(!off.reasoning, "无 reasoning 时不发");
});

test("responses: 流式与 extraBody 透传", () => {
  const body = openaiResponses.buildBody({
    model: "o3", messages: [{ role: "user", content: "hi" }],
    stream: true, extraBody: { metadata: { user_id: "u1" } },
  });
  assert.equal(body.stream, true);
  assert.equal(body.metadata.user_id, "u1");
});

test("responses: parseResponse output_text + function_call", () => {
  const r = openaiResponses.parseResponse({
    output: [
      { type: "message", content: [{ type: "output_text", text: "答案" }] },
      { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a"}' },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  assert.equal(r.message.content, "答案");
  assert.equal(r.message.tool_calls.length, 1);
  assert.equal(r.message.tool_calls[0].function.name, "read_file");
});

test("responses: parseResponse output_text 聚合兜底", () => {
  const r = openaiResponses.parseResponse({ output_text: "聚合文本", output: [] });
  assert.equal(r.message.content, "聚合文本");
  assert.equal(r.message.tool_calls, null);
});

test("responses: parseResponse 全空返回 null", () => {
  assert.equal(openaiResponses.parseResponse({ output: [] }), null);
});

test("responses: createStreamAcc 聚合 output_text.delta + function_call", () => {
  const acc = openaiResponses.createStreamAcc();
  acc.feed({ type: "response.output_text.delta", delta: "你好" });
  acc.feed({ type: "response.output_text.delta", delta: "世界" });
  acc.feed({ type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "c1", name: "run_command" } });
  acc.feed({ type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"cm' });
  acc.feed({ type: "response.function_call_arguments.delta", item_id: "fc1", delta: 'd":"echo"}' });
  acc.feed({ type: "response.function_call_arguments.done", item_id: "fc1", arguments: '{"command":"echo"}' });
  acc.feed({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 10 } } });
  const r = acc.result();
  assert.equal(r.message.content, "你好世界");
  assert.ok(r.message.tool_calls.length === 1);
  assert.equal(r.message.tool_calls[0].function.arguments, '{"command":"echo"}');
  assert.equal(r.usage.total_tokens, 15);
});

test("responses: createStreamAcc 失败事件抛错", () => {
  const acc = openaiResponses.createStreamAcc();
  acc.feed({ type: "response.failed", response: { error: { message: "rate limit" } } });
  assert.throws(() => acc.result(), /LLM Responses 流失败.*rate limit/);
});

test("responses: modelsUrl 与 parseModels", () => {
  assert.equal(openaiResponses.modelsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
  const models = openaiResponses.parseModels({ data: [{ id: "o3" }, { id: "o4-mini" }] });
  assert.ok(Array.isArray(models));
});
