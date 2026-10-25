// test/plan-mode.test.js — /plan 死命令修复的端到端链路 (2026-10-05)
// 背景: /plan 曾返回 {action:"enter_plan_mode"} 而全仓零消费者 —— 文档里的"计划模式"在
// 出厂代码里不可达, 引擎的 plan 分支只被测试置真。本文件走**真实命令管道**钉住修复:
//   命令注册表 (src/commands) → agent 集成层消费 intent (src/agent chat/chatStream)
//   → 按会话状态 → 准入链 ctx.planEnabled → 权限引擎 plan 分支 deny → /do 退出 → 恢复。
// 不重新实现任何判定, 全部调用生产入口。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { runWithTrace } from "../src/core/trace.js";
import { createBuiltinRegistry } from "../src/commands/index.js";
import { createPermissionEngine, AskForApproval, SandboxPolicy } from "../src/permissions/index.js";
import { HttpChannel } from "../src/channels/http.js";

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-plan-${tag}-`)); }
function mkAgent(tag) { return new PPXAgent({ root: tmp(tag), dataDir: path.join(tmp(tag), "data") }); }

// ---- 命令层: /plan 与 /do 是配对开关, 缺一即 lock-in ----
test("命令注册表: /plan 进入 / /do 退出, 两个 intent 都存在", () => {
  const reg = createBuiltinRegistry();
  assert.deepEqual(reg.execute("/plan"), { type: "intent", action: "enter_plan_mode" });
  assert.deepEqual(reg.execute("/do"), { type: "intent", action: "exit_plan_mode" });
});

// ---- 端到端: 真实命令管道 → 引擎拒绝 → 退出恢复 ----
test("端到端: /plan → 引擎拒 code_run (含可行动提示) → 只读工具照常 → /do 恢复", async () => {
  const agent = mkAgent("e2e");
  try {
    // 1) 用户输入 /plan: 走 agent.chat 真实入口 (命令注册表 intent → 集成层翻转)
    const enter = await agent.chat("/plan", { sessionKey: "default" });
    assert.match(enter, /计划模式/, "进入应答要说明白了");
    assert.ok(agent.isPlanMode("default"), "会话计划态已开");

    // 2) 写/执行类工具在真实准入链 (_admitToolCall, _runTool 的准入半边) 被引擎拒绝
    const deny = await agent._admitToolCall("code_run", { code: "1+1" }, "t-deny", Date.now());
    assert.equal(deny.ok, false, "plan 模式下 code_run 必须被拒");
    assert.match(deny.error, /plan 模式/, "拒绝理由点名 plan 模式");
    assert.match(deny.error, /\/do/, "拒绝必须可行动: 告诉模型/用户怎么退 (/do)");
    assert.match(deny.error, /计划/, "拒绝引导模型先产出计划交用户审阅");

    // 3) 只读工具照常准入 (计划模式不是把会话变瘫, 是只读)
    const ro = await agent._admitToolCall("read_file", { path: "README.md" }, "t-ro", Date.now());
    assert.equal(ro.ok, true, "plan 模式只读工具不受阻");

    // 4) /do 退出 → 恢复原审批语义
    const exit = await agent.chat("/do", { sessionKey: "default" });
    assert.match(exit, /退出|恢复/, "退出应答");
    assert.ok(!agent.isPlanMode("default"), "计划态已清");
    const ok = await agent._admitToolCall("code_run", { code: "1+1" }, "t-ok", Date.now());
    assert.equal(ok.ok, true, "退出后 code_run 恢复准入");

    // 5) /do 在未开计划态的会话上是无操作提示, 不报错
    const noop = await agent.chat("/do", { sessionKey: "default" });
    assert.match(noop, /不在计划模式/, "重复退出 = 明确无操作, 不是失败");
  } finally {
    agent.shutdown();
  }
});

// ---- 不变量: 按会话存储, 不跨会话泄漏, 不跨重置幸存 ----
test("会话隔离: A 会话进 plan 不影响 B; 新会话默认非 plan; /reset 清零", async () => {
  const agent = mkAgent("iso");
  try {
    await agent.chat("/plan", { sessionKey: "alpha" });
    assert.ok(agent.isPlanMode("alpha"));
    assert.ok(!agent.isPlanMode("default"), "default 会话不受 alpha 计划态影响");
    assert.deepEqual(agent.planModeSessions(), ["alpha"], "计划态可见清单只有 alpha");

    // 真实准入链在 alpha 的 trace 下拒绝 code_run …
    const d = await runWithTrace(
      () => agent._admitToolCall("code_run", { code: "1" }, "t-a", Date.now()),
      { sessionKey: "alpha", channel: "test" },
    );
    assert.equal(d.ok, false, "alpha 会话: plan 拒绝生效");
    // … 在 beta (从未 /plan 过) 的 trace 下放行
    const b = await runWithTrace(
      () => agent._admitToolCall("code_run", { code: "1" }, "t-b", Date.now()),
      { sessionKey: "beta", channel: "test" },
    );
    assert.equal(b.ok, true, "beta 会话: 不泄漏 alpha 的计划态");

    // 会话重置 = 全新会话: 计划态不得幸存
    agent.resetSession("alpha");
    assert.ok(!agent.isPlanMode("alpha"), "/reset 后旧计划态清零");
  } finally {
    agent.shutdown();
  }
});

// ---- 其他斜杠命令链路不变: 未被集成层认领的 intent 原文回落 (不假装处理) ----
test("未认领的命令不劫持链路: /nope 与 /new 不会翻计划态", async () => {
  const agent = mkAgent("fall");
  try {
    // 走真实集成层消费入口 (不发消息给 LLM, 免触发网络; 认领判定就是 chat 里用的那个方法)
    assert.equal(agent._consumePlanCommand("/nope hello", "default"), null);
    assert.equal(agent._consumePlanCommand("/new", "default"), null);
    assert.ok(!agent.isPlanMode("default"), "非 plan 命令不得误翻计划态");
    assert.deepEqual(agent.planModeSessions(), []);
  } finally {
    agent.shutdown();
  }
});

// ---- 默认路径零回归: 没进 plan 的会话, 工作区流程与修复前一致 ----
test("默认流: 未 /plan 时 code_run 准入不受影响 (零新增拦截/审批)", async () => {
  const agent = mkAgent("zero");
  try {
    const r = await agent._admitToolCall("code_run", { code: "1+1" }, "t-0", Date.now());
    assert.equal(r.ok, true);
  } finally {
    agent.shutdown();
  }
});

// ---- 引擎半边: ctx.planEnabled (按会话) 与引擎级 planEnabled 等价生效, 且失败关闭 ----
test("引擎: ctx.planEnabled 按调用注入即生效; 拿不到能力声明也拒绝 (不沉默放行)", async () => {
  const eng = createPermissionEngine({
    approvalMode: AskForApproval.ON_REQUEST,
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: tmp("eng"),
    getCapability: (n) => (n === "reader" ? { readOnly: true, riskLevel: "low" } : null),
    capabilityGate: true,
  });
  // 未开启: 现状不变
  assert.equal((await eng.check("writer", {})).decision, "allow");
  // 会话态经 ctx 传入 (agent 准入链的真实形状)
  const d = await eng.check("writer", {}, { planEnabled: true });
  assert.equal(d.decision, "deny", "会话计划态必须把非只读挡下");
  assert.match(d.reason, /plan 模式/);
  assert.ok(d.modelHint && /\/do/.test(d.modelHint), "拒绝带可行动 modelHint (既有通道)");
  assert.equal((await eng.check("reader", {}, { planEnabled: true })).decision, "allow");
  // 能力不可证 (getter 返回 null) 时 plan 也拒绝 —— 旧实现在这里静默直通 (死命令的另一半)
  assert.equal((await eng.check("unknown_tool", {}, { planEnabled: true })).decision, "deny");
  // ctx 不传 = 不新增任何约束
  assert.equal((await eng.check("writer", {}, {})).decision, "allow");
});

// ---- HTTP 面: /api/permissions 回显并翻转计划态 (形状与既有字段一致) ----
test("HTTP: POST /api/permissions 带 sessionKey 翻会话计划态, 响应回显 plan 字段", async () => {
  const root = tmp("http");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    providers: [],
    channels: { http: { mcp: { enabled: false, legacy_rest: true } } },
  }));
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const post = async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };
    const r1 = await post({ planEnabled: true, sessionKey: "web1" });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.ok, true);
    assert.equal(r1.json.planEnabled, false, "带 sessionKey 只动会话, 不动引擎级");
    assert.deepEqual(r1.json.planSessions, ["web1"], "响应回显按会话计划态");
    assert.ok(agent.isPlanMode("web1"), "HTTP 翻转与 /plan 走同一条状态轨道");

    // 会话态经真实准入链生效 (引擎收到的 ctx.planEnabled 与命令路径同源)
    const d = await runWithTrace(
      () => agent._admitToolCall("code_run", { code: "1" }, "t-h", Date.now()),
      { sessionKey: "web1", channel: "test" },
    );
    assert.equal(d.ok, false, "HTTP 开的会话, 引擎同样挡");

    const r2 = await post({ planEnabled: false, sessionKey: "web1" });
    assert.deepEqual(r2.json.planSessions, [], "退出通道同一端点可用 (不是 lock-in)");

    // GET 形状可观测
    const g = await fetch(`http://127.0.0.1:${port}/api/permissions`, {
      headers: { Authorization: "Bearer tok" },
    });
    const gj = await g.json();
    assert.ok("planEnabled" in gj && "planSessions" in gj, "GET 回显计划态");

    // 无 sessionKey = 引擎级兜底开关 (与既有 approvalMode/sandbox 同层的 knob)
    const r3 = await post({ planEnabled: true });
    assert.equal(r3.json.planEnabled, true);
    await post({ planEnabled: false });
  } finally {
    await ch.disconnect();
    agent.shutdown();
  }
});
