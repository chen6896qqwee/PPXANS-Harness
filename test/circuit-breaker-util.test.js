// test/circuit-breaker-util.test.js - P0④: 订阅者熔断器 (基础设施层, 区别于 agent 探索熔断)
import { test } from "node:test";
import assert from "node:assert";
import { CircuitBreaker } from "../src/bus/circuit-breaker.js";

test("cb: 窗口内失败超阈值 → open", () => {
  const cb = new CircuitBreaker({ threshold: 3, windowMs: 60000, cooldownMs: 60000 });
  for (let i = 0; i < 3; i++) cb.after(false);
  assert.equal(cb.state, "open", "3 次失败后熔断打开");
  assert.equal(cb.stats().opens, 1);
});

test("cb: closed 状态正常放行", () => {
  const cb = new CircuitBreaker({ threshold: 3 });
  assert.deepEqual(cb.before(), { allowed: true });
  assert.equal(cb.state, "closed");
});

test("cb: open 期间 fail-closed 短路拒绝", () => {
  const cb = new CircuitBreaker({ threshold: 2, windowMs: 60000, cooldownMs: 60000, failPolicy: "fail-closed" });
  cb.after(false); cb.after(false);
  assert.equal(cb.state, "open");
  const v = cb.before();
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "circuit-open");
});

test("cb: open 期间 fail-open 放行但标记降级", () => {
  const cb = new CircuitBreaker({ threshold: 2, windowMs: 60000, cooldownMs: 60000, failPolicy: "fail-open" });
  cb.after(false); cb.after(false);
  const v = cb.before();
  assert.equal(v.allowed, true, "fail-open 放行");
  assert.equal(v.degraded, true, "标记降级");
});

test("cb: 冷却后进入 half-open, 探测成功回 closed", () => {
  const cb = new CircuitBreaker({ threshold: 2, windowMs: 60000, cooldownMs: 5, failPolicy: "fail-closed" });
  cb.after(false); cb.after(false);
  assert.equal(cb.state, "open");
  // 等冷却结束 (cooldown 5ms)
  return new Promise((resolve) => setTimeout(() => {
    const v = cb.before();
    assert.equal(v.allowed, true);
    assert.equal(v.probe, true, "half-open 探测放行");
    assert.equal(cb.state, "half_open");
    cb.after(true);
    assert.equal(cb.state, "closed", "探测成功恢复 closed");
    resolve();
  }, 10));
});

test("cb: half-open 探测失败回 open", () => {
  const cb = new CircuitBreaker({ threshold: 1, windowMs: 60000, cooldownMs: 5, failPolicy: "fail-closed" });
  cb.after(false);
  assert.equal(cb.state, "open");
  return new Promise((resolve) => setTimeout(() => {
    cb.before(); // 进入 half-open
    assert.equal(cb.state, "half_open");
    cb.after(false); // 探测失败
    assert.equal(cb.state, "open", "探测失败回到 open");
    resolve();
  }, 10));
});

test("cb: wrap 包装器 —— 成功放行, 失败计数, open 时 fail-closed 抛错", async () => {
  const cb = new CircuitBreaker({ threshold: 2, windowMs: 60000, cooldownMs: 60000, failPolicy: "fail-closed" });
  let callCount = 0;
  const wrapped = cb.wrap(async () => { callCount++; throw new Error("fail"); });
  await assert.rejects(() => wrapped(), /fail/);
  await assert.rejects(() => wrapped(), /fail/);
  assert.equal(cb.state, "open");
  await assert.rejects(() => wrapped(), /circuit/);
  assert.equal(callCount, 2, "open 后不再调用原函数");
});

test("cb: wrap 包装器 fail-open 返回 fallback", async () => {
  const cb = new CircuitBreaker({ threshold: 1, windowMs: 60000, cooldownMs: 60000, failPolicy: "fail-open" });
  const wrapped = cb.wrap(async () => { throw new Error("fail"); }, { fallback: "fallback-result" });
  await assert.rejects(() => wrapped(), /fail/);
  assert.equal(cb.state, "open");
  const r = await wrapped();
  assert.equal(r, "fallback-result", "open 期返回 fallback");
});

test("cb: reset 手动复位", () => {
  const cb = new CircuitBreaker({ threshold: 1 });
  cb.after(false);
  assert.equal(cb.state, "open");
  cb.reset();
  assert.equal(cb.state, "closed");
  assert.equal(cb.stats().recentFailures, 0);
});

test("cb: 窗口外失败被滑动清除不触发 open", () => {
  const cb = new CircuitBreaker({ threshold: 2, windowMs: 5, cooldownMs: 60000 });
  cb.after(false);
  return new Promise((resolve) => setTimeout(() => {
    cb.after(false); // 第 1 次失败已滑出窗口
    assert.equal(cb.state, "closed", "窗口外失败不计入");
    resolve();
  }, 10));
});
