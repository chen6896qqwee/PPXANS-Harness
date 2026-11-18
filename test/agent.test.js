// test/agent.test.js - 核心冒烟测试
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

test("agent 启动 + 自愈", () => {
  const agent = new PPXAgent({ root: tmpRoot("agent") });
  assert.ok(agent.persona, "persona 加载");
  assert.ok(agent.facts, "fact store 加载");
  assert.ok(agent.memory, "memory ticker 加载");
  assert.ok(agent.experience, "experience 加载");
  assert.ok(agent.health, "自愈检查执行");
  agent.shutdown();
});

test("记忆写入与检索", () => {
  const agent = new PPXAgent({ root: tmpRoot("agent") });
  const before = agent.facts.count();
  const f = agent.facts.add("皮皮虾喜欢实时数据胜过猜测", { type: "test" });
  assert.ok(f.id);
  const results = agent.facts.query("皮皮虾", { limit: 3 });
  assert.ok(Array.isArray(results));
  assert.ok(agent.facts.count() >= before + 1);
  agent.shutdown();
});

test("experience 学习", () => {
  const agent = new PPXAgent({ root: tmpRoot("agent") });
  agent.experience.learn({ task: "测试", lesson: "零依赖比第三方依赖更稳", tags: ["test"] });
  const recalled = agent.experience.recall("稳定");
  assert.ok(Array.isArray(recalled));
  agent.shutdown();
});

test("PII 脱敏", async () => {
  const agent = new PPXAgent({ root: tmpRoot("agent") });
  const { scrubPII } = await import("../src/utils/pii.js");
  const r = scrubPII("我的 key 是 sk-abcdefghij1234567890qwerty");
  assert.ok(r.cleaned.includes("[REDACTED]"));
  assert.ok(r.detected.includes("api_key"));
  agent.shutdown();
});

test("离线聊天 (无 LLM)", async () => {
  const agent = new PPXAgent({ root: tmpRoot("agent") });
  const reply = await agent.chat("你好皮皮虾");
  assert.ok(typeof reply === "string");
  assert.ok(reply.length > 0);
  agent.shutdown();
});

// 2026-10-30: 轮次 off-by-one 回归守卫。runToolLoop 的 round 从 0 起算 (首轮 = 0),
//   agent._llmWithTools 的 onStep 必须记成 round+1, 否则单次生成永远显示 "0 轮" (且 0 是
//   falsy, 前端连"轮"前缀都不出现)。用桩 LLM 走一轮直接返回, 不依赖真实模型。
test("lastRun 轮次从 1 起算 (off-by-one 回归)", async () => {
  const agent = new PPXAgent({ root: tmpRoot("agent") });
  const stubLlm = {
    model: "stub",
    context_window: 8192,
    apiChat: async () => ({ message: { content: "好的", tool_calls: [] }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  };
  await agent._llmWithTools([{ role: "user", content: "hi" }], stubLlm);
  assert.ok(agent.lastRun, "lastRun 应被记录");
  assert.strictEqual(agent.lastRun.rounds, 1, `单次生成应记 1 轮 (0 索引 + 1), 实际 ${agent.lastRun && agent.lastRun.rounds}`);
  agent.shutdown();
});

test("interrupt 后新一轮 chat 自动复位中断状态", async () => {
  const agent = new PPXAgent({ root: tmpRoot("agent") });
  agent.interrupt();
  assert.equal(agent._interrupted, true);
  await agent.chat("你好"); // chat 开始应 clearInterrupt
  assert.equal(agent._interrupted, false, "新一轮对话应复位中断状态");
  agent.shutdown();
});
