import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { record, summarize, context, status, loadState, STATE } from "../src/ans/reward.js";

function tmp(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-reward-${n}-`)); }

test("Reward: 未记录时 summarize 为空, context 零回归", () => {
  const agent = new PPXAgent({ root: tmp("empty") });
  const s = summarize(agent);
  assert.equal(s.tools.length, 0);
  assert.equal(s.unreliable.length, 0);
  assert.equal(context(agent), "", "无不可靠工具时 context 应为空 (零回归)");
  const st = status(agent);
  assert.equal(st.unreliable_count, 0);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Reward: EWMA 成功推动权重上升, 失败拉低", () => {
  const agent = new PPXAgent({ root: tmp("ewma") });
  // 5 次失败 → 权重显著走低
  for (let i=0;i<5;i++) record(agent, { tool: "run_command", ok: false });
  const bad = summarize(agent).tools.find((t)=>t.name==="run_command");
  assert.ok(bad.weight < 0.4, "连续失败权重应<0.4, got "+bad.weight);
  // 成功 1 次后依然偏低但应略升
  record(agent, { tool: "run_command", ok: true });
  const after = agent.bus ? 0 : 0; // 占位
  const again = summarize(agent).tools.find((t)=>t.name==="run_command");
  assert.ok(again.weight > bad.weight, "成功一次后权重应上升");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Reward: 样本不足不判不可靠 (防偶发误伤)", () => {
  const agent = new PPXAgent({ root: tmp("minsamp") });
  // 只 1 次失败 (样本 < MIN_SAMPLES)
  record(agent, { tool: "http_request", ok: false });
  const { unreliable } = summarize(agent);
  assert.equal(unreliable.length, 0, "样本不足不判不可靠");
  assert.equal(context(agent), "", "无 context 注入");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Reward: 样本足够且权重低于阈值 → 识别为不可靠 + context 注入", () => {
  const agent = new PPXAgent({ root: tmp("flag") });
  for (let i=0;i<STATE.MIN_SAMPLES;i++) record(agent, { tool: "http_request", ok: false });
  const { unreliable } = summarize(agent);
  assert.ok(unreliable.some((u)=>u.name==="http_request"), "够样本+低权重应标记不可靠");
  const ctx = context(agent);
  assert.ok(ctx.includes("http_request"), "context 含工具名");
  assert.ok(ctx.includes("低可靠性"), "context 含提示语");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Reward: 持久化跨实例恢复", () => {
  const root = tmp("persist");
  const a1 = new PPXAgent({ root });
  for (let i=0;i<4;i++) record(a1, { tool: "read_file", ok: true });
  assert.equal(loadState(a1).total.wins, 4);
  a1.shutdown();
  // 新实例读同一 dataDir
  const a2 = new PPXAgent({ root });
  const s = summarize(a2);
  assert.ok(s.tools.find((t)=>t.name==="read_file"), "跨实例恢复工具记录");
  assert.equal(s.tools.find((t)=>t.name==="read_file").wins, 4, "wins 持久化");
  const st = status(a2);
  assert.equal(st.total.wins, 4);
  a2.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("Reward: agent 装配 - bus 订阅 tool/result 自动驱动, 无回归", async () => {
  const agent = new PPXAgent({ root: tmp("wired") });
  // 手动通过总线发 tool/result 事件, 验证闭环订阅生效
  if (agent.bus) {
    agent.bus.emit("tool/result", { name: "web_search", ok: false });
    agent.bus.emit("tool/result", { name: "web_search", ok: false });
    const s = summarize(agent);
    const ws = s.tools.find((t)=>t.name==="web_search");
    assert.ok(ws && ws.losses === 2, "总线事件自动驱动 reward");
  }
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});