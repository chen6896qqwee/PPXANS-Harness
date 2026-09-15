// test/session.test.js - 会话持久化 (重启不丢)
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

test("会话写入后可跨实例恢复 (持久化)", async () => {
  const root = tmpRoot("ses");
  const a = new PPXAgent({ root });
  a._pushTurn("k1", "你好", "在的兄弟");
  a._pushTurn("k1", "记住", "好的");
  a.resetSession("tmp"); // 不存在的 key, 应安全
  a.shutdown();

  // 模拟重启: 新 agent 同 root
  const b = new PPXAgent({ root });
  const hist = await b._loadHistory("k1");
  assert.ok(hist.length >= 4, "恢复 4 条, got " + hist.length);
  assert.ok(hist.some((m) => m.content === "记住"), "内容正确");
  b.shutdown();
});

test("resetSession 同时清除磁盘文件", () => {
  const root = tmpRoot("ses");
  const a = new PPXAgent({ root });
  a._pushTurn("k2", "x", "y");
  assert.ok(a.sessionStore.has("k2"), "写入后存在");
  a.resetSession("k2");
  assert.ok(!a.sessionStore.has("k2"), "重置后清除");
  a.shutdown();
});

// ---- 新架构: 会话事件日志 (吸收 dsh "会话即唯一事实源") ----
import { SessionStore, EVENTS } from "../src/memory/session.js";

test("会话事件日志: append 不可变 + derive 投影", () => {
  const root = tmpRoot("evlog");
  const ss = new SessionStore(root);
  ss.append("k", EVENTS.USER, { content: "你好" });
  ss.append("k", EVENTS.ASSISTANT, { content: "在的" });
  ss.append("k", EVENTS.SYSTEM, { content: "注入" });
  ss.append("k", EVENTS.TOOL_CALL, { name: "run_command" });
  // 日志不可变: seq 递增, 含全部事件 (system/tool 也记录)
  const evs = ss.replay("k");
  assert.equal(evs.length, 4, "4 条事件全保留");
  assert.deepEqual(evs.map(e=>e.seq), [1,2,3,4], "seq 递增");
  // derive 只投影 user/assistant (模型可见历史)
  const msgs = ss.deriveMessages("k");
  assert.equal(msgs.length, 2, "投影出 2 条对话");
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].role, "assistant");
  // 跨实例重启: 事件日志完整恢复
  const ss2 = new SessionStore(root);
  assert.equal(ss2.replay("k").length, 4, "重启后事件日志完整");
  fs.rmSync(root, { recursive: true, force: true });
});

test("会话事件日志: fork 从边界派生新会话, 源不可变", () => {
  const root = tmpRoot("fork");
  const ss = new SessionStore(root);
  ss.append("a", EVENTS.USER, { content: "m1" });
  ss.append("a", EVENTS.ASSISTANT, { content: "r1" });
  ss.append("a", EVENTS.USER, { content: "m2" });
  ss.append("a", EVENTS.ASSISTANT, { content: "r2" });
  // fork 到 seq<=2 (只保留第1轮)
  const kept = ss.fork("a", 2, "b");
  assert.equal(kept.length, 2, "fork 保留边界内事件");
  assert.equal(ss.deriveMessages("b").length, 2, "新会话只有第1轮");
  assert.equal(ss.deriveMessages("a").length, 4, "源会话不受影响");
  fs.rmSync(root, { recursive: true, force: true });
});

test("代理 _pushTurn 写事件日志, 历史含 assistant", async () => {
  const root = tmpRoot("push");
  const a = new PPXAgent({ root });
  a._pushTurn("k", "问", "答");
  assert.equal(a.sessionStore.count("k"), 2, "2 条事件");
  assert.equal((await a._loadHistory("k")).length, 2, "投影 2 条");
  a.shutdown();
});
