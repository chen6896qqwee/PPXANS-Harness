// test/policy.test.js - 工具循环执行策略回归测试 (重构第一刀, 2026-09-14)
// 覆盖: runToolLoop 循环驱动 (工具执行/结论返回/中断) + ToolLoopPolicy 状态机
//       (探索熔断/重复检测/溢出降档/错误重试) + 纯函数 (trimToolResult/isOverflowError)
// 目的: 从 PPXAgent._llmWithTools 抽取后, 行为等价性由测试锁死, 防重构回归。
import { test } from "node:test";
import assert from "node:assert";
import {
  runToolLoop, ToolLoopPolicy, trimToolResult, isOverflowError,
  EXPLORE_TOOLS, DEFAULT_EXPLORE_BREAK, callWithTimeoutRetry, isTimeoutResult,
} from "../src/core/policy.js";
import { TOOL_ERROR_PREFIX } from "../src/tools/index.js";

// ---- mock LLM: 按剧本返回 (tool_calls + content) 或抛错, 记录每次收到的 messages ----
function mockLLM(plan) {
  const calls = [];
  const llm = {
    calls,
    async apiChat(messages) {
      calls.push({ n: messages.length, contents: messages.map((m) => String(m.content).slice(0, 40)) });
      const step = plan.shift();
      if (step instanceof Error) throw step;
      return { message: step };
    },
  };
  return llm;
}

const tc = (id, name, args = "{}") => ({ id, type: "function", function: { name, arguments: args } });

// ---- runToolLoop 循环驱动 ----

test("runToolLoop: 模型先调工具再出结论, 工具结果回传", async () => {
  const plan = [
    { tool_calls: [tc("t1", "get_time")], content: null },
    { tool_calls: [], content: "10:30" },
  ];
  const llm = mockLLM(plan);
  const toolRuns = [];
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "几点" }],
    llm, tools: [], config: {},
    runTool: async (n, a) => { toolRuns.push([n, a]); return "10:30"; },
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "10:30");
  assert.deepEqual(toolRuns, [["get_time", {}]]);
  // 工具结果消息应被 push 回上下文
  assert.ok(llm.calls[1].contents.some((c) => c.includes("10:30")), "工具结果应回传模型");
});

test("runToolLoop: 无工具调用直接返回模型结论", async () => {
  const llm = mockLLM([{ tool_calls: [], content: "你好兄弟" }]);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: {},
    runTool: async () => "x",
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "你好兄弟");
});

test("runToolLoop: 中断信号立即返回", async () => {
  const llm = mockLLM([{ tool_calls: [tc("t1", "get_time")], content: null }]);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: {},
    isInterrupted: () => true,
    runTool: async () => "10:30",
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "[皮皮虾] 任务已被中断 (operator cancelled).");
});

test("runToolLoop: 轮次超上限停止", async () => {
  const plan = Array.from({ length: 12 }, () => ({ tool_calls: [tc("t", "get_time")], content: null }));
  const llm = mockLLM(plan);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: { agent: { max_tool_rounds: 3 } },
    runTool: async () => "10:30",
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "[皮皮虾] 工具调用轮次过多, 已停止。");
  assert.equal(llm.calls.length, 3, "只应跑 3 轮");
});

// ---- 探索熔断 / 重复检测 ----

test("runToolLoop: 连续探索无产出 -> 注入方向盘, 模型改出结论", async () => {
  const plan = [
    { tool_calls: [tc("t1", "read_file", '{"path":"a"}')], content: null },
    { tool_calls: [tc("t2", "read_file", '{"path":"b"}')], content: null },
    { tool_calls: [tc("t3", "read_file", '{"path":"c"}')], content: null }, // 第3轮触发熔断
    { tool_calls: [], content: "结论" },
  ];
  const llm = mockLLM(plan);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "看下" }],
    llm, tools: [], config: {},
    runTool: async () => "内容",
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "结论");
  const steered = llm.calls.some((c) => c.contents.some((s) => s.includes("检测到连续探索循环")));
  assert.ok(steered, "应注入探索熔断方向盘消息");
});

test("runToolLoop: 重复相同工具+参数 -> 注入重复警告", async () => {
  const plan = [
    { tool_calls: [tc("t1", "read_file", '{"path":"x"}')], content: null },
    { tool_calls: [tc("t2", "read_file", '{"path":"x"}')], content: null }, // 重复
    { tool_calls: [], content: "done" },
  ];
  const llm = mockLLM(plan);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: {},
    runTool: async () => "内容",
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "done");
  const warned = llm.calls.some((c) => c.contents.some((s) => s.includes("检测到重复执行相同工具与参数")));
  assert.ok(warned, "应注入重复警告方向盘消息");
});

// ---- 溢出降档 / 错误重试 ----

