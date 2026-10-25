// test/fork.test.js - P2⑦: 会话 fork 基线 (HanaAgent fork baseline 思想, 自研)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactStore } from "../src/memory/fact-store.js";
import { PersonaStore } from "../src/memory/l3.js";
import { Experience } from "../src/memory/experience.js";
import { exportMemorySnapshot, mergeSnapshotBack, hasSnapshot } from "../src/memory/fork.js";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-fork-")); }

// 造一个最小 agent —— 用**真实** PersonaStore / Experience 实例, 不用手写桩。
// 修复 (2026-09-17): 原桩写成 { personaStore: { read } , experience: { list } },
//   但真实 PersonaStore 并没有 read() —— 桩与真实接口漂移, 导致 fork 快照静默降级
//   (persona.md / experience.md 从未生成) 长期没被测出来。
//   改为真实实例后, 接口再漂移会直接测失败。
function makeAgentStub(dir) {
  const dataDir = path.join(dir, "data");
  const facts = new FactStore(dataDir, {});
  facts.add("用户喜欢量化投资", { source: "manual" });
  facts.add("止损线 5%", { source: "manual" });
  facts.add("Python 项目经验丰富", { source: "manual" });

  const personaStore = new PersonaStore(dataDir);
  personaStore.buildUserPersona(facts.list(), { force: true });
  personaStore.buildAgentPersona(
    [{ lesson: "失败先查审计链" }, { lesson: "验证优先于声称" }],
    { force: true }
  );

  const experience = new Experience(dataDir);
  experience.learn({ task: "排查失败", outcome: "定位到审计链", lesson: "失败先查审计链" });
  experience.learn({ task: "交付前", outcome: "先跑测试", lesson: "验证优先于声称" });

  return { dataDir: dir, facts, personaStore, experience };
}

test("fork: 导出记忆快照到子 dataDir", () => {
  const parent = tmpDir();
  const child = tmpDir();
  const agent = makeAgentStub(parent);
  const { wrote, path: snapPath } = exportMemorySnapshot({ agent, toDataDir: child, factsLimit: 10, experienceLimit: 10 });
  assert.ok(wrote.facts >= 3, "导出事实");
  assert.equal(wrote.persona, true, "导出画像");
  assert.equal(wrote.experience, 2, "导出经验");
  assert.ok(fs.existsSync(path.join(snapPath, "facts.md")));
  assert.ok(fs.existsSync(path.join(snapPath, "persona.md")));
  assert.ok(fs.existsSync(path.join(snapPath, "experience.md")));
  assert.equal(hasSnapshot(child), true, "子目录带快照标记");
});

test("fork: 快照文件内容可读", () => {
  const parent = tmpDir();
  const child = tmpDir();
  const agent = makeAgentStub(parent);
  exportMemorySnapshot({ agent, toDataDir: child });
  const text = fs.readFileSync(path.join(child, "memory", "snapshot", "facts.md"), "utf8");
  assert.ok(text.includes("量化投资"), "事实内容在快照里");
});

// 回归守卫 (2026-09-17): persona / experience 快照必须带**真实内容**,
// 而不只是"文件存在" —— 原缺陷正是文件永不生成却无人察觉。
test("fork: persona 与 experience 快照带真实内容 (接口同步回归)", () => {
  const parent = tmpDir();
  const child = tmpDir();
  const agent = makeAgentStub(parent);
  const { wrote } = exportMemorySnapshot({ agent, toDataDir: child, factsLimit: 10, experienceLimit: 10 });

  assert.equal(wrote.persona, true, "画像已导出");
  assert.equal(wrote.experience, 2, "经验已导出");

  const persona = fs.readFileSync(path.join(child, "memory", "snapshot", "persona.md"), "utf8");
  assert.ok(persona.includes("量化投资"), "persona.md 含真实用户画像内容");
  assert.ok(persona.includes("失败先查审计链"), "persona.md 含真实 agent 人格内容");

  const exp = fs.readFileSync(path.join(child, "memory", "snapshot", "experience.md"), "utf8");
  assert.ok(exp.includes("失败先查审计链"), "experience.md 含真实经验内容");

  // 接口同步守卫: fork 依赖的方法必须在真实类上存在
  assert.equal(typeof agent.personaStore.userPersona, "function", "PersonaStore.userPersona 存在");
  assert.equal(typeof agent.experience.list, "function", "Experience.list 存在");
});

test("fork: merge 回主记忆 (去重)", () => {
  const parent = tmpDir();
  const child = tmpDir();
  const agent = makeAgentStub(parent);
  // 子 agent 学到新事实, 写进快照后 merge 回
  const snapDir = path.join(child, "memory", "snapshot");
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, "facts.md"), `# L1 事实快照\n- [100] 用户喜欢量化投资\n- [100] 新学到的经验: 市场回调先看情绪\n`, "utf8");

  const { merged, skipped } = mergeSnapshotBack({ agent, fromDataDir: child });
  assert.equal(skipped, 1, "重复事实跳过");
  assert.equal(merged, 1, "新事实合并");
  // 验证新事实进了主记忆
  const hit = agent.facts.query("市场回调先看情绪", { limit: 1 });
  assert.ok(hit.length > 0, "新事实可检索");
});

test("fork: dryRun 不写入", () => {
  const parent = tmpDir();
  const child = tmpDir();
  const agent = makeAgentStub(parent);
  const snapDir = path.join(child, "memory", "snapshot");
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, "facts.md"), `# L1\n- [100] 全新事实 ABC\n`, "utf8");
  const { merged } = mergeSnapshotBack({ agent, fromDataDir: child, dryRun: true });
  assert.equal(merged, 1, "dryRun 也计数");
  const hit = agent.facts.query("全新事实 ABC", { limit: 1 });
  assert.equal(hit.length, 0, "dryRun 不写入");
});

test("fork: 无快照时不 merge", () => {
  const parent = tmpDir();
  const child = tmpDir(); // 无快照
  const agent = makeAgentStub(parent);
  const { merged, skipped } = mergeSnapshotBack({ agent, fromDataDir: child });
  assert.equal(merged, 0);
  assert.equal(skipped, 0);
  assert.equal(hasSnapshot(child), false);
});

test("fork: 无 agent 时不导出", () => {
  const child = tmpDir();
  const { wrote, path: snapPath } = exportMemorySnapshot({ agent: null, toDataDir: child });
  assert.equal(Object.keys(wrote).length, 0);
  assert.equal(snapPath, null);
});
