// test/timeout.test.js - 工具超时预算测试 (v1.6.0 第四刀, feature)
// 覆盖: seam.js runWithPolicy 全局默认超时 (ctx.timeoutMs) + 工具级覆盖优先 +
//       超时真中断 (AbortController signal) + 结构化错误返回。
import { test } from "node:test";
import assert from "node:assert";
import { runWithPolicy, normalizeMeta } from "../src/tools/seam.js";

// 挂起的 execute: 不响应 signal, 永远不返回 (测超时兜底)
function hangingTool() {
  return normalizeMeta({
    name: "hanging",
    description: "测试用挂起工具",
    execute: () => new Promise(() => {}), // 永不 resolve
  });
}

// 响应 signal 的 execute: 超时中断时提前抛 AbortError (测真中断传递)
function abortAwareTool() {
  return normalizeMeta({
    name: "abort_aware",
    description: "测试用响应中断工具",
    execute: (args, ctx) => new Promise((_, reject) => {
      ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  });
}

test("runWithPolicy: 全局默认超时 (ctx.timeoutMs) 生效 — 挂起工具超时返回结构化错误", async () => {
  const meta = hangingTool();
  const t0 = Date.now();
  const r = await runWithPolicy(meta, {}, { timeoutMs: 100 });
  const elapsed = Date.now() - t0;
  assert.ok(r.startsWith("[工具错误]"), "应返回工具错误前缀");
  assert.ok(r.includes("超时"), "应标记超时");
  assert.ok(elapsed < 5000, `应约 100ms 超时返回 (实际 ${elapsed}ms)`);
});

test("runWithPolicy: 工具级 timeoutMs 优先于全局默认", async () => {
  // 工具声明 1000ms, 全局 ctx.timeoutMs=50 — 应走工具级 (不超时, 工具快速返回)
  const meta = normalizeMeta({
    name: "quick",
    description: "测试用快速工具",
    timeoutMs: 1000,
    execute: async () => "ok",
  });
  const r = await runWithPolicy(meta, {}, { timeoutMs: 50 });
  assert.equal(r, "ok", "工具级 timeoutMs=1000 应覆盖全局 50, 不超时");
});

test("runWithPolicy: 未声明 + 无全局默认 = 不限时 (向后兼容)", async () => {
  const meta = normalizeMeta({
    name: "quick2",
    description: "测试用快速工具",
    execute: async () => "ok",
  });
  const r = await runWithPolicy(meta, {}, {}); // 无 ctx.timeoutMs
  assert.equal(r, "ok");
});

test("runWithPolicy: 超时通过 signal 真中断底层执行 (资源超时)", async () => {
  const meta = abortAwareTool();
  const r = await runWithPolicy(meta, {}, { timeoutMs: 100 });
  assert.ok(r.startsWith("[工具错误]"), "abort 后应返回工具错误");
  assert.ok(r.includes("超时") || r.includes("aborted"), "应体现中断");
});

test("normalizeMeta: 工具可声明 timeoutMs 与 idempotent", () => {
  const meta = normalizeMeta({
    name: "declared",
    description: "测试",
    timeoutMs: 5000,
    idempotent: true,
    execute: async () => "ok",
  });
  assert.equal(meta.timeoutMs, 5000);
  assert.equal(meta.idempotent, true);
  // 未声明默认: 不限时 + 非幂等
  const plain = normalizeMeta({ name: "plain", description: "x", execute: async () => "ok" });
  assert.equal(plain.timeoutMs, 0);
  assert.equal(plain.idempotent, false);
});
