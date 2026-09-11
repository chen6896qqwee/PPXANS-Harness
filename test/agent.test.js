// test/agent.test.js - 核心冒烟测试
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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

test("interrupt 后新一轮 chat 自动复位中断状态", async () => {
  const agent = new PPXAgent({ root: tmpRoot("agent") });
  agent.interrupt();
  assert.equal(agent._interrupted, true);
  await agent.chat("你好"); // chat 开始应 clearInterrupt
  assert.equal(agent._interrupted, false, "新一轮对话应复位中断状态");
  agent.shutdown();
});
