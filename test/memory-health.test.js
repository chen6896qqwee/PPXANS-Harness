// test/memory-health.test.js - P1⑤: 记忆管线健康监控 (HanaAgent 思想, 自研)
import { test } from "node:test";
import assert from "node:assert";
import { MemoryHealthMonitor, HEALTH } from "../src/services/memory-health.js";

test("mh: 初始 healthy, 无失败", () => {
  const mh = new MemoryHealthMonitor();
  assert.equal(mh.status().overall, HEALTH.HEALTHY);
  assert.equal(mh.degraded, false);
});

test("mh: 连续失败超阈值 → degraded", () => {
  const mh = new MemoryHealthMonitor({ degradeAfter: 3 });
  mh.record("compact", { ok: false, error: "llm down" });
  mh.record("compact", { ok: false });
  mh.record("compact", { ok: false });
  assert.equal(mh.degraded, true, "3 次连续失败进入降级");
  assert.equal(mh.status().overall, HEALTH.DEGRADED);
});

test("mh: 成功后重置失败计数 → 恢复 healthy", () => {
  const mh = new MemoryHealthMonitor({ degradeAfter: 2 });
  mh.record("compact", { ok: false });
  mh.record("compact", { ok: false });
  assert.equal(mh.degraded, true);
  mh.record("compact", { ok: true });
  assert.equal(mh.degraded, false, "成功后恢复");
});

test("mh: 窗口外失败滑出不计入", async () => {
  const mh = new MemoryHealthMonitor({ degradeAfter: 2, windowMs: 5 });
  mh.record("compact", { ok: false });
  await new Promise((r) => setTimeout(r, 10));
  mh.record("compact", { ok: false });
  assert.equal(mh.degraded, false, "第一次失败已滑出窗口");
});

test("mh: wrap 包装自动统计成败", async () => {
  const mh = new MemoryHealthMonitor({ degradeAfter: 2 });
  const fn = mh.wrap("extract", async () => { throw new Error("boom"); });
  await assert.rejects(() => fn(), /boom/);
  await assert.rejects(() => fn(), /boom/);
  assert.equal(mh.degraded, true);
  assert.equal(mh.status().steps.find((s) => s.name === "extract").fail, 2);
});

test("mh: wrap 成功不计数失败", async () => {
  const mh = new MemoryHealthMonitor();
  const fn = mh.wrap("compact", async () => "ok");
  await fn();
  const s = mh.status().steps.find((x) => x.name === "compact");
  assert.equal(s.ok, 1);
  assert.equal(s.fail, 0);
});

test("mh: degraded 时 advice 给只写不压建议", () => {
  const mh = new MemoryHealthMonitor({ degradeAfter: 1 });
  mh.record("compact", { ok: false });
  const a = mh.advice();
  assert.equal(a.action, "degrade");
  assert.ok(a.skip.includes("compact"));
  assert.ok(a.skip.includes("extract"));
});

test("mh: healthy 时 advice 正常", () => {
  const mh = new MemoryHealthMonitor();
  assert.equal(mh.advice().action, "normal");
});

test("mh: status 含 lastError", () => {
  const mh = new MemoryHealthMonitor();
  mh.record("compact", { ok: false, error: "LLM 超时" });
  const s = mh.status().steps[0];
  assert.equal(s.lastError, "LLM 超时");
  assert.equal(s.recentFails, 1);
});
