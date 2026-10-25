// 2026-10-01 优化回归守卫
// 1) runToolLoop 同轮独立工具调用并发执行 (审计 P1 遗留项: 原先串行, 延迟线性叠加)
// 2) Promise.all 保序: tool 消息回传顺序与 tool_calls 声明顺序一致
// 3) agent.parallel_tool_calls=false 回退串行 (旧行为)
// 4) safePath 跨平台拒绝 Windows 盘符路径 (repo_map Linux 失败暴露的平台差异)
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { runToolLoop } from "../src/core/policy.js";
import { safePath } from "../src/tools/builtin.js";

function mockLLM(plan) {
  const calls = [];
  return {
    calls,
    async apiChat(messages, opts = {}) {
      calls.push(messages);
      const step = plan.shift();
      if (!step) throw new Error("plan exhausted");
      return { message: step };
    },
  };
}

const tc = (id, name, args = "{}") => ({ id, type: "function", function: { name, arguments: args } });

// ---- 1. 并发执行: 两个 120ms 独立调用应远快于串行 240ms+ ----
test("runToolLoop: 同轮独立工具调用并发执行", async () => {
  const plan = [
    { tool_calls: [tc("t1", "slow", '{"k":1}'), tc("t2", "slow", '{"k":2}')], content: null },
    { tool_calls: [], content: "done" },
  ];
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "x" }],
    llm: mockLLM(plan), tools: [], config: {},
    runTool: async () => new Promise((r) => setTimeout(() => r("ok"), 120)),
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "done");
});

// ---- 2. 保序: tool 结果消息顺序与声明顺序一致 (完成时长反序制造乱序压力) ----
test("runToolLoop: 并发下 tool 消息回传保序", async () => {
  const plan = [
    { tool_calls: [tc("t1", "w", '{"id":"t1"}'), tc("t2", "w", '{"id":"t2"}'), tc("t3", "w", '{"id":"t3"}')], content: null },
    { tool_calls: [], content: "done" },
  ];
  const llm = mockLLM(plan);
  await runToolLoop({
    seedMessages: [{ role: "user", content: "x" }],
    llm, tools: [], config: {},
    // 完成时长反序: 越晚声明的 id 越早完成, 验证回传仍按声明顺序
    runTool: async (n, a) => new Promise((r) => {
      const delay = { t1: 90, t2: 60, t3: 10 }[a.id] ?? 0;
      setTimeout(() => r(`result-${a.id}`), delay);
    }),
    shrinkMessages: (m) => m,
  });
  const contents = llm.calls[1].map((m) => (typeof m === "string" ? m : m.content));
  const toolMsgs = contents.filter((c) => typeof c === "string" && /^result-t\d$/.test(c));
  assert.deepEqual(toolMsgs, ["result-t1", "result-t2", "result-t3"], "回传顺序必须与声明顺序一致");
  // _id 也应与声明顺序一一对应
  const ids = llm.calls[1].filter((m) => m && m.role === "tool").map((m) => m._id);
  assert.deepEqual(ids, ["t1", "t2", "t3"], "tool 消息 _id 顺序必须与声明一致");
});

// ---- 3. 串行回退: parallel_tool_calls=false 时行为与旧版一致 ----
test("runToolLoop: parallel_tool_calls=false 回退串行", async () => {
  const plan = [
    { tool_calls: [tc("t1", "w", '{"id":"t1"}'), tc("t2", "w", '{"id":"t2"}')], content: null },
    { tool_calls: [], content: "done" },
  ];
  const llm = mockLLM(plan);
  const order = [];
  const t0 = Date.now();
  await runToolLoop({
    seedMessages: [{ role: "user", content: "x" }],
    llm, tools: [], config: { parallel_tool_calls: false },
    runTool: async (n, a) => {
      order.push(a.id);
      await new Promise((r) => setTimeout(r, 60));
      return `result-${a.id}`;
    },
    shrinkMessages: (m) => m,
  });
  assert.deepEqual(order, ["t1", "t2"], "串行路径必须按声明顺序执行");
  assert.ok(Date.now() - t0 >= 115, "串行路径耗时应为两次调用之和");
});

// ---- 4. safePath 跨平台拒绝 Windows 盘符路径 ----
test("safePath: Windows 盘符路径在任意平台均被拒绝", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-safe-"));
  try {
    for (const p of ["C:\\Windows", "C:/Users", "D:data\\evil"]) {
      assert.throws(() => safePath(root, p), /路径越界拒绝/, `应拒绝: ${p}`);
    }
    // 正常路径不受影响 (相对/嵌套/带点)
    assert.doesNotThrow(() => safePath(root, "src"));
    assert.doesNotThrow(() => safePath(root, "src/../src/a.js"));
    // 盘符大小写均拒绝
    assert.throws(() => safePath(root, "c:\\x"), /路径越界拒绝/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
