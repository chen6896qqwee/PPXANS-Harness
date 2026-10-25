import test from "node:test";
import assert from "node:assert";
import { httpStatusOf, isTransientError, retryAfterSeconds, backoffMs, withRetry } from "../src/llm/retry.js";

test("httpStatusOf: 从 status/statusCode/消息提取", () => {
  assert.equal(httpStatusOf({ status: 429 }), 429);
  assert.equal(httpStatusOf({ statusCode: 500 }), 500);
  assert.equal(httpStatusOf(new Error("LLM HTTP 503: boom")), 503);
  assert.equal(httpStatusOf(new Error("无状态码")), null);
  assert.equal(httpStatusOf(null), null);
});

test("isTransientError: 瞬态/非瞬态分类", () => {
  assert.equal(isTransientError({ status: 429 }), true);
  assert.equal(isTransientError({ status: 500 }), true);
  assert.equal(isTransientError({ status: 503 }), true);
  assert.equal(isTransientError({ status: 400 }), false);
  assert.equal(isTransientError({ status: 401 }), false);
  assert.equal(isTransientError({ status: 403 }), false);
  assert.equal(isTransientError({ status: 404 }), false);
  assert.equal(isTransientError(new Error("fetch failed")), true);
  assert.equal(isTransientError(new Error("ETIMEDOUT")), true);
  assert.equal(isTransientError(new Error("socket hang up")), true);
  assert.equal(isTransientError(new Error("普通业务错误")), false);
});

test("retryAfterSeconds: 提取 + 上限", () => {
  assert.equal(retryAfterSeconds({ headers: { get: () => "5" } }), 5);
  assert.equal(retryAfterSeconds({ retryAfter: 10 }), 10);
  assert.equal(retryAfterSeconds({ headers: { get: () => "9999" } }), 30);
  assert.equal(retryAfterSeconds({}), null);
});

test("backoffMs: 范围与封顶", () => {
  for (let i = 0; i < 4; i++) {
    const ms = backoffMs(i, { baseMs: 500, factor: 2, maxMs: 10000 });
    assert.ok(ms >= 250 && ms <= 10000, `attempt ${i} 越界: ${ms}`);
  }
  assert.ok(backoffMs(10, { baseMs: 500, factor: 2, maxMs: 10000 }) <= 10000);
});

test("withRetry: 瞬态错误重试后成功", async () => {
  let calls = 0;
  const fn = () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("LLM HTTP 500"), { status: 500 });
    return "ok";
  };
  const r = await withRetry(fn, { maxRetries: 3, baseMs: 1, factor: 2, maxMs: 5 });
  assert.equal(r, "ok");
  assert.equal(calls, 3);
});

test("withRetry: 非瞬态错误立即抛不重试", async () => {
  let calls = 0;
  const fn = () => { calls++; throw Object.assign(new Error("LLM HTTP 401"), { status: 401 }); };
  await assert.rejects(() => withRetry(fn, { maxRetries: 3, baseMs: 1 }), /401/);
  assert.equal(calls, 1);
});

test("withRetry: 重试耗尽抛最后错误", async () => {
  let calls = 0;
  const fn = () => { calls++; throw Object.assign(new Error("LLM HTTP 500"), { status: 500 }); };
  await assert.rejects(() => withRetry(fn, { maxRetries: 2, baseMs: 1 }), /500/);
  assert.equal(calls, 3);
});
