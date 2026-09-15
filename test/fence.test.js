import test from "node:test";
import assert from "node:assert";
import { parseToolFence } from "../src/llm/fence.js";
import { LLMClient } from "../src/llm/client.js";

test("supportsNativeToolCalls: 自研 http 底座恒 true", () => {
  assert.equal(new LLMClient({ id: "x", base_url: "http://127.0.0.1:1/v1", api_key: "k" }).supportsNativeToolCalls, true);
});

test("解析单个围栏 + 剥离文本", () => {
  const { calls, clean } = parseToolFence("我来读文件 ⟪tool:read_file│{\"path\":\"/tmp/a.txt\"}⟫ 完成");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "read_file");
  assert.equal(JSON.parse(calls[0].function.arguments).path, "/tmp/a.txt");
  assert.ok(!clean.includes("⟪"));
  assert.ok(clean.includes("我来读文件"));
});

test("解析多个围栏", () => {
  const { calls } = parseToolFence("⟪tool:a│{\"x\":1}⟫⟪tool:b│{}⟫");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, "a");
  assert.equal(calls[1].function.name, "b");
});

test("无效参数回退空对象不抛", () => {
  const { calls } = parseToolFence("⟪tool:x│不是json⟫");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]._args, {});
});

test("无围栏 clean 原样", () => {
  const { calls, clean } = parseToolFence("普通回复");
  assert.equal(calls.length, 0);
  assert.equal(clean, "普通回复");
});
