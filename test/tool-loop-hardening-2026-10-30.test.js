// test/tool-loop-hardening-2026-10-30.test.js
// 2026-10-30 工具循环加固回归: 三项改动各自的"改动前会红"断言。
//   ① 轮次耗尽强制收口 —— 旧行为把"做了一半的活"丢成一句硬停止
//   ② 同轮工具并发上限 —— 旧行为 N 个 tool_calls 无限并发起跑 (N 个 shell 同时 spawn)
//   ③ 参数签名键序无关 —— 旧行为换键序重发就不算重复 (熔断来得晚)
import { test } from "node:test";
import assert from "node:assert";
import {
  runToolLoop, ToolLoopPolicy, mapBounded,
  EXHAUSTED_STOP_TEXT, EXHAUSTED_FINALIZE_PROMPT, DEFAULT_MAX_PARALLEL_TOOLS,
} from "../src/core/policy.js";
import { stableJson } from "../src/utils/canonical.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tc = (id, name, args = "{}") => ({ id, type: "function", function: { name, arguments: args } });

// 记录完整 messages 的 mock LLM (按剧本返回)
function scriptedLLM(plan) {
  const seen = [];
  return {
    seen,
    calls: 0,
    async apiChat(messages, opts) {
      this.calls++;
      seen.push({ messages: [...messages], opts });
      const step = plan.length > 1 ? plan.shift() : plan[0];
      if (step instanceof Error) throw step;
      return { message: step };
    },
  };
}

// ---- ① 轮次耗尽强制收口 ----

test("收口: 无工具轨迹时不做收口 (没有可总结的东西)", async () => {
  // max_tool_rounds=-1 → 循环一轮都不跑, turnCalls 为空 (纯防御分支:
  //   没有工具结果还去问模型"总结一下", 只会骗出一段空话, 白花一次调用)
  const llm = scriptedLLM([{ tool_calls: [], content: "不该用到的收口" }]);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: { agent: { max_tool_rounds: -1 } },
    runTool: async () => "x",
    shrinkMessages: (m) => m,
  });
  assert.equal(out, EXHAUSTED_STOP_TEXT);
  assert.equal(llm.calls, 0, "无轨迹时一次额外调用都不该发生");
});

test("收口: 用户中断优先于收口 (不拿预算做收尾)", async () => {
  let interrupted = false;
  const llm = scriptedLLM([{ tool_calls: [tc("t", "get_time")], content: null }]);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: { agent: { max_tool_rounds: 2 } },
    isInterrupted: () => interrupted,
    runTool: async () => { interrupted = true; return "10:30"; },
    shrinkMessages: (m) => m,
  });
  assert.ok(out === "[皮皮虾] 任务已被中断 (operator cancelled)." || out === EXHAUSTED_STOP_TEXT,
    `中断后不得继续收口, 实际: ${out}`);
  assert.equal(llm.calls, 1, "中断后不再多发调用");
});

test("收口: 预算耗尽时不补收口调用 (明知没钱不点单)", async () => {
  const llm = scriptedLLM([{ tool_calls: [tc("t", "get_time")], content: null }]);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: { agent: { max_tool_rounds: 1 } },
    budgetBlocked: () => "预算已耗尽",
    runTool: async () => "10:30",
    shrinkMessages: (m) => m,
  });
  // 第 1 轮 (round=0) 跳过预算检查; 收口前检查到耗尽 → 回落硬停止
  assert.equal(out, EXHAUSTED_STOP_TEXT);
  assert.equal(llm.calls, 1);
});

test("收口: 正文带诚实标注, 且标注里有成功/失败计数", async () => {
  const plan = [
    { tool_calls: [tc("t1", "get_time"), tc("t2", "no_such_tool")], content: null },
    { tool_calls: [], content: "只查到时间, 另一个工具不存在" },
  ];
  const llm = scriptedLLM(plan);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: { agent: { max_tool_rounds: 1, max_tool_error_retry: 0 } },
    runTool: async (n) => (n === "no_such_tool" ? "[工具错误] 未知工具" : "10:30"),
    shrinkMessages: (m) => m,
  });
  assert.match(out, /只查到时间/);
  assert.match(out, /1 次成功/);
  assert.match(out, /本轮未再执行任何新操作/);
});

test("收口: 提示词内容进上下文 (模型看得到「不许再调工具」这条约束)", async () => {
  const plan = [
    { tool_calls: [tc("t", "get_time")], content: null },
    { tool_calls: [], content: "收口正文" },
  ];
  const llm = scriptedLLM(plan);
  await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: { agent: { max_tool_rounds: 1 } },
    runTool: async () => "10:30",
    shrinkMessages: (m) => m,
  });
  const lastMsgs = llm.seen.at(-1).messages;
  assert.equal(lastMsgs.at(-1).content, EXHAUSTED_FINALIZE_PROMPT);
});

// ---- ② 同轮工具并发上限 ----

