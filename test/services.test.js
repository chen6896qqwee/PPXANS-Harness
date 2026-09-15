// test/services.test.js - 记忆/学习服务独立装配测试 (重构第二刀, 2026-09-14)
// 目的: 验证 MemoryService / LearningService 可不经 PPXAgent 装配直接构造使用
//       (依赖注入完备性), 以及关键降级分支 (无 LLM / 轨迹不足) 行为。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../src/services/memory-service.js";
import { LearningService } from "../src/services/learning-service.js";
import { EventTracer } from "../src/core/trace.js";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-svc-")); }

// 最小可注入对象集 (不依赖真实 agent)
function minimalDeps(dir) {
  const facts = {
    query: () => [],
    list: () => [],
    embedder: null,
    queryMulti: () => [],
  };
  const scenes = { findByFactId: () => null, assign: () => {} };
  const personaStore = {
    userPersona: () => "", agentPersona: () => "",
    buildUserPersona: () => {}, buildAgentPersona: () => {},
  };
  const experience = { lessons: [], learn: () => {} };
  const lifecycle = { evolve: () => {} };
  const tracer = new EventTracer(dir);
  const traces = { read: () => [] };
  const skills = null;
  const auditor = { gate: async () => ({ committed: false, reason: "no-auditor" }), record: () => {} };
  return { facts, scenes, personaStore, experience, lifecycle, tracer, traces, skills, auditor };
}

test("MemoryService: 独立装配 + 无 LLM 时 extractMemory 返回 []", async () => {
  const dir = tmpDir();
  const deps = minimalDeps(dir);
  const svc = new MemoryService({ getLlm: () => null, ...deps });
  const out = await svc.extractMemory("用户喜欢红色", "好的");
  assert.deepEqual(out, [], "无 LLM 应返回空");
  const q = await svc.query("止损规则", { limit: 3 });
  assert.deepEqual(q, [], "无 LLM 查询退化为空结果");
});

test("MemoryService: refreshPersona 跨天只刷新一次", () => {
  const dir = tmpDir();
  const deps = minimalDeps(dir);
  let built = 0;
  const svc = new MemoryService({
    getLlm: () => null, ...deps,
    personaStore: {
      userPersona: () => "", agentPersona: () => "",
      buildUserPersona: () => { built++; }, buildAgentPersona: () => {},
    },
  });
  svc.refreshPersona();
  svc.refreshPersona(); // 同一天第二次应跳过
  assert.equal(built, 1, "同一天只 build 一次");
});

test("MemoryService: afterTurn 聚合调用不抛错 (空事实/场景)", () => {
  const dir = tmpDir();
  const deps = minimalDeps(dir);
  const svc = new MemoryService({ getLlm: () => null, ...deps });
  assert.doesNotThrow(() => svc.afterTurn("你好", "在的兄弟"));
});

test("MemoryService: learnFromTurn 识别用户主动分享指令", () => {
  const dir = tmpDir();
  const deps = minimalDeps(dir);
  let learned = null;
  const svc = new MemoryService({
    getLlm: () => null, ...deps,
    experience: { lessons: [], learn: (e) => { learned = e; } },
  });
  svc.learnFromTurn("经验交给皮皮虾：xxx命令很危险", "记住了");
  assert.ok(learned, "应触发经验学习");
  assert.equal(learned.tags[0], "user-shared");
  // 非指令不触发
  svc.learnFromTurn("普通对话", "嗯");
  assert.equal(learned.lesson, "xxx命令很危险", "普通对话不应覆盖经验");
});

test("LearningService: 独立装配 + 无 LLM 时 refine/refineSkill 返回降级", async () => {
  const dir = tmpDir();
  const deps = minimalDeps(dir);
  const svc = new LearningService({
    getLlm: () => null, ...deps,
    toolNames: () => [],
    runTool: async () => "[工具] ok",
  });
  const r = await svc.refine({ limit: 10 });
  assert.equal(r.reason, "无 LLM");
  const s = await svc.refineSkill({ limit: 10, minFreq: 2 });
  assert.equal(s.reason, "无 LLM");
  const u = await svc.upgradeSkill("x", { minUses: 3 });
  assert.equal(u.reason, "无 LLM");
});

test("LearningService: 有 LLM 但轨迹不足时降级", async () => {
  const dir = tmpDir();
  const deps = minimalDeps(dir);
  const fakeLlm = {
    health: async () => true,
    chat: async () => ({ content: "nothing" }),
  };
  const svc = new LearningService({
    getLlm: () => fakeLlm, ...deps,
    toolNames: () => [],
    runTool: async () => "[工具] ok",
  });
  const r = await svc.refine({ limit: 10 });
  assert.equal(r.reason, "失败轨迹不足");
  const s = await svc.refineSkill({ limit: 10, minFreq: 2 });
  assert.equal(s.reason, "成功轨迹不足");
});
