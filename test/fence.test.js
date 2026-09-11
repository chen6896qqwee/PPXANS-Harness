import test from "node:test";
import assert from "node:assert";
import { parseToolFence, buildFencePrompt, proxyToolLoop } from "../src/llm/fence.js";
import { LLMClient } from "../src/llm/client.js";

test("supportsNativeToolCalls: http 后端 true, openclaw/dsh 围栏后端 false", () => {
  assert.equal(new LLMClient({ id: "x", base_url: "http://127.0.0.1:1/v1", api_key: "k" }).supportsNativeToolCalls, true);
  assert.equal(new LLMClient({ id: "openclaw", backend: "openclaw" }).supportsNativeToolCalls, false);
  assert.equal(new LLMClient({ id: "dsh", backend: "deepseek" }).supportsNativeToolCalls, false);
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

test("buildFencePrompt 含协议与清单", () => {
  const p = buildFencePrompt([{ function: { name: "read_file", description: "读文件" } }]);
  assert.ok(p.includes("⟪tool:read_file"));
  assert.ok(p.includes("read_file: 读文件"));
});

test("proxyToolLoop: 引擎先围栏后回复", async () => {
  const replies = [
    "⟪tool:get_time│{}⟫",
    "当前时间 14:35",
  ];
  let i = 0;
  const engineReply = async (ctx) => {
    assert.ok(ctx === undefined || ctx.includes("工具")); // 第二轮应带结果
    return replies[i++];
  };
  const toolRunner = async (name, args) => {
    assert.equal(name, "get_time");
    return "2026-08-16 14:35:00";
  };
  const final = await proxyToolLoop(engineReply, toolRunner);
  assert.equal(final, "当前时间 14:35");
});

test("proxyToolLoop: 引擎一直围栏, 轮次上限截停", async () => {
  const engineReply = async () => "⟪tool:a│{}⟫";
  const toolRunner = async () => "ok";
  const final = await proxyToolLoop(engineReply, toolRunner, { maxRounds: 3 });
  assert.ok(final.includes("轮次过多"));
});

test("proxyToolLoop: 引擎一直围栏, 轮次上限截停2", async () => {
  const engineReply = async () => "⟪tool:a│{}⟫";
  const toolRunner = async () => "ok";
  const final = await proxyToolLoop(engineReply, toolRunner, { maxRounds: 3 });
  assert.ok(final.includes("轮次过多"));
});

test("proxyToolLoop: 工具执行失败也返回结果喂回", async () => {
  let i = 0;
  const engineReply = async () => i++ === 0 ? "⟪tool:bad│{}⟫" : "收尾";
  const toolRunner = async (n) => { throw new Error("boom"); };
  const final = await proxyToolLoop(engineReply, toolRunner);
  assert.equal(final, "收尾");
});
