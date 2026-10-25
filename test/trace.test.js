// test/trace.test.js - 结构化事件流测试 (重构第三刀, 2026-09-14)
// 覆盖: runWithTrace traceId 贯穿 (AsyncLocalStorage) / EventTracer 事件落盘 /
//       span 耗时与失败 / PII 脱敏 / 无上下文降级
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventTracer, runWithTrace, currentTrace, genTraceId, hasTrace } from "../src/core/trace.js";
import { runToolLoop } from "../src/core/policy.js";
import { logicalDay } from "../src/utils/store.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-trace-"));
}

// 读今天事件文件全部行
// 注意: 必须用 logicalDay() (本地时区) 拼文件名, 与 src/core/trace.js 的写入路径对齐。
// 曾用 new Date().toISOString() (UTC) 导致 UTC+8 环境下 00:00-08:00 读错日期文件, 3 项测试稳定失败。
function readEvents(dir) {
  const f = path.join(dir, "logs", "traces", "events-" + logicalDay() + ".jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("genTraceId: 生成唯一 traceId", () => {
  const a = genTraceId(), b = genTraceId();
  assert.ok(a.startsWith("t_"));
  assert.notEqual(a, b);
});

test("runWithTrace: traceId 贯穿深层异步调用 (AsyncLocalStorage)", async () => {
  const dir = tmpDir();
  const tracer = new EventTracer(dir);
  // 模拟深层异步: 入口 -> 异步函数 -> 再异步 -> 事件
  const deep = async () => {
    await new Promise((r) => setTimeout(r, 5));
    const inner = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return tracer.event("test/deep", { layer: 3 });
    };
    return inner();
  };
  const entry = await runWithTrace(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return deep();
  }, { sessionKey: "s1", channel: "test" });
  assert.ok(entry.traceId, "事件应带 traceId");
  assert.ok(entry.traceId.startsWith("t_"));
  const all = readEvents(dir);
  assert.equal(all.length, 1);
  assert.equal(all[0].type, "test/deep");
  assert.equal(all[0].traceId, entry.traceId, "深层调用 traceId 应与入口一致");
  assert.equal(all[0].sessionId, tracer.sessionId);
  assert.ok(all[0].ts);
  assert.ok(all[0].seq >= 1);
});

test("runWithTrace: meta 上下文注入 store", async () => {
  const dir = tmpDir();
  const tracer = new EventTracer(dir);
  await runWithTrace(async () => {
    const store = currentTrace();
    assert.equal(store.sessionKey, "abc");
    assert.equal(store.channel, "x");
    assert.ok(hasTrace(), "回调内应有 trace 上下文");
  }, { sessionKey: "abc", channel: "x" });
  assert.ok(!hasTrace(), "回调外应无 trace 上下文 (ALS 已退出)");
});

test("EventTracer: 无 trace 上下文时事件照记, traceId=null (降级不丢)", () => {
  const dir = tmpDir();
  const tracer = new EventTracer(dir);
  const entry = tracer.event("test/standalone", { a: 1 });
  assert.equal(entry.traceId, null);
  assert.equal(entry.type, "test/standalone");
});

test("EventTracer: PII 脱敏 (payload 中的 key/token 不落盘明文)", async () => {
  const dir = tmpDir();
  const tracer = new EventTracer(dir);
  await runWithTrace(async () => {
    tracer.event("test/pii", { api_key: "sk-1234567890abcdef12345678", url: "https://x.com?token=SECRETTOKENVALUE123" });
  });
  const all = readEvents(dir);
  const raw = JSON.stringify(all[0]);
  assert.ok(!raw.includes("sk-1234567890abcdef12345678"), "api_key 值不应明文落盘");
  assert.ok(!raw.includes("SECRETTOKENVALUE123"), "token 值不应明文落盘");
});

test("EventTracer.span: 成功记录耗时+ok, 失败记录 error 并重抛", async () => {
  const dir = tmpDir();
  const tracer = new EventTracer(dir);
  await runWithTrace(async () => {
    const r = await tracer.span("test/op", async () => "result", { tag: "x" });
    assert.equal(r, "result");
    await assert.rejects(
      tracer.span("test/fail", async () => { throw new Error("boom"); }, { tag: "y" }),
      /boom/
    );
  });
  const all = readEvents(dir);
  assert.equal(all.length, 2);
  assert.equal(all[0].type, "test/op");
  assert.equal(all[0].ok, true);
  assert.ok(all[0].durationMs >= 0);
  assert.equal(all[1].type, "test/fail");
  assert.equal(all[1].ok, false);
  assert.equal(all[1].error, "boom");
});

test("runToolLoop onEvent: 工具失败路径发出策略事件", async () => {
  const events = [];
  const plan = [
    { tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"p":"a"}' } }], content: null },
    { tool_calls: [{ id: "t2", type: "function", function: { name: "read_file", arguments: '{"p":"b"}' } }], content: null },
    { tool_calls: [{ id: "t3", type: "function", function: { name: "read_file", arguments: '{"p":"c"}' } }], content: null },
    { tool_calls: [], content: "done" },
  ];
  let i = 0;
  const llm = {
    async apiChat() { return { message: plan[Math.min(i++, plan.length - 1)] }; },
  };
  await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: {},
    runTool: async () => "x",
    shrinkMessages: (m) => m,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  assert.ok(events.some((e) => e.type === "tool/explore_break"), "应发出探索熔断事件");
});

test("runToolLoop onEvent: 溢出降档发出 tool/overflow", async () => {
  const events = [];
  let i = 0;
  const err = new Error("Context size exceeded");
  const llm = {
    async apiChat() { if (i++ === 0) throw err; return { message: { tool_calls: [], content: "ok" } }; },
  };
  await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: {},
    runTool: async () => "x",
    shrinkMessages: (m) => m,
    onEvent: (type, payload) => events.push({ type, ...payload }),
  });
  assert.ok(events.some((e) => e.type === "tool/overflow" && e.shrink === 1), "应发出溢出降档事件");
});
