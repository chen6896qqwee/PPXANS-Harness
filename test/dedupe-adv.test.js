// test/dedupe-adv.test.js - 高级去重: 经验库内容去重 + 记忆语义去重 (bigram Jaccard)
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { PPXAgent } from "../src/agent/index.js";
import { FactStore } from "../src/memory/fact-store.js";

function tmpRoot(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-dd-${n}-`)); }

// ---- 经验库内容去重 ----
test("Experience.learn: 相同 lesson 重复学命中加分而非新增", () => {
  const a = new PPXAgent({ root: tmpRoot("exp") });
  const r1 = a.experience.learn({ task: "t1", lesson: "测试经验：多进程要加锁" });
  const r2 = a.experience.learn({ task: "t2", lesson: "测试经验：多进程要加锁" }); // 相同 lesson
  assert.equal(a.experience.lessons.length, 1, "相同 lesson 只存 1 条");
  assert.equal(r1.id, r2.id, "返回同一条 (命中加分)");
  assert.equal(r2.uses, 1, "uses 累加");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

test("Experience.learn: 不同 lesson 正常新增", () => {
  const a = new PPXAgent({ root: tmpRoot("exp2") });
  a.experience.learn({ lesson: "经验A：使用临时目录隔离测试" });
  a.experience.learn({ lesson: "经验B：工具超时要设上限" });
  assert.equal(a.experience.lessons.length, 2, "不同 lesson 各存 1 条");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

// ---- 经验同义合并 (v1.0.7, 真实生产变体校准) ----
test("Experience.learn: 同义改写变体合并而非新增", () => {
  const a = new PPXAgent({ root: tmpRoot("exp3") });
  a.experience.learn({ lesson: "零依赖比第三方依赖更稳" });
  const r = a.experience.learn({ lesson: "零依赖最稳" }); // 真实生产同义变体 overlap 0.5
  assert.equal(a.experience.lessons.length, 1, "同义变体只存 1 条");
  assert.equal(r.uses, 1, "合并时 uses 累加");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

test("Experience.learn: 相关但不同的经验不误合并", () => {
  const a = new PPXAgent({ root: tmpRoot("exp4") });
  a.experience.learn({ lesson: "工具超时要设上限" });
  a.experience.learn({ lesson: "设置超时上限防止命令卡死" }); // overlap 0.286 < 0.5
  assert.equal(a.experience.lessons.length, 2, "相关但不同不合并");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

// ---- 记忆语义去重 (bigram Jaccard) ----
test("FactStore._jaccard: 同义变体相似度高, 无关内容相似度低", () => {
  const a = new PPXAgent({ root: tmpRoot("jac") });
  const sim = a.facts._jaccard(
    "一个完整的任务必须包含三件套：目标（干什么）、涉及的资源（文件、服务、数据）和验收标准（做完什么样算完）",
    "一个完整的任务必须包含目标（干什么）、涉及的资源（文件、服务、数据）和验收标准（做完什么样算完）这三件套"
  );
  assert.ok(sim > 0.7, `同义变体相似度应高, 实际 ${sim}`);
  const low = a.facts._jaccard("今天天气不错", "股票策略下周建仓");
  assert.ok(low < 0.3, `无关内容相似度应低, 实际 ${low}`);
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

test("FactStore.findSimilar: 语义相似的现有事实可被找到", () => {
  const a = new PPXAgent({ root: tmpRoot("fs") });
  a.facts.add("一个完整的任务必须包含三件套：目标（干什么）、涉及的资源（文件、服务、数据）和验收标准（做完什么样算完）", { source: "manual" });
  // 同义变体 (三件套位置不同), 真实相似度 ~0.9
  const found = a.facts.findSimilar("一个完整的任务必须包含目标（干什么）、涉及的资源（文件、服务、数据）和验收标准（做完什么样算完）这三件套");
  assert.ok(found, "应找到语义相似的事实");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

test("FactStore.add(similarThreshold): 同义变体命中加分而非新增", () => {
  const a = new PPXAgent({ root: tmpRoot("addsim") });
  a.facts.add("一个完整的任务必须包含三件套：目标（干什么）、涉及的资源（文件、服务、数据）和验收标准（做完什么样算完）", { source: "manual" });
  const before = a.facts.count();
  a.facts.add("一个完整的任务必须包含目标（干什么）、涉及的资源（文件、服务、数据）和验收标准（做完什么样算完）这三件套", { source: "extract", similarThreshold: 0.6 });
  assert.equal(a.facts.count(), before, "同义变体不新增");
  const all = a.facts.list();
  assert.equal(all.length, 1, "仍只有 1 条");
  assert.ok(all[0].hits >= 1, "hits 加分");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

test("FactStore.add(similarThreshold=0): 不启用语义去重 (向后兼容)", () => {
  const a = new PPXAgent({ root: tmpRoot("addnosim") });
  a.facts.add("任务三件套：目标、资源、验收标准", { source: "manual" });
  const before = a.facts.count();
  // 默认不加 similarThreshold -> 字面不同则新增
  a.facts.add("任务三件套：目标、资源、验收标准，一条都不能少", { source: "manual" });
  assert.equal(a.facts.count(), before + 1, "默认不语义去重, 新增");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

// ---- overlap 语义去重 (词序变化大的松散变体) ----
test("FactStore._overlap: 词序变化的同义改写 overlap 高于 Jaccard", () => {
  const a = new PPXAgent({ root: tmpRoot("ovl") });
  // 真实生产数据中的同义变体 (词序措辞变化大, Jaccard 仅 0.58)
  const A = "用户在提出任务时，需要提供详细的任务内容，而不是仅仅使用编号，以提高处理效率。";
  const B = "用户提出的任务时，需要提供具体的任务内容，而不是仅仅使用编号，以提高效率。";
  const j = a.facts._jaccard(A, B);
  const o = a.facts._overlap(A, B);
  assert.ok(o > j, `overlap(${o.toFixed(2)}) 应高于 jaccard(${j.toFixed(2)}) 对词序松散变体`);
  assert.ok(o > 0.65, "overlap 应能捕获松散同义改写");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

test("FactStore.add(similarThreshold): 松散变体经 overlap 兜底命中加分", () => {
  const a = new PPXAgent({ root: tmpRoot("ovladd") });
  a.facts.add("用户在提出任务时，需要提供详细的任务内容，而不是仅仅使用编号，以提高处理效率。", { source: "manual" });
  const before = a.facts.count();
  // 词序变化大, Jaccard 0.58 <0.6, 但 overlap 0.78 >=0.6, 应被兜底命中
  a.facts.add("用户提出的任务时，需要提供具体的任务内容，而不是仅仅使用编号，以提高效率。", { source: "extract", similarThreshold: 0.6 });
  assert.equal(a.facts.count(), before, "松散变体不新增");
  const all = a.facts.list();
  assert.ok(all[0].hits >= 1, "hits 加分");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

test("FactStore.findSimilar(method=overlap): 词序变化变体可被找到", () => {
  const a = new PPXAgent({ root: tmpRoot("ovlfind") });
  a.facts.add("用户在提出任务时，需要提供详细的任务内容，而不是仅仅使用编号，以提高处理效率。", { source: "manual" });
  const found = a.facts.findSimilar("用户提出的任务时，需要提供具体的任务内容，而不是仅仅使用编号，以提高效率。", { threshold: 0.65, method: "overlap" });
  assert.ok(found, "overlap 方法应找到词序变化的相似事实");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

// ---- L3 画像展示前去重 ----
test("L3 buildAgentPersona: 重复经验在画像中只展示一次", () => {
  const a = new PPXAgent({ root: tmpRoot("l3dd") });
  a.experience.learn({ lesson: "零依赖比第三方依赖更稳" });
  a.experience.learn({ lesson: "零依赖比第三方依赖更稳" });
  a.experience.learn({ lesson: "零依赖比第三方依赖更稳" });
  const persona = a.personaStore.buildAgentPersona(a.experience.lessons, { force: true });
  const count = (persona.match(/零依赖比第三方依赖更稳/g) || []).length;
  assert.equal(count, 1, "重复经验只展示一次");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

test("L3 buildUserPersona: 完全重复记忆在画像中去重", () => {
  const a = new PPXAgent({ root: tmpRoot("l3ud") });
  a.facts.add("任务必须包含目标、资源、验收标准三件套", { source: "extract" });
  a.facts.add("任务必须包含目标、资源、验收标准三件套", { source: "extract" });
  const persona = a.personaStore.buildUserPersona(a.facts.list(), { force: true });
  // 精确去重: 完全相同的重复在画像中只出现一次
  const count = (persona.match(/任务必须包含目标、资源、验收标准三件套/g) || []).length;
  assert.equal(count, 1, "完全重复记忆只展示一次");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

// ---- FactStore 工具函数直接可用 ----
test("FactStore 导出 _jaccard / findSimilar 纯函数可测", () => {
  const a = new PPXAgent({ root: tmpRoot("util") });
  assert.equal(typeof a.facts._jaccard, "function");
  assert.equal(typeof a.facts.findSimilar, "function");
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

// ---- 并发写保护 (withFileLock) ----
test("FactStore.add: 多进程并发写不丢事实 (锁内读-改-写)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-factlock-"));
  const target = path.join(dir, "memory");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "facts.json"), "[]", "utf8");
  // 启动 3 个并发子进程各写 5 条不同事实
  const procs = [];
  const storeUrl = "file://" + path.join(process.cwd(), "src/memory/fact-store.js").replace(/\\/g, "/");
  for (let p = 0; p < 3; p++) {
    const code = `
      import { FactStore } from "${storeUrl}";
      const s = new FactStore("${dir.replace(/\\/g, "/")}");
      for (let i = 0; i < 5; i++) s.add("并发进程${p}事实" + i + " 独特内容", { source: "test" });
    `;
    procs.push(spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 15000 }));
  }
  for (const pr of procs) assert.equal(pr.status, 0, "子进程应正常退出: " + (pr.stderr || "").slice(0, 100));
  const final = JSON.parse(fs.readFileSync(path.join(target, "facts.json"), "utf8"));
  assert.equal(final.length, 15, "15 条并发写入全保留, 无覆盖丢失 (实际 " + final.length + ")");
  fs.rmSync(dir, { recursive: true, force: true });
});