test("runToolLoop: 上下文溢出 -> 降档裁剪重试, 上限后放弃", async () => {
  const plan = [
    new Error("This model's maximum context length is 4096 tokens"),
    { tool_calls: [], content: "ok" },
  ];
  const llm = mockLLM(plan);
  const caps = [];
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: {},
    runTool: async () => "x",
    shrinkMessages: (m, b) => { caps.push(b); return m; },
    histTokenCap: () => 4000,
  });
  assert.equal(out, "ok");
  assert.deepEqual(caps, [2000], "第一档降档预算 = 窗口/2");
});

test("runToolLoop: 溢出降档 3 次后不再重试 (抛错给上层)", async () => {
  const err = new Error("Context size exceeded");
  const plan = [err, err, err, { tool_calls: [], content: "no" }];
  const llm = mockLLM(plan);
  let shrinks = 0;
  await assert.rejects(
    runToolLoop({
      seedMessages: [{ role: "user", content: "hi" }],
      llm, tools: [], config: {},
      runTool: async () => "x",
      shrinkMessages: (m) => { shrinks++; return m; },
    }),
    /Context size exceeded/
  );
  assert.equal(shrinks, 2, "DEFAULT_OVERFLOW_SHRINK_MAX=2, 只降档 2 次");
});

test("runToolLoop: 工具错误喂回模型修正重试", async () => {
  const plan = [
    { tool_calls: [tc("t1", "run_command")], content: null },
    { tool_calls: [], content: "fixed" },
  ];
  const llm = mockLLM(plan);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "跑" }],
    llm, tools: [], config: {},
    runTool: async () => TOOL_ERROR_PREFIX + "命令不存在",
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "fixed");
  const fed = llm.calls.some((c) => c.contents.some((s) => s.includes("以下工具调用失败")));
  assert.ok(fed, "错误应喂回模型");
});

// ---- ToolLoopPolicy 状态机 ----

test("ToolLoopPolicy.recordTurn: 探索连击计数与熔断", () => {
  const p = new ToolLoopPolicy({});
  assert.equal(p.exploreBreak, DEFAULT_EXPLORE_BREAK);
  // 前 2 轮只读: 不熔断
  assert.equal(p.recordTurn([tc("t1", "read_file")]), null);
  assert.equal(p.recordTurn([tc("t2", "list_dir")]), null);
  // 第 3 轮仍只读: 熔断
  const steer = p.recordTurn([tc("t3", "web_search")]);
  assert.ok(steer.includes("连续探索循环"));
  // 熔断后状态清零: 再记录只读是新的连击起点
  assert.equal(p.exploreStreak, 0);
  // 混合调用 (含非探索工具) 重置连击
  p.exploreStreak = 2;
  assert.equal(p.recordTurn([tc("t4", "run_command")]), null);
  assert.equal(p.exploreStreak, 0);
});

test("ToolLoopPolicy.recordTurn: 重复检测 (同一工具+参数)", () => {
  const p = new ToolLoopPolicy({});
  assert.equal(p.recordTurn([tc("t1", "read_file", '{"path":"x"}')]), null);
  const steer = p.recordTurn([tc("t2", "read_file", '{"path":"x"}')]);
  assert.ok(steer.includes("重复执行"));
});

test("ToolLoopPolicy.shouldRetryErrors: 上限内重试, 超限放弃", () => {
  const p = new ToolLoopPolicy({});
  assert.equal(p.shouldRetryErrors([]), false, "无错误不重试");
  assert.equal(p.shouldRetryErrors(["e1"]), true);
  assert.equal(p.shouldRetryErrors(["e2"]), true);
  assert.equal(p.shouldRetryErrors(["e3"]), false, "超过 DEFAULT_MAX_TOOL_ERROR_RETRY=2");
  // 可配置上限
  const p2 = new ToolLoopPolicy({ max_tool_error_retry: 1 });
  assert.equal(p2.shouldRetryErrors(["e"]), true);
  assert.equal(p2.shouldRetryErrors(["e"]), false);
});

test("ToolLoopPolicy.nextOverflowCap: 逐档缩紧, 有下限", () => {
  const p = new ToolLoopPolicy({});
  assert.equal(p.nextOverflowCap(4000), 2000);
  assert.equal(p.nextOverflowCap(4000), 1333);
  assert.ok(p.nextOverflowCap(100) >= 200, "下限 200");
  assert.equal(p.shouldShrinkOverflow(new Error("Context size exceeded")), false, "降档 3 次后不再收缩");
});

// ---- 纯函数 ----

test("trimToolResult: 短结果不裁剪, 超长保留头尾", () => {
  assert.equal(trimToolResult("abc"), "abc");
  const long = "x".repeat(100);
  const r = trimToolResult(long, 50);
  assert.ok(r.includes("结果已裁剪"));
  assert.ok(r.length < 100);
});

