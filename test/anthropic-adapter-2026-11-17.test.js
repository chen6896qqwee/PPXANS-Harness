// test/anthropic-adapter-2026-11-17.test.js — Anthropic Messages 协议适配器 (纯函数, 零网络)
// 钉住: wire messages → Anthropic blocks 转换 (system 分离/tool_use/tool_result/交替合并/图片)、
// buildBody (thinking 预算/温度钳制/tools 映射/流式)、parseResponse (text/reasoning/tool_use)。
import test from "node:test";
import assert from "node:assert/strict";
import { toAnthropicMessages, anthropicMessages } from "../src/llm/adapters/anthropic.js";

test("anthropic: system 分离 + user/assistant 交替", () => {
  const r = toAnthropicMessages([
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
    { role: "assistant", content: "好的" },
    { role: "user", content: "继续" },
  ]);
  assert.equal(r.system, "你是助手");
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[0].role, "user");
  assert.equal(r.messages[1].role, "assistant");
  assert.equal(r.messages[2].role, "user");
});

test("anthropic: 连续同角色合并 (Anthropic 要求交替)", () => {
  const r = toAnthropicMessages([
    { role: "user", content: "第一条" },
    { role: "user", content: "第二条" },
  ]);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].content.length, 2);
});

test("anthropic: tool_use 与 tool_result 往返", () => {
  const r = toAnthropicMessages([
    { role: "user", content: "跑命令" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "run_command", arguments: '{"command":"echo hi"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "hi" },
  ]);
  const asst = r.messages.find((m) => m.role === "assistant");
  assert.ok(asst.content.some((b) => b.type === "tool_use" && b.id === "call_1" && b.name === "run_command"));
  const user = r.messages.find((m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"));
  assert.ok(user, "tool 消息转为 user 的 tool_result 块");
});

test("anthropic: 图片 base64 与 url 两种 source", () => {
  const r = toAnthropicMessages([
    { role: "user", content: [
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } },
    ] },
  ]);
  assert.ok(r.messages[0].content.some((b) => b.type === "image" && b.source.type === "base64"));
  const r2 = toAnthropicMessages([
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }] },
  ]);
  assert.ok(r2.messages[0].content.some((b) => b.type === "image" && b.source.type === "url"));
});

test("anthropic: buildBody tools 映射 + thinking 预算 + 温度钳制", () => {
  const tools = [{ type: "function", function: { name: "read_file", description: "读文件", parameters: { type: "object" } } }];
  const body = anthropicMessages.buildBody({
    model: "claude-3", messages: [{ role: "user", content: "hi" }],
    tools, maxTokens: 4096, temperature: 0.7,
  });
  assert.ok(body.tools.length === 1 && body.tools[0].name === "read_file");
  assert.deepEqual(body.tool_choice, { type: "auto" });
  assert.ok(!body.thinking, "auto 不发 thinking");
  assert.equal(body.temperature, 0.7);

  const think = anthropicMessages.buildBody({
    model: "claude-3", messages: [{ role: "user", content: "hi" }],
    maxTokens: 4096, reasoning: "low",
  });
  assert.ok(think.thinking && think.thinking.budget_tokens < 4096, "thinking 预算 < max_tokens");
  assert.ok(!("temperature" in think), "开 thinking 时无 temperature");
});

test("anthropic: buildBody 流式与 extraBody 透传", () => {
  const body = anthropicMessages.buildBody({
    model: "m", messages: [{ role: "user", content: "hi" }],
    stream: true, extraBody: { metadata: { user_id: "u1" } },
  });
  assert.equal(body.stream, true);
  assert.equal(body.metadata.user_id, "u1");
});

test("anthropic: parseResponse 提取 text/reasoning/tool_use", () => {
  const r = anthropicMessages.parseResponse({
    content: [
      { type: "thinking", thinking: "先想想" },
      { type: "text", text: "答案" },
      { type: "tool_use", id: "tu1", name: "read_file", input: { path: "a" } },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
    stop_reason: "tool_use",
  });
  assert.equal(r.message.content, "答案");
  assert.equal(r.message.reasoning_content, "先想想");
  assert.equal(r.message.tool_calls.length, 1);
  assert.equal(r.message.tool_calls[0].function.name, "read_file");
});

