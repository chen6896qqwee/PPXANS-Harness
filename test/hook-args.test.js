// test/hook-args.test.js — PreToolUse 改参闭环 (2026-10-31)
// 修复: agent/_runTool 消费 h.args 但 hooks.emit 从不返回 args → "PreToolUse 可改参"是死代码。
// 本文件钉住: 链式改参 / 无改动同引用 / block 仍赢 / 其它事件不带 args。
import test from "node:test";
import assert from "node:assert";
import { createHookRegistry } from "../src/hooks/index.js";

test("PreToolUse 钩子返回 { args } 可修改工具参数 (emit 带出最终 args)", async () => {
  const reg = createHookRegistry();
  reg.on("PreToolUse", () => ({ args: { command: "git status" } }));
  const r = await reg.emit("PreToolUse", { tool: "run_command", args: { command: "rm -rf /" } });
  assert.equal(r.blocked, false);
  assert.deepEqual(r.args, { command: "git status" }, "emit 返回改后参数");
});

test("改参链式: 后续钩子看到前序钩子改后的参数", async () => {
  const reg = createHookRegistry();
  const seen = [];
  reg.on("PreToolUse", (p) => {
    seen.push(p.args.command);
    return { args: { command: "second" } };
  }, { priority: 10 });
  reg.on("PreToolUse", (p) => {
    seen.push(p.args.command);
    return { args: { command: "third" } };
  }, { priority: 20 });
  const r = await reg.emit("PreToolUse", { tool: "run_command", args: { command: "first" } });
  assert.deepEqual(seen, ["first", "second"], "第二个钩子看到第一个钩子改后的参数");
  assert.deepEqual(r.args, { command: "third" });
});

test("无钩子改参时 args 与 payload.args 同引用 (agent 侧赋值为无害 no-op)", async () => {
  const reg = createHookRegistry();
  reg.on("PreToolUse", () => ({ decision: "allow" }));
  const original = { command: "ls" };
  const r = await reg.emit("PreToolUse", { tool: "run_command", args: original });
  assert.equal(r.args, original, "同引用, 不是浅拷贝新对象");
});

test("非对象 args 返回值被忽略 (字符串/ null 不改参)", async () => {
  const reg = createHookRegistry();
  reg.on("PreToolUse", () => ({ args: "not-an-object" }));
  reg.on("PreToolUse", () => ({ args: null }));
  const original = { command: "ls" };
  const r = await reg.emit("PreToolUse", { tool: "x", args: original });
  assert.equal(r.args, original);
});

test("block 语义不受改参影响: block 仍然赢", async () => {
  const reg = createHookRegistry();
  reg.on("PreToolUse", () => ({ args: { command: "harmless" } }));
  reg.on("PreToolUse", () => ({ decision: "block", reason: "拦截" }), { priority: 5 });
  const r = await reg.emit("PreToolUse", { tool: "run_command", args: { command: "evil" } });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "拦截");
});

test("其它事件 (PostToolUse 等) 返回值不带 args 字段", async () => {
  const reg = createHookRegistry();
  reg.on("PostToolUse", () => ({ additionalContext: "ctx" }));
  const r = await reg.emit("PostToolUse", { tool: "x", args: { a: 1 } });
  assert.ok(!("args" in r), "只有 PreToolUse 带改参出口");
  assert.deepEqual(r.additionalContext, ["ctx"]);
});

test("payload 无 args 字段时 emit 不带 args (形状稳定)", async () => {
  const reg = createHookRegistry();
  reg.on("PreToolUse", () => ({}));
  const r = await reg.emit("PreToolUse", { tool: "x" });
  assert.ok(!("args" in r));
});