test("并发: 超出 max_parallel_tools 时按批跑, 峰值不超上限且结果保序", async () => {
  const n = 8;
  let active = 0;
  let peak = 0;
  const calls = Array.from({ length: n }, (_, i) => tc("t" + i, "get_time", "{}"));
  const llm = scriptedLLM([{ tool_calls: calls, content: null }, { tool_calls: [], content: "done" }]);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: { agent: { max_parallel_tools: 3 } },
    runTool: async () => { active++; peak = Math.max(peak, active); await sleep(8); active--; return "ok"; },
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "done");
  assert.ok(peak <= 3, `并发峰值 ${peak} 不应超过上限 3`);
  // 保序: 回传顺序必须与请求顺序一致 (tool_call_id 配对不能乱)
  const toolMsgs = llm.seen.at(-1).messages.filter((m) => m.role === "tool");
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), calls.map((c) => c.id));
});

test("并发: max_parallel_tools=0 表示不限 (保留旧的全并发行为)", async () => {
  let active = 0;
  let peak = 0;
  const calls = Array.from({ length: 6 }, (_, i) => tc("t" + i, "get_time", "{}"));
  const llm = scriptedLLM([{ tool_calls: calls, content: null }, { tool_calls: [], content: "done" }]);
  await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: { agent: { max_parallel_tools: 0 } },
    runTool: async () => { active++; peak = Math.max(peak, active); await sleep(8); active--; return "ok"; },
    shrinkMessages: (m) => m,
  });
  assert.equal(peak, 6, "0 = 不限, 6 个调用应同时起跑");
});

test("并发: 默认上限是 4 (脏配置回落默认, 不是 NaN)", () => {
  assert.equal(DEFAULT_MAX_PARALLEL_TOOLS, 4);
  assert.equal(new ToolLoopPolicy({}).maxParallelTools, 4);
  assert.equal(new ToolLoopPolicy({ max_parallel_tools: "abc" }).maxParallelTools, 4);
  assert.equal(new ToolLoopPolicy({ max_parallel_tools: -3 }).maxParallelTools, 4);
  assert.equal(new ToolLoopPolicy({ max_parallel_tools: 0 }).maxParallelTools, 0);
  assert.equal(new ToolLoopPolicy({ max_parallel_tools: 2 }).maxParallelTools, 2);
});

test("mapBounded: 结果下标对齐输入, limit 超界自动夹取", async () => {
  const out = await mapBounded([5, 1, 3], 99, async (x) => { await sleep(x); return x * 2; });
  assert.deepEqual(out, [10, 2, 6]);
  const empty = await mapBounded([], 3, async (x) => x);
  assert.deepEqual(empty, []);
});

// ---- ③ 参数签名键序无关 ----

test("stableJson: 键序不同输出一致, 数组顺序不同输出不同", () => {
  assert.equal(stableJson({ a: 1, b: 2 }), stableJson({ b: 2, a: 1 }));
  assert.equal(stableJson({ x: { p: 1, q: 2 }, y: [1, 2] }), stableJson({ y: [1, 2], x: { q: 2, p: 1 } }));
  assert.notEqual(stableJson([1, 2]), stableJson([2, 1]), "数组顺序是语义, 不能归一");
  assert.equal(stableJson(null), "null");
  assert.equal(stableJson(undefined), "null");
  assert.equal(stableJson("x"), "\"x\"");
  assert.equal(stableJson({ a: 1 }, 5).length, 5, "maxLen 生效");
});

test("重复检测: 同参数换键序仍算重复 (旧实现漏判)", async () => {
  const plan = [
    { tool_calls: [tc("t1", "read_file", '{"path":"a","limit":1}')], content: null },
    { tool_calls: [tc("t2", "read_file", '{"limit":1,"path":"a"}')], content: null }, // 键序反了, 但同一调用
    { tool_calls: [], content: "结论" },
  ];
  const llm = scriptedLLM(plan);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: { agent: { repeat_flag_limit: 2 } },
    runTool: async () => "内容",
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "结论");
  const steered = llm.seen.some((s) => s.messages.some((m) => m.role === "user" && /重复执行相同工具与参数/.test(String(m.content))));
  assert.ok(steered, "换键序的重复调用应触发方向盘注入");
});

test("重复检测: 参数真不同则不算重复 (不误伤)", async () => {
  const plan = [
    { tool_calls: [tc("t1", "read_file", '{"path":"a"}')], content: null },
    { tool_calls: [tc("t2", "read_file", '{"path":"b"}')], content: null },
    { tool_calls: [], content: "结论" },
  ];
  const llm = scriptedLLM(plan);
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "hi" }],
    llm, tools: [], config: { agent: { repeat_flag_limit: 2 } },
    runTool: async () => "内容",
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "结论");
  const steered = llm.seen.some((s) => s.messages.some((m) => m.role === "user" && /重复执行相同工具与参数/.test(String(m.content))));
  assert.equal(steered, false, "不同参数不得触发重复告警");
});
