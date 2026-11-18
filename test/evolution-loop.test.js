// test/evolution-loop.test.js - 持续进化循环回归 (2026-10-25, 自主进化第二层)
//
// 钉住 EvolutionLoop 的编排语义:
//   1) 一轮 cycle = learn + iterate + journal 三段, 度量落账 (能力快照 + 各段结果)
//   2) 弱点驱动: 同类故障病历 ≥ 阈值 → 定向 refine 优先 (不再只看最近轨迹)
//   3) 无 LLM / 无目标文件 → 代码迭代段安全跳过, 学习段照常
//   4) 单飞锁: 上一轮未完不叠加; 最小间隔保护
//   5) installEvolutionLoop: config enabled → 每日定时任务注册; 未启用 → 不注册但 loop 可用
//   6) evolution_status 工具: 输出能力快照 + 弱点 + journal
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvolutionLoop, installEvolutionLoop } from "../src/evolve/loop.js";
import { registerEvolutionStatusTool } from "../src/tools/selfiterate.js";
import { ToolCatalog } from "../src/tools/catalog.js";
import { PPXAgent } from "../src/agent/index.js";

function mkFakeAgent({ episodes = [], llm = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-evo-"));
  const refineCalls = [];
  const agent = {
    root,
    dataDir: path.join(root, "data"),
    config: { agent: {} },
    llm,
    refine: async (opts) => { refineCalls.push(opts); return { distilled: refineCalls.length, lesson: "教训" + refineCalls.length }; },
    refineSkill: async () => ({ created: 0 }),
    experience: { count: () => 7 },
    skills: { list: () => [{ id: "a" }, { id: "b" }] },
    failures: { list: (n) => episodes.slice(0, n), stats: () => ({ total: episodes.length }) },
    playbook: { playbook: { bullets: [{}, {}, {}] } },
    scheduler: { jobs: [], add(j) { this.jobs.push(j); }, remove(id) { this.jobs = this.jobs.filter((x) => x.id !== id); } },
    _refineCalls: refineCalls,
  };
  return agent;
}

test("cycle: 三段编排 + journal 落账 (能力快照齐备)", { timeout: 30000 }, async () => {
  const agent = mkFakeAgent();
  const loop = new EvolutionLoop(agent, { min_interval_ms: 0 });
  const events = [];
  const rec = await loop.cycle({ onEvent: (t) => events.push(t) });
  assert.equal(rec.learn.refined >= 1, true, "学习段应提炼经验: " + JSON.stringify(rec.learn));
  assert.equal(rec.iterate.ran, false, "无 LLM 时代码迭代应跳过");
  assert.deepEqual(rec.capability, { experiences: 7, skills: 2, failureEpisodes: 0, playbookBullets: 3 });
  assert.ok(events.includes("evolution/learned"));
  // journal 落账且可读回
  const tail = loop.journalTail(5);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].capability.experiences, 7);
  assert.equal(typeof tail[0].durationMs, "number");
  fs.rmSync(agent.root, { recursive: true, force: true });
});

test("弱点驱动: 同类病历超阈值 → 定向 refine 先行", { timeout: 30000 }, async () => {
  const episodes = [
    { tool: "run_command", category: "timeout" },
    { tool: "run_command", category: "timeout" },
    { tool: "run_command", category: "timeout" },
    { tool: "read_file", category: "notfound" },
  ];
  const agent = mkFakeAgent({ episodes });
  const loop = new EvolutionLoop(agent, { min_interval_ms: 0, weakness_threshold: 3 });
  const rec = await loop.cycle();
  assert.ok(rec.learn.weaknessTargeted, "应命中弱点: " + JSON.stringify(rec.learn.weaknessTargeted));
  assert.equal(rec.learn.weaknessTargeted.tool, "run_command");
  assert.equal(rec.learn.weaknessTargeted.count, 3);
  // 弱点定向 + 常规 各一次 refine
  assert.equal(agent._refineCalls.length, 2);
  fs.rmSync(agent.root, { recursive: true, force: true });
});

test("单飞锁 + 最小间隔: 并发/密集 cycle 被拒", { timeout: 30000 }, async () => {
  const agent = mkFakeAgent();
  const loop = new EvolutionLoop(agent, { min_interval_ms: 60000 });
  const p1 = loop.cycle();
  const p2 = loop.cycle(); // 并发: 应被单飞锁拒
  const r2 = await p2;
  assert.equal(r2.ran, false);
  assert.match(r2.reason, /单飞锁/);
  await p1;
  const r3 = await loop.cycle(); // 间隔内: 应被间隔保护拒
  assert.equal(r3.ran, false);
  assert.match(r3.reason, /最小间隔/);
  fs.rmSync(agent.root, { recursive: true, force: true });
});

test("installEvolutionLoop: enabled=true 注册每日定时, 默认不注册但实例可用", { timeout: 30000 }, async () => {
  // 1) 默认: 不挂定时任务, agent._evolutionLoop 可用
  {
    const agent = mkFakeAgent();
    const loop = installEvolutionLoop(agent);
    assert.ok(agent._evolutionLoop, "实例应挂到 agent");
    assert.equal(agent.scheduler.jobs.some((j) => j.name === "evolution-loop"), false, "默认不注册定时");
    assert.ok(loop instanceof EvolutionLoop);
    fs.rmSync(agent.root, { recursive: true, force: true });
  }
  // 2) enabled: 注册每日 04:10 任务且 action 可调
  {
    const agent = mkFakeAgent();
    agent.config = { agent: { evolution_loop: { enabled: true, cron: "04:10" } } };
    installEvolutionLoop(agent);
    const job = agent.scheduler.jobs.find((j) => j.name === "evolution-loop");
    assert.ok(job, "应注册定时任务");
    assert.equal(job.cron, "04:10");
    assert.equal(typeof job.action, "function");
    fs.rmSync(agent.root, { recursive: true, force: true });
  }
});

test("真实 agent: evolution_status 工具输出快照/弱点/journal 三段", { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-evo-real-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), "{}");
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  try {
    const catalog = new ToolCatalog();
    registerEvolutionStatusTool(catalog, { agent });
    assert.ok(catalog.list().includes("evolution_status"));
    const out = await catalog.call("evolution_status", {}, {});
    assert.match(String(out), /能力快照/);
    assert.match(String(out), /最近 \d+ 轮进化/);
    assert.match(String(out), /经验条数/);
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
