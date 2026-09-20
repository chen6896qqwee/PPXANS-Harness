// test/hooks.test.js — 钩子链单测
import test from "node:test";
import assert from "node:assert";
import {
  createHookRegistry,
  HOOK_EVENTS,
  describeHookEvent,
} from "../src/hooks/index.js";

test("HOOK_EVENTS 七事件齐全", () => {
  assert.deepEqual(HOOK_EVENTS, [
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "SessionStop",
    "SubagentStop",
  ]);
});

test("on 返回解绑函数, 解绑后钩子不再执行", async () => {
  const reg = createHookRegistry();
  let calls = 0;
  const off = reg.on("SessionStart", () => {
    calls++;
  });
  await reg.emit("SessionStart");
  assert.equal(calls, 1);
  off();
  await reg.emit("SessionStart");
  assert.equal(calls, 1);
});

test("priority 升序执行", async () => {
  const reg = createHookRegistry();
  const order = [];
  reg.on("PreToolUse", () => order.push(100), { priority: 100 });
  reg.on("PreToolUse", () => order.push(50), { priority: 50 });
  reg.on("PreToolUse", () => order.push(10), { priority: 10 });
  await reg.emit("PreToolUse", { tool: "x" });
  assert.deepEqual(order, [10, 50, 100]);
});

test("PreToolUse block 否决", async () => {
  const reg = createHookRegistry();
  reg.on("PreToolUse", () => ({ decision: "allow" }));
  reg.on("PreToolUse", () => ({ decision: "block", reason: "危险命令" }), { priority: 10 });
  const r = await reg.emit("PreToolUse", { tool: "run_command" });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "危险命令");
});

test("PostToolUse 收集 additionalContext", async () => {
  const reg = createHookRegistry();
  reg.on("PostToolUse", () => ({ additionalContext: "ctx-a" }));
  reg.on("PostToolUse", () => ({ additionalContext: "ctx-b" }));
  const r = await reg.emit("PostToolUse", { tool: "x" });
  assert.equal(r.blocked, false);
  assert.deepEqual(r.additionalContext, ["ctx-a", "ctx-b"]);
});

test("单钩子抛错不中断链 (记录 error)", async () => {
  const reg = createHookRegistry();
  const seen = [];
  reg.on("SessionStart", () => {
    throw new Error("boom");
  });
  reg.on("SessionStart", () => {
    seen.push("after");
  });
  const r = await reg.emit("SessionStart");
  assert.equal(seen.length, 1);
  assert.equal(r.results[0].error, "boom");
});

test("超时不中断链 (Promise.race 熔断)", async () => {
  const reg = createHookRegistry();
  const seen = [];
  // 永不 resolve 的钩子, 短超时
  reg.on("SessionStart", () => new Promise(() => {}), { timeoutMs: 30 });
  reg.on("SessionStart", () => {
    seen.push("after");
  });
  const r = await reg.emit("SessionStart");
  assert.equal(seen.length, 1);
  assert.equal(r.results[0].timedOut, true);
  assert.ok(r.results[0].error);
});

test("未知事件 on 抛错", () => {
  const reg = createHookRegistry();
  assert.throws(() => reg.on("Nope", () => {}), /未知钩子事件/);
});

test("describeHookEvent 可读一行", () => {
  assert.equal(describeHookEvent("PreToolUse", { tool: "read_file" }), "PreToolUse: 工具=read_file");
  assert.equal(describeHookEvent("SessionStop", { sessionId: "s1" }), "SessionStop: 会话停止 (s1)");
  assert.equal(describeHookEvent("SubagentStop", { agent: "legion" }), "SubagentStop: 子代理=legion");
});
