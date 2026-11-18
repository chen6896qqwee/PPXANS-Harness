import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { SessionStore, EVENTS } from "../src/memory/session.js";
import { buildCompactionMessages, transcriptToText } from "../src/memory/compaction.js";

function tmpRoot(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

test("compaction: buildCompactionMessages 结构", () => {
  const msgs = buildCompactionMessages("用户: 你好\n助手: 在的");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.ok(msgs[0].content.includes("目标"), "结构化格式含目标小节");
  assert.equal(msgs[1].role, "user");
});

test("compaction: transcriptToText 角色转中文", () => {
  const t = transcriptToText([
    { role: "user", content: "你好" },
    { role: "assistant", content: "在的" },
  ]);
  assert.ok(t.includes("用户: 你好"));
  assert.ok(t.includes("助手: 在的"));
});

test("session: deriveCompacted 用摘要替换被压缩区间, deriveMessages 不受影响", () => {
  const root = tmpRoot("comp");
  const ss = new SessionStore(root);
  ss.append("k", EVENTS.USER, { content: "m1" });
  ss.append("k", EVENTS.ASSISTANT, { content: "r1" });
  ss.append("k", EVENTS.USER, { content: "m2" });
  ss.append("k", EVENTS.ASSISTANT, { content: "r2" });
  ss.append("k", EVENTS.COMPACTION, { summary: "【摘要】前两轮", upToSeq: 4 });
  ss.append("k", EVENTS.USER, { content: "m3" });
  ss.append("k", EVENTS.ASSISTANT, { content: "r3" });

  const msgs = ss.deriveCompacted("k");
  assert.equal(msgs.length, 3, "摘要 + m3 + r3");
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "【摘要】前两轮");
  assert.equal(msgs[1].content, "m3");
  assert.equal(msgs[2].content, "r3");

  // deriveMessages 仍是原始完整投影 (不可变日志未被改动)
  assert.equal(ss.deriveMessages("k").length, 6);
  fs.rmSync(root, { recursive: true, force: true });
});

test("agent._maybeCompact: 超阈值生成结构化摘要并持久化", async () => {
  const root = tmpRoot("comp2");
  const a = new PPXAgent({ root });
  a.llm = { chat: async () => ({ content: "结构化摘要" }) };
  a.config.memory.history_token_budget = 20; // 压低预算触发压缩
  for (let i = 0; i < 10; i++) {
    a._pushTurn("k", "这是一条比较长的用户消息用于触发压缩测试编号" + i, "这是一条比较长的助手回复内容用于测试" + i);
  }
  await a._maybeCompact("k");
  const comps = a.sessionStore.replay("k").filter((e) => e.type === EVENTS.COMPACTION);
  assert.equal(comps.length, 1, "生成 1 条 compaction 事件");
  assert.equal(comps[0].data.summary, "结构化摘要");
  const msgs = a.sessionStore.deriveCompacted("k");
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "结构化摘要");
  a.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("agent._maybeCompact: 未超阈值不调 LLM", async () => {
  const root = tmpRoot("comp3");
  const a = new PPXAgent({ root });
  let calls = 0;
  a.llm = { chat: async () => { calls++; return { content: "x" }; } };
  a.config.memory.history_token_budget = 100000;
  a._pushTurn("k", "短消息", "短回复");
  await a._maybeCompact("k");
  assert.equal(calls, 0, "未超阈值不调 LLM");
  a.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("agent._maybeCompact: 无 LLM 时跳过压缩", async () => {
  const root = tmpRoot("comp4");
  const a = new PPXAgent({ root });
  a.config.memory.history_token_budget = 1;
  a._pushTurn("k", "长消息".repeat(50), "回复".repeat(50));
  await a._maybeCompact("k"); // 无 llm, 应静默跳过不抛错
  assert.equal(a.sessionStore.replay("k").filter((e) => e.type === EVENTS.COMPACTION).length, 0);
  a.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
