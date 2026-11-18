// test/approval-headless.test.js — 基准审批策略守卫 (2026-10-09)
// 背景: 无头环境审批必拒, destructive 工具 (delete_file) 在 taskbench 结构性失败
//   (官方基线 90s 烧满, 复评实测复现)。修复 = 显式声明 approval_headless="auto-approve"
//   的测试策略; 本守卫锁两个语义: 默认拒绝不变 / 显式声明才放行。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PPXAgent } from "../src/agent/index.js";

function makeAgent(agentCfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ah-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    providers: [],
    agent: { localIntent: false, proactive: { enabled: false }, ...agentCfg },
  }), "utf8");
  const agent = new PPXAgent({
    root,
    configFile: path.join(root, "config", "ppx.json"),
    dataDir: path.join(root, ".ppx"),
    globalDataDir: path.join(root, ".ppx-global"),
  });
  // 桩 LLM: 不真正调用
  agent.llm = { model: "stub", chat: async () => ({ choices: [{ message: { content: "" } }] }), apiChat: async () => ({ choices: [{ message: { content: "" } }] }) };
  agent.allProviders = [agent.llm];
  return agent;
}

test("默认 (未声明 approval_headless) → headless 快拒语义不变", async () => {
  const agent = makeAgent({});
  assert.equal(agent.hasApprovalSurface(), false);
  // 决策分支的可观测代理: tracer 事件由内部产生, 这里锁配置读数路径存在且默认 undefined
  assert.notEqual(agent.config?.agent?.approval_headless, "auto-approve");
  await agent.shutdown?.();
});

test("显式 approval_headless=auto-approve → 配置可读, runOne 装配注入生效", async () => {
  const agent = makeAgent({ approval_headless: "auto-approve" });
  assert.equal(agent.config.agent.approval_headless, "auto-approve");
  await agent.shutdown?.();
});

test("runOne 对 createAgent 产物也注入基准审批策略 (delete-file 可测)", async () => {
  // 复用 taskbench runOne 的注入逻辑: 走桩 agent, 断言 runOne 后策略在位
  const { runOne } = await import("../scripts/taskbench.js");
  const { TASKS } = await import("../bench/tasks.js");
  const t = TASKS.find((x) => x.id === "delete-file");
  let captured = null;
  const r = await runOne(t, {
    quiet: true,
    createAgent: (sb) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ahrun-"));
      fs.mkdirSync(path.join(root, "config"), { recursive: true });
      fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ providers: [], agent: {} }), "utf8");
      const agent = new PPXAgent({ root, configFile: path.join(root, "config", "ppx.json"), dataDir: path.join(root, ".ppx"), globalDataDir: path.join(root, ".ppx-global") });
      agent.llm = { model: "stub", chat: async () => ({ choices: [{ message: { content: "已删除" } }] }), apiChat: async () => ({ choices: [{ message: { content: "已删除" } }] }) };
      agent.allProviders = [agent.llm];
      captured = agent;
      return agent;
    },
  });
  assert.equal(captured.config.agent.approval_headless, "auto-approve", "runOne 必须给基准 agent 注入审批策略");
  // 桩 LLM 不真调工具, 任务本身判负无妨 —— 本测试锁的是"策略在位"
  assert.equal(typeof r.pass, "boolean");
});
