// test/session-cache.test.js - v1.1.1 会话派生缓存 + 批量落盘
// 覆盖: deriveCompacted 增量缓存 (append-only/replace 失效/compaction 重算) /
//       eventsByDay 缓存一致性 / skipFlush+flush 批量落盘一次写盘 / 兼容单条 append 即时 flush
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, EVENTS } from "../src/memory/session.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-sesscache-")); }
function files(d) {
  return fs.readdirSync(path.join(d, "sessions")).filter((f) => f.endsWith(".jsonl")).sort();
}

test("deriveCompacted 增量缓存: 二次调用返回同一引用 (O(Δ) 命中)", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("k", EVENTS.USER, { content: "一" }, Date.now());
  s.append("k", EVENTS.ASSISTANT, { content: "二" }, Date.now());
  const a = s.deriveCompacted("k");
  const b = s.deriveCompacted("k"); // 无变化 → 命中缓存, 同一数组
  assert.strictEqual(a, b);
  fs.rmSync(d, { recursive: true, force: true });
});

test("deriveCompacted 追加新消息只增不改 (结果追加)", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("k", EVENTS.USER, { content: "一" }, Date.now());
  s.append("k", EVENTS.ASSISTANT, { content: "二" }, Date.now());
  const before = s.deriveCompacted("k");
  assert.deepEqual(before.map((m) => m.content), ["一", "二"]);
  s.append("k", EVENTS.USER, { content: "三" }, Date.now()); // append 使缓存增量扩展
  const after = s.deriveCompacted("k");
  assert.deepEqual(after.map((m) => m.content), ["一", "二", "三"], "尾部新消息被追加");
  // 追加后仍是同一数组引用 (增量扩展, 非重建)
  assert.strictEqual(before, after);
  fs.rmSync(d, { recursive: true, force: true });
});

test("deriveCompacted: 数组替换 (set/rename) 触发整体重算", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("k", EVENTS.USER, { content: "旧一" }, Date.now());
  s.rename("k", "k2"); // 新数组
  s.append("k2", EVENTS.USER, { content: "旧二" }, Date.now());
  const m = s.deriveCompacted("k2");
  assert.deepEqual(m.map((x) => x.content), ["旧一", "旧二"]);
  fs.rmSync(d, { recursive: true, force: true });
});

test("deriveCompacted: compaction 追加 → 重投影为摘要", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("k", EVENTS.USER, { content: "m1" }, Date.now());
  s.append("k", EVENTS.ASSISTANT, { content: "r1" }, Date.now());
  s.append("k", EVENTS.COMPACTION, { summary: "摘要", upToSeq: 2 }, Date.now());
  const msgs = s.deriveCompacted("k");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "摘要", "被压缩区间替换");
  s.append("k", EVENTS.USER, { content: "m2" }, Date.now());
  const after = s.deriveCompacted("k");
  assert.deepEqual(after.map((m) => m.content), ["摘要", "m2"]);
  fs.rmSync(d, { recursive: true, force: true });
});

test("eventsByDay: 结果一致, append 后自动重算", () => {
  const d = tmp();
  const s = new SessionStore(d);
  const dayStr = "2026-08-15";
  const t = new Date(2026, 7, 15, 12, 0, 0).getTime(); // 本地 2026-08-15 中午
  s.append("k", EVENTS.USER, { content: "a" }, t);
  assert.equal(s.eventsByDay("2026-08-15").length, 1);
  assert.equal(s.eventsByDay("2026-08-15").length, 1, "二次调用命中缓存仍正确");
  s.append("k", EVENTS.ASSISTANT, { content: "b" }, t + 60000);
  assert.equal(s.eventsByDay("2026-08-15").length, 2, "append 后重算");
  assert.equal(s.eventsByDay("2026-08-16").length, 0, "非当天为空");
  fs.rmSync(d, { recursive: true, force: true });
});

test("skipFlush+flush: 批量落盘只写一次 (模拟 _pushTurn)", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("default", EVENTS.USER, { content: "u" }, Date.now(), { skipFlush: true });
  s.append("default", EVENTS.ASSISTANT, { content: "a" }, Date.now(), { skipFlush: true });
  assert.equal(files(d).length, 0, "skipFlush 期间未落盘");
  s.flush("default");
  const f = files(d);
  assert.equal(f.length, 1, "flush 后写一次");
  const lines = fs.readFileSync(path.join(d, "sessions", f[0]), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "两条事件一次写入");
  // 重启恢复
  const s2 = new SessionStore(d);
  assert.deepEqual(s2.deriveMessages("default").map((m) => m.content), ["u", "a"]);
  fs.rmSync(d, { recursive: true, force: true });
});

test("单条 append 缺省仍即时落盘 (兼容旧行为)", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("misc", EVENTS.USER, { content: "hi" }, Date.now());
  assert.equal(files(d).length, 1, "无 skipFlush 时 append 即时写盘");
  fs.rmSync(d, { recursive: true, force: true });
});