// test/team-orchestration.test.js - 班组编排 runTeam + spawn_agent(team) (2026-10-07)
// 用桩军团 (不真 spawn 子进程) 验证五种拓扑的**协作形状**:
//   parallel    各自产出 → 仲裁整合
//   pipeline    前环产出成为后环输入
//   debate      正反两方 + 仲裁
//   review      实施 + 只读审查
//   supervisor  交给 runSupervisor (本文件只验证它被接上)
// 以及安全侧: 只读成员挂 PPX_AGENT_READONLY、高风险班组产出带复核提示、子进程回收。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { runTeam } from "../src/tools/delegate.js";
import { setLevel } from "../src/utils/logger.js";

setLevel("error");
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-team-${tag}-`));

// 桩军团: 记录 spawn 的 env / 收到的消息, 按名字返回可预测的回复
function stubLegion({ replies = [] } = {}) {
  const spawned = [];
  const sent = [];
  return {
    spawned,
    sent,
    spawnAgents: async (specs) => { for (const s of specs) spawned.push(s); return specs.map((s) => s.name); },
    spawnAgent: (name, opts) => { spawned.push({ name, opts }); },
    send: async (name, msg) => {
      sent.push({ name, message: msg.message, perspective: msg.perspective });
      const idx = spawned.findIndex((s) => s.name === name);
      return { reply: replies[idx >= 0 ? idx % replies.length : 0] ?? `来自 ${name}` };
    },
    killAgent: async () => true,
    list: () => spawned.map((s) => ({ name: s.name })),
  };
}

function mkAgent(tag) {
  const a = new PPXAgent({ root: path.resolve("."), dataDir: tmp(tag) });
  a.llm = { chat: async () => ({ content: "【整合结论】" }) };
  return a;
}

test("runTeam(pipeline): 前环产出进入后环消息", async () => {
  const a = mkAgent("pipe");
  try {
    const L = stubLegion({ replies: ["第一步产出", "第二步产出", "第三步产出"] });
    const team = { id: "dev", name: "研发班组", topology: "pipeline" };
    const members = [
      { name: "产品专家", perspective: "需求视角" },
      { name: "代码专家", perspective: "实现视角" },
      { name: "测试专家", perspective: "验证视角" },
    ];
    const { text, spawnNames } = await runTeam({ agent: a, L, team, members, task: "上个功能" });
    assert.equal(spawnNames.length, 3);
    assert.ok(text.includes("第一步产出") && text.includes("第三步产出"));
    assert.ok(!L.sent[0].message.includes("上一环"), "第一环不带上游");
    assert.ok(L.sent[1].message.includes("第一步产出"), "第二环拿到上一环产出");
    assert.ok(L.sent[2].message.includes("第二步产出"), "第三环拿到第二环产出");
    assert.ok(L.sent[2].message.includes("不要重复"), "带不重复指令");
  } finally { a.shutdown(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
});

test("runTeam(parallel): 各自独立产出并仲裁整合", async () => {
  const a = mkAgent("par");
  try {
    const L = stubLegion({ replies: ["A 的看法", "B 的看法", "C 的看法"] });
    const team = { id: "content", name: "内容班组", topology: "parallel" };
    const members = [
      { name: "创意总监", perspective: "创意视角" },
      { name: "设计专家", perspective: "设计视角" },
      { name: "多模态工程师", perspective: "视觉视角" },
    ];
    const { text } = await runTeam({ agent: a, L, team, members, task: "做个短片" });
    assert.ok(text.includes("【整合结论】"), "仲裁结论在前");
    assert.ok(text.includes("各方原始产出"), "原始产出附后");
    assert.ok(text.includes("A 的看法") && text.includes("C 的看法"));
    assert.equal(L.sent.length, 3, "三人各收到一次任务");
    assert.equal(new Set(L.sent.map((s) => s.perspective)).size, 3, "视角差异化");
  } finally { a.shutdown(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
});

test("runTeam(debate): 正反两方都要求给出对方立场", async () => {
  const a = mkAgent("deb");
  try {
    const L = stubLegion({ replies: ["正方论据", "反方论据"] });
    const team = { id: "debate", name: "对抗论证班组", topology: "debate" };
    const members = [
      { name: "架构专家", perspective: "架构视角" },
      { name: "安全专家", perspective: "安全视角", readonly: true },
    ];
    const { text, spawnNames } = await runTeam({ agent: a, L, team, members, task: "要不要上微服务" });
    assert.equal(spawnNames.length, 2);
    assert.ok(L.sent[0].message.includes("正方"), "第一位是正方");
    assert.ok(L.sent[1].message.includes("反方"), "第二位是反方");
    assert.ok(text.includes("正方论据") && text.includes("反方论据"));
    assert.ok(text.includes("仲裁"));
  } finally { a.shutdown(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
});

test("runTeam(review): 只读成员挂只读杠杆, 有问题时标注未修复", async () => {
  const a = mkAgent("rev");
  try {
    const L = stubLegion({ replies: ["实现产出", "[Critical] 缺少边界检查"] });
    const team = { id: "hotfix", name: "紧急修复班组", topology: "review" };
    const members = [
      { name: "代码专家", perspective: "实现视角" },
      { name: "代码审查专家", perspective: "审查视角", readonly: true },
    ];
    const { text } = await runTeam({ agent: a, L, team, members, task: "修个 bug" });
    assert.ok(text.includes("⚠️ 审查发现问题"), text.slice(0, 80));
    assert.ok(text.includes("[严重] 缺少边界检查"), "严重级被映射为中文标签");
    const revSpawn = L.spawned.find((s) => s.name.includes("代码审查专家"));
    assert.equal(revSpawn.opts.env.PPX_AGENT_READONLY, "1", "只读成员挂只读杠杆");
    const implSpawn = L.spawned.find((s) => s.name.includes("代码专家") && !s.name.includes("审查"));
    assert.notEqual(implSpawn.opts.env.PPX_AGENT_READONLY, "1", "实施者可写");
  } finally { a.shutdown(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
});

test("runTeam: 全体 spawn 都走治理入口 (spawnAgents 优先), 且数据目录隔离", async () => {
  const a = mkAgent("spawn");
  try {
    const L = stubLegion({ replies: ["x"] });
    const team = { id: "data", name: "数据班组", topology: "parallel" };
    const members = [{ name: "数据专家", perspective: "p" }, { name: "商业顾问", perspective: "p" }];
    const out = [];
    await runTeam({ agent: a, L, team, members, task: "t", onSpawn: (n) => out.push(n) });
    assert.equal(L.spawned.length, 2, "全部经 spawnAgents");
    assert.deepEqual(out, L.spawned.map((s) => s.name), "onSpawn 回调逐个上报 (供 finally 回收)");
    for (const s of L.spawned) {
      assert.ok(s.opts.dataDir.startsWith(path.join(a.dataDir, "legion")), "数据目录在本 agent 下隔离");
      assert.ok(s.name.includes("data"), "名字带班组标识, 与其他委派不冲突");
    }
  } finally { a.shutdown(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
});

test("spawn_agent(team): 班组整体接管分工, 高风险班组带人类复核提示", async () => {
  const a = mkAgent("judge");
  try {
    const L = stubLegion({ replies: ["安全意见", "合规意见", "法务意见"] });
    a._legion = L;
    const res = await a.tools.call("spawn_agent", { task: "评估这个数据出境方案", team: "评审" }, { agent: a });
    assert.ok(res.includes("【班组】评审班组"), res.slice(0, 120));
    assert.ok(res.includes("拓扑 parallel"));
    assert.ok(res.includes("安全专家") && res.includes("合规风控专家"), "成员列全");
    assert.ok(res.includes("⚠ 本班组含高风险域专家"), "高风险班组带提示");
    assert.ok(res.includes("需人类复核后执行"), "明确的复核要求");
  } finally { a.shutdown(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
});

test("spawn_agent(team): 未知班组静默退回普通委派 (不炸)", async () => {
  const a = mkAgent("ghost");
  try {
    a._legion = stubLegion({ replies: ["普通回复"] });
    const res = await a.tools.call("spawn_agent", { task: "干活", team: "不存在的班组" }, { agent: a });
    assert.ok(res.includes("普通回复"), res.slice(0, 120));
  } finally { a.shutdown(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
});

test("spawn_agent(experts+pipeline): 临时专家组按序传递", async () => {
  const a = mkAgent("adhoc");
  try {
    const L = stubLegion({ replies: ["拆解结果", "实现结果"] });
    a._legion = L;
    const res = await a.tools.call("spawn_agent", {
      task: "实现一个功能", experts: ["product", "code"], topology: "pipeline",
    }, { agent: a });
    assert.ok(res.includes("【临时专家组】拓扑 pipeline"), res.slice(0, 120));
    assert.ok(L.sent[1].message.includes("拆解结果"), "第二环看到第一环产出");
  } finally { a.shutdown(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
});
