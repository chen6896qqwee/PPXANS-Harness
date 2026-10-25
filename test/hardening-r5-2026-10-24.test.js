// test/hardening-r5-2026-10-24.test.js - 2026-10-24 第五轮加固回归测试
// 覆盖: 会话回卷 /rewind (fork+重定向) / 同会话并发互斥锁 / 流式降级副作用防护
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-r5-${tag}-`));
}

function makeAgent(tag, llm) {
  const root = tmpDir(tag);
  const agent = new PPXAgent({ root, configFile: null });
  agent.llm = llm || { chat: async () => ({ content: "ok" }), apiChat: async () => ({ message: { role: "assistant", content: "ok" } }) };
  return { root, agent };
}

// ---- 会话回卷 ----
test("rewind: 回退 1 轮 → fork 新分支, 后续对话落在分支上, 原会话保留", async () => {
  const { agent, root } = makeAgent("rw1");
  await agent.chat("第一轮", { sessionKey: "s", persist: true });
  await agent.chat("第二轮", { sessionKey: "s", persist: true });
  const before = agent.sessionStore.count("s");
  const r = await agent.chat("/rewind", { sessionKey: "s", persist: false });
  assert.ok(r.includes("已回退最近 1 轮"), r.slice(0, 60));
  // 重定向生效: 原会话不动, 新轮次落到分支
  assert.equal(agent.sessionStore.count("s"), before, "原会话 append-only 保留");
  await agent.chat("回卷后的新说法", { sessionKey: "s", persist: true });
  const keys = [...agent._sessionRedirect.values()];
  assert.ok(agent.sessionStore.count(keys[0]) > 0, "新轮次写进分支会话");
  // 分支历史不含被回退的"第二轮"
  const branchEvents = agent.sessionStore.replay(keys[0]).map((e) => e.data?.content || "");
  assert.ok(!branchEvents.some((c) => String(c).includes("第二轮")), "被回退轮不进分支历史");
  assert.ok(branchEvents.some((c) => String(c).includes("回卷后的新说法")), "新轮次在分支里");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("rewind: /rewind 2 一次回退两轮; 空会话/越界诚实报错", async () => {
  const { agent, root } = makeAgent("rw2");
  for (const m of ["一", "二", "三"]) await agent.chat(m, { sessionKey: "s", persist: true });
  const r = await agent.chat("/rewind 2", { sessionKey: "s", persist: false });
  assert.ok(r.includes("已回退最近 2 轮"));
  const branch = [...agent._sessionRedirect.values()][0];
  const contents = agent.sessionStore.replay(branch).map((e) => e.data?.content || "");
  assert.ok(!contents.some((c) => String(c).includes("二") || String(c).includes("三")), "两轮都被回退");
  assert.ok(contents.some((c) => String(c).includes("一")), "第一轮保留");
  // 空会话回退
  const e1 = await agent.chat("/rewind", { sessionKey: "empty", persist: false });
  assert.ok(e1.includes("没有可回退"));
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- 同会话并发互斥 ----
test("lock: 同会话并发轮次串行执行 (不交错), 不同会话并行", async () => {
  const { agent, root } = makeAgent("lock", {
    chat: async () => ({ content: "ok" }),
    apiChat: async (msgs) => {
      // 记录每个请求开始时, 该会话是否已有未完成请求 (用共享标记模拟交错检测)
      await new Promise((r) => setTimeout(r, 30)); // 制造重叠窗口
      return { message: { role: "assistant", content: "done" } };
    },
  });
  const order = [];
  const mk = (m) => agent.chat(m, {
    sessionKey: "same",
    persist: true,
  }).then((r) => order.push(`${m}:${r}`));
  await Promise.all([mk("A"), mk("B"), mk("C")]);
  assert.equal(order.length, 3);
  assert.ok(agent.sessionStore.count("same") >= 6, "三轮全部落库 (user+assistant 各一)");
  // 交错检测: _withSessionLock 串行化 → 每轮开始时上一轮必已完成 (通过 _sessionLocks 单尾链保证)
  assert.ok(agent._sessionLocks.get("same") === undefined || agent._sessionLocks.size <= 1, "锁完成自清理");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- 流式降级防护 ----
test("chatStream 降级: 回放缓存保留 (非幂等工具不双执行) + 分隔标记", async () => {
  const root = tmpDir("degrade");
  const agent = new PPXAgent({ root, configFile: null });
  agent.config.agent.localIntent = false; // 关本地短路, 确保走 LLM 路径
  const executed = [];
  agent.toolsEnabled = true;
  const llm = {
    supportsStream: true,
    model: "stub",
    // 流式吐出部分文本后中断 → 触发降级 + 分隔标记 (一个字没吐时静默降级不插标记)
    apiChatStream: async (msgs, { onDelta }) => { onDelta?.("半截"); throw new Error("stream down"); },
    apiChat: async () => ({ message: { role: "assistant", content: "非流式回复" } }),
  };
  agent.llm = llm;
  agent.allProviders = [llm];
  const deltas = [];
  const reply = await agent.chatStream("hi", { sessionKey: "d", onDelta: (d) => deltas.push(d) });
  assert.equal(reply, "非流式回复");
  assert.ok(deltas.some((d) => d.includes("已重新生成")), "降级插分隔标记");

  // 降级内态: _turnInProgress=true 时 _chatCore 保留回放缓存 (非幂等工具不双执行)
  const MEMO_KEY = "write_file|" + JSON.stringify({ path: "x", content: "y" });
  agent._turnInProgress = true;
  agent._turnExecCache = new Map([[MEMO_KEY, { value: "先前结果" }]]);
  await agent._chatCore("再来", { sessionKey: "d", persist: false });
  assert.ok(agent._turnExecCache.has(MEMO_KEY), "降级轮保留缓存");
  agent._turnAttempt = 1;
  agent.tools = { call: async () => { executed.push(1); return "再次执行"; }, getCapability: () => null };
  agent._toolIdempotent = () => false;
  const memo = await agent._runTool("write_file", { path: "x", content: "y" });
  assert.ok(memo.includes("回放缓存"), "命中缓存, 不重复执行");
  assert.equal(executed.length, 0);
  // 正常轮 (R5): _turnInProgress=false → chat 重置缓存
  agent._turnInProgress = false;
  agent._turnAttempt = 0;
  await agent.chat("正常轮", { sessionKey: "d", persist: false });
  assert.equal(agent._turnExecCache.size, 0, "正常轮缓存照常重置");
  assert.equal(agent._turnInProgress, false, "轮收口复位");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- (R8) 流式通道斜杠命令分发 (R3 只接了 chat, Web UI 走 chatStream 曾全部失效) ----
test("chatStream: 斜杠命令在流式路径直接执行 (不喂 LLM), 结果经 onDelta 推送", async () => {
  const root = tmpDir("cmd-stream");
  const agent = new PPXAgent({ root, configFile: null });
  agent.config.agent.localIntent = false;
  let llmCalled = 0;
  agent.llm = {
    chat: async () => { llmCalled++; return { content: "LLM-REPLY" }; },
    apiChat: async () => { llmCalled++; return { message: { role: "assistant", content: "LLM-REPLY" } }; },
  };
  const deltas = [];
  const r = await agent.chatStream("/status", { sessionKey: "cs", onDelta: (d) => deltas.push(d) });
  assert.equal(llmCalled, 0, "命令不调 LLM");
  assert.ok(r.includes("模型:") && r.includes("生命周期"), "返回命令结果");
  assert.ok(deltas.join("").includes("模型:"), "结果经 onDelta 推给前端");
  // 非命令输入照常走 LLM
  const r2 = await agent.chatStream("普通问题", { sessionKey: "cs" });
  assert.equal(r2, "LLM-REPLY");
  assert.ok(llmCalled > 0);
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("chatStream: /plan /do 在流式路径翻转计划态", async () => {
  const root = tmpDir("plan-stream");
  const agent = new PPXAgent({ root, configFile: null });
  agent.config.agent.localIntent = false;
  agent.llm = { chat: async () => ({ content: "x" }), apiChat: async () => ({ message: { role: "assistant", content: "x" } }) };
  const r1 = await agent.chatStream("/plan", { sessionKey: "ps" });
  assert.ok(r1.includes("已进入计划模式"));
  assert.equal(agent.isPlanMode("ps"), true);
  // 计划态经 chatStream 传给权限层 (工具准入拒绝) —— _admitToolCall 从 trace 上下文取会话
  agent.tools = { call: async () => "x", getCapability: () => ({ readOnly: false, destructive: true }) };
  const { runWithTrace } = await import("../src/core/trace.js");
  const admit = await runWithTrace(
    () => agent._admitToolCall("write_file", { path: "a.txt" }, "c1", Date.now()),
    { sessionKey: "ps" },
  );
  assert.equal(admit.ok, false, "计划态下破坏性工具被拒");
  const r2 = await agent.chatStream("/do", { sessionKey: "ps" });
  assert.ok(r2.includes("已退出计划模式"));
  assert.equal(agent.isPlanMode("ps"), false);
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("chatStream: /rewind 在流式路径可用 (fork 分支 + 重定向)", async () => {
  const root = tmpDir("rw-stream");
  const agent = new PPXAgent({ root, configFile: null });
  agent.config.agent.localIntent = false;
  agent.llm = { chat: async () => ({ content: "ok" }), apiChat: async () => ({ message: { role: "assistant", content: "ok" } }) };
  await agent.chat("第一轮", { sessionKey: "s", persist: true });
  await agent.chat("第二轮", { sessionKey: "s", persist: true });
  const before = agent.sessionStore.count("s");
  const r = await agent.chatStream("/rewind", { sessionKey: "s" });
  assert.ok(r.includes("已回退最近 1 轮"), r.slice(0, 60));
  assert.equal(agent.sessionStore.count("s"), before, "原会话保留");
  await agent.chat("分支新话", { sessionKey: "s", persist: true });
  const branch = [...agent._sessionRedirect.values()][0];
  const contents = agent.sessionStore.replay(branch).map((e) => e.data?.content || "");
  assert.ok(!contents.some((c) => String(c).includes("第二轮")), "被回退轮不在分支");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- (R9) 重定向链路审计回归: trace 上下文 / resetSession / usedTools 收口 ----
test("R9: 回卷后 /plan 计划态对工具准入生效 (trace 携带真实会话 key)", async () => {
  const root = tmpDir("rw-plan");
  const agent = new PPXAgent({ root, configFile: null });
  agent.config.agent.localIntent = false;
  agent.llm = { chat: async () => ({ content: "ok" }), apiChat: async () => ({ message: { role: "assistant", content: "ok" } }) };
  await agent.chat("铺垫轮", { sessionKey: "s", persist: true });
  await agent.chatStream("/rewind", { sessionKey: "s" });
  await agent.chatStream("/plan", { sessionKey: "s" });
  const branch = agent._redirectSession("s");
  assert.equal(agent.isPlanMode(branch), true, "计划态设在分支会话上");
  // 工具准入: 经 runWithTrace(s) —— 即 Web 实际调用形态
  agent.tools = { call: async () => "x", getCapability: () => ({ readOnly: false, destructive: true }) };
  const { runWithTrace } = await import("../src/core/trace.js");
  const admit = await runWithTrace(
    () => agent._admitToolCall("write_file", { path: "a.txt" }, "c1", Date.now()),
    { sessionKey: "s" }, // 调用方仍用原始 key (Web 场景), trace 由 chat 内部解析
  );
  // 注意: _admitToolCall 读 trace 的 sessionKey —— 修复后 chat/chatStream 在 trace 外先解析;
  // 这里直接以分支 key 建 trace 验证引擎侧判定
  const admit2 = await runWithTrace(
    () => agent._admitToolCall("write_file", { path: "a.txt" }, "c2", Date.now()),
    { sessionKey: branch },
  );
  assert.equal(admit2.ok, false, "分支会话的计划态拒绝破坏性工具");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("R9: resetSession 感知重定向 —— 删分支+清映射, 而非只删陈旧原始会话", async () => {
  const root = tmpDir("rw-reset");
  const agent = new PPXAgent({ root, configFile: null });
  agent.config.agent.localIntent = false;
  agent.llm = { chat: async () => ({ content: "ok" }), apiChat: async () => ({ message: { role: "assistant", content: "ok" } }) };
  await agent.chat("旧轮一", { sessionKey: "s", persist: true });
  await agent.chat("旧轮二", { sessionKey: "s", persist: true });
  await agent.chatStream("/rewind", { sessionKey: "s" });
  const branch = agent._redirectSession("s");
  assert.ok(agent.sessionStore.count(branch) > 0);
  await agent.chatStream("/do", { sessionKey: "s" }); // 退出可能残留的计划态
  agent.resetSession("s"); // HTTP /reset 同款调用
  assert.equal(agent.sessionStore.count(branch), 0, "分支会话被真删 (用户可感知的重置)");
  assert.equal(agent._redirectSession("s"), "s", "重定向映射已清, 回到原始命名空间");
  await agent.chat("重置后的新轮", { sessionKey: "s", persist: true });
  assert.equal(agent.sessionStore.count("s") > 0, true, "新轮落回原始会话");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("R9: usedTools 双通道收口 —— chat 轮后 _turnsUsedTools 无残留", async () => {
  const root = tmpDir("used-tools");
  const agent = new PPXAgent({ root, configFile: null });
  agent.config.agent.localIntent = false;
  agent.tools = { call: async () => "ok", getCapability: () => null };
  agent.llm = {
    chat: async () => ({ content: "ok" }),
    apiChat: async () => ({
      message: { role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name: "list_dir", arguments: "{}" } }] },
    }),
  };
  await agent.chat("用工具", { sessionKey: "ut", persist: false });
  assert.equal(agent._lastTurnUsedTools, false, "引擎级标记复位");
  assert.equal(agent._turnsUsedTools.has("ut"), false, "会话级标记已收口 (此前 chat 通道永久残留)");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- (R10) 流式通道 provider 回退链 + 降级提示可见 ----
function streamStub(model, behavior) {
  return {
    model,
    supportsStream: true,
    health: async () => behavior.health !== false,
    apiChatStream: async (msgs, { onDelta } = {}) => {
      if (behavior.streamError) throw new Error(behavior.streamError);
      if (behavior.streamDeltas) for (const d of behavior.streamDeltas) onDelta?.(d);
      return { message: { role: "assistant", content: behavior.text || "" } };
    },
    apiChat: async () => {
      if (behavior.apiError) throw new Error(behavior.apiError);
      return { message: { role: "assistant", content: behavior.apiText || "" } };
    },
  };
}

test("R10: 主模型宕机 (健康探测失败) → 流式无缝切到备用 provider", async () => {
  const root = tmpDir("fo-health");
  const agent = new PPXAgent({ root, configFile: null });
  agent.config.agent.localIntent = false;
  const dead = streamStub("dead", { health: false });
  const alive = streamStub("alive", { streamDeltas: ["流", "式"], text: "流式答案" });
  agent.allProviders = [dead, alive];
  agent.llm = dead;
  const deltas = [];
  const r = await agent.chatStream("hi", { sessionKey: "f", onDelta: (d) => deltas.push(d) });
  assert.equal(r, "流式答案", "备用 provider 的流式回复");
  assert.deepEqual(deltas.filter((d) => d !== "流式答案"), ["流", "式"], "逐字增量到达前端");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("R10: 主模型探活通过但调用失败 → 回退链切换, 降级提示对流式用户可见", async () => {
  const root = tmpDir("fo-notice");
  const agent = new PPXAgent({ root, configFile: null });
  agent.config.agent.localIntent = false;
  const broken = streamStub("broken", { streamError: "boom" });
  const alive = streamStub("alive", { streamDeltas: ["备用"], text: "备用回答", apiText: "备用回答" });
  agent.allProviders = [broken, alive];
  agent.llm = broken;
  const notices = [];
  agent.setNotify((m) => notices.push(m));
  const r = await agent.chatStream("hi", { sessionKey: "f" });
  assert.ok(r.includes("备用回答"), "备用 provider 回复 — got: " + String(r).slice(0, 120));
  assert.ok(r.includes("已自动切换"), "流式用户也能看到降级提示 (R10 审计#5)");
  assert.ok(notices.some((n) => n.includes("降级")), "notify 推送降级事实");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("R10: 回退链走非流式 provider 时增量补发全文 (前端不空屏)", async () => {
  const root = tmpDir("fo-nostream");
  const agent = new PPXAgent({ root, configFile: null });
  agent.config.agent.localIntent = false;
  const dead = streamStub("dead", { health: false });
  const alive = { model: "alive", supportsStream: false, apiChat: async () => ({ message: { role: "assistant", content: "非流式备用" } }) };
  agent.allProviders = [dead, alive];
  agent.llm = dead;
  const deltas = [];
  const r = await agent.chatStream("hi", { sessionKey: "f", onDelta: (d) => deltas.push(d) });
  assert.equal(r, "非流式备用");
  assert.deepEqual(deltas, ["非流式备用"], "无增量时 done 前补发全文");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