test("isOverflowError: 溢出信号识别, AbortError/500 非溢出", () => {
  assert.ok(isOverflowError(new Error("maximum context length")));
  assert.ok(isOverflowError({ status: 413, message: "content too large" }));
  assert.ok(!isOverflowError(new Error("server returned 500")));
  assert.ok(!isOverflowError({ name: "AbortError", message: "cancel" }));
});

test("EXPLORE_TOOLS: 探索类工具集存在且含核心只读工具", () => {
  assert.ok(EXPLORE_TOOLS.has("read_file"));
  assert.ok(EXPLORE_TOOLS.has("web_search"));
  assert.ok(!EXPLORE_TOOLS.has("run_command"));
});

// ---- 第四刀: 超时检测与重试 (v1.6.0 feature) ----

const TIMEOUT_ERR = TOOL_ERROR_PREFIX + " get_time: 超时";

function mkRunTool(results) {
  const calls = [];
  let i = 0;
  return [
    async (n, a) => { calls.push([n, a]); return results[Math.min(i++, results.length - 1)]; },
    calls,
  ];
}

test("isTimeoutResult: 识别超时错误", () => {
  assert.ok(isTimeoutResult(TIMEOUT_ERR));
  assert.ok(!isTimeoutResult(TOOL_ERROR_PREFIX + " get_time: 命令不存在"));
  assert.ok(!isTimeoutResult("正常结果"));
});

test("callWithTimeoutRetry: 幂等工具超时重试一次成功", async () => {
  const [runTool, calls] = mkRunTool([TIMEOUT_ERR, "10:30"]);
  const events = [];
  const r = await callWithTimeoutRetry({
    name: "get_time", args: {}, runTool, isIdempotent: true,
    budgetMs: 500, onEvent: (t, p) => events.push({ t, ...p }),
  });
  assert.equal(r.result, "10:30");
  assert.equal(r.retried, true);
  assert.equal(r.timedOut, false);
  assert.equal(calls.length, 2, "应重试一次");
  assert.equal(events.length, 1);
  assert.equal(events[0].t, "tool/timeout");
  assert.equal(events[0].retried, false);
  assert.equal(events[0].budgetMs, 500);
  assert.ok(events[0].elapsedMs >= 0);
});

test("callWithTimeoutRetry: 超时两次失败返回结构化错误", async () => {
  const [runTool, calls] = mkRunTool([TIMEOUT_ERR, TIMEOUT_ERR]);
  const events = [];
  const r = await callWithTimeoutRetry({
    name: "get_time", args: {}, runTool, isIdempotent: true,
    onEvent: (t, p) => events.push({ t, ...p }),
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.retried, true);
  assert.equal(r.result, TIMEOUT_ERR);
  assert.equal(calls.length, 2);
  assert.equal(events.length, 2, "两次超时各发一次事件");
  assert.equal(events[1].gaveUp, true);
});

test("callWithTimeoutRetry: 非幂等工具超时不重试 (副作用安全)", async () => {
  const [runTool, calls] = mkRunTool([TIMEOUT_ERR]);
  const events = [];
  const r = await callWithTimeoutRetry({
    name: "run_command", args: {}, runTool, isIdempotent: false,
    onEvent: (t, p) => events.push({ t, ...p }),
  });
  assert.equal(r.retried, false);
  assert.equal(r.timedOut, true);
  assert.equal(calls.length, 1, "非幂等不重试");
  assert.equal(events[0].skippedRetry, true);
});

test("callWithTimeoutRetry: 正常结果不触发超时逻辑", async () => {
  const [runTool, calls] = mkRunTool(["正常"]);
  const events = [];
  const r = await callWithTimeoutRetry({ name: "get_time", args: {}, runTool, onEvent: (t) => events.push(t) });
  assert.equal(r.result, "正常");
  assert.equal(r.timedOut, false);
  assert.equal(r.retried, false);
  assert.equal(calls.length, 1);
  assert.equal(events.length, 0);
});

test("runToolLoop: 幂等工具超时经重试后产出结论", async () => {
  const plan = [
    { tool_calls: [tc("t1", "get_time")], content: null },
    { tool_calls: [], content: "10:30" },
  ];
  const llm = mockLLM(plan);
  const events = [];
  let first = true;
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "几点" }],
    llm, tools: [], config: {},
    isIdempotentTool: () => true,
    onEvent: (t, p) => events.push({ t, ...p }),
    runTool: async (n) => { if (first) { first = false; return TIMEOUT_ERR; } return "10:30"; },
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "10:30");
  assert.ok(events.some((e) => e.t === "tool/timeout"), "应发出 tool/timeout 事件");
});
