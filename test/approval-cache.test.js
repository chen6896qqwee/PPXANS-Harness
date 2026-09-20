// test/approval-cache.test.js - B2 审批缓存 (codex ApprovalStore 语义)
// 会话内相同命令批准后不重复 ask; 拒绝/超时永不入缓存; 非命令工具不缓存; 可配置关闭
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";

function tmp(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-b2-${n}-`)); }

// 构造 agent + 注入返回 ask 的权限引擎 + 拦截 _requestApproval 计数
function makeAgent(mode = "approve", cfgExtra = {}) {
  const agent = new PPXAgent({ root: tmp("agent") });
  let asks = 0;
  agent._requestApproval = async () => { asks += 1; return mode === "approve" ? {} : null; };
  agent.permissions = { check: async () => ({ decision: "ask", reason: "测试 ask" }) };
  // 允许注入 approval_cache 开关等配置
  agent.config = agent.config || {};
  agent.config.agent = Object.assign({}, agent.config.agent, cfgExtra);
  return { agent, count: () => asks };
}

test("approval-cache: _approvalCacheKey 只认命令类工具 + 规范化命令", () => {
  const { agent } = makeAgent();
  assert.equal(agent._approvalCacheKey("run_command", { command: "echo  a" }), "run_command:echo a");
  assert.equal(agent._approvalCacheKey("run_command", { command: "echo  \"a\"" }), "run_command:echo a");
  assert.equal(agent._approvalCacheKey("code_act", { code: "print(1)" }), "code_act:print(1)");
  // 非命令工具不缓存
  assert.equal(agent._approvalCacheKey("read_file", { path: "x" }), null);
  assert.equal(agent._approvalCacheKey("get_time", {}), null);
  // 空命令不缓存
  assert.equal(agent._approvalCacheKey("run_command", {}), null);
  assert.equal(agent._approvalCacheKey("run_command", { command: "   " }), null);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("approval-cache: 批准后同命令二次不再 ask (命中缓存)", async () => {
  const { agent, count } = makeAgent("approve");
  const r1 = await agent._runTool("run_command", { command: "echo b2a" });
  assert.equal(count(), 1, "首次触发一次 ask");
  const r2 = await agent._runTool("run_command", { command: "echo b2a" });
  assert.equal(count(), 1, "同命令二次命中缓存, 不重复 ask");
  assert.ok(!r2.startsWith("[工具错误]"), "批准的命令正常放行执行");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("approval-cache: 批准后不同命令仍会 ask", async () => {
  const { agent, count } = makeAgent("approve");
  await agent._runTool("run_command", { command: "echo b2b" });
  await agent._runTool("run_command", { command: "echo b2c" });
  assert.equal(count(), 2, "不同命令不共享缓存");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("approval-cache: 拒绝/超时不入缓存, 同命令仍会再 ask", async () => {
  const { agent, count } = makeAgent("deny");
  const r1 = await agent._runTool("run_command", { command: "echo b2d" });
  assert.ok(r1.startsWith("[工具错误]"), "拒绝后返回错误");
  assert.equal(count(), 1);
  const r2 = await agent._runTool("run_command", { command: "echo b2d" });
  assert.equal(count(), 2, "拒绝结果不入缓存, 同命令继续 ask");
  assert.ok(r2.startsWith("[工具错误]"), "依然被拒");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("approval-cache: 非命令工具不受缓存影响 (每次 ask)", async () => {
  const { agent, count } = makeAgent("approve");
  await agent._runTool("get_time", {});
  await agent._runTool("get_time", {});
  assert.equal(count(), 2, "非命令工具每次询问, 不缓存");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("approval-cache: approval_cache=false 时关闭缓存 (同命令重复 ask)", async () => {
  const { agent, count } = makeAgent("approve", { approval_cache: false });
  await agent._runTool("run_command", { command: "echo b2e" });
  await agent._runTool("run_command", { command: "echo b2e" });
  assert.equal(count(), 2, "关闭缓存后同命令仍重复 ask");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});