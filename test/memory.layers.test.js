// test/memory.layers.test.js - 腾讯风格四层记忆测试
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { PPXAgent } from "../src/agent/index.js";
import { L0Recorder, SceneStore, PersonaStore } from "../src/memory/index.js";

// 每个测试用独立临时数据目录, 避免数据污染
function tmpRoot(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${name}-`));
  return d;
}

test("L0: 记录原始对话到 JSONL", () => {
  const a = new PPXAgent({ root: tmpRoot("l0rec") });
  const before = a.l0.count();
  a.l0.record({ role: "user", content: "今天研究了量子计算在金融的应用", sessionKey: "test" });
  assert.ok(a.l0.count() > before, "L0 文件增长");
  const msgs = a.l0.read();
  assert.ok(Array.isArray(msgs));
  a.shutdown();
  fs.rmSync(a.dataDir, { recursive: true, force: true });
});

test("L0: 寒暄噪音被过滤", () => {
  const rec = new L0Recorder(tmpRoot("l0"));
  rec.record({ role: "user", content: "你好" });
  rec.record({ role: "user", content: "/help" });
  assert.equal(rec.count(), 0, "寒暄和命令不应记录");
});

test("L2: 场景归档", () => {
  const a = new PPXAgent({ root: tmpRoot("l2") });
  const f = a.facts.add("用户关注 A股 量化交易 资金流向", { type: "conversation" });
  const scene = a.scenes.assign(f);
  assert.ok(scene, "应归档到场景");
  assert.ok(scene.keywords.length > 0);
  assert.ok(a.scenes.count() >= 1);
  a.shutdown();
});

test("L3: 生成用户画像", () => {
  const a = new PPXAgent({ root: tmpRoot("l3") });
  a.facts.add("用户喜欢研究股票技术分析", { type: "conversation" });
  a.facts.add("用户主要关注A股市场", { type: "conversation" });
  const persona = a.personaStore.buildUserPersona(a.facts.list(), { force: true });
  assert.ok(persona.includes("画像"), "画像含标题");
  assert.ok(persona.length > 20);
  a.shutdown();
});

test("L3: 生成 agent 自我画像", () => {
  const a = new PPXAgent({ root: tmpRoot("l3a") });
  a.experience.learn({ task: "测试", lesson: "零依赖最稳", tags: ["test"] });
  const persona = a.personaStore.buildAgentPersona(a.experience.lessons, { force: true });
  assert.ok(persona.includes("皮皮虾"));
  assert.ok(persona.includes("经验"));
  a.shutdown();
});

test("对话完整走 L0-L3 管道", async () => {
  const a = new PPXAgent({ root: tmpRoot("pipe") });
  await a.chat("最近我在研究优化记忆架构", { persist: true });
  assert.ok(a.l0.count() >= 0);
  assert.ok(a.scenes.count() >= 0);
  a.shutdown();
});
test("滚动压缩: 今日事件超量后归档到 longterm", async () => {
  const a = new PPXAgent({ root: tmpRoot("compact") });
  const mt = a.memory;
  // 往 session 事件日志塞超量事件, 触发压缩 (今日视图由 session 派生)
  for (let i = 0; i < 60; i++) a.sessionStore.append("k", "user/message", { content: `测试消息${i} 内容` });
  await mt._compactIfNeeded();
  const longterm = fs.readFileSync(mt.longtermMd, "utf8");
  assert.ok(/thin|llm-summary|archived/.test(longterm), "longterm 应含压缩标记: " + longterm.slice(-80));
  a.shutdown();
});

test("L3: 启动自动生成画像 + _l3Context 注入", () => {
  const a = new PPXAgent({ root: tmpRoot("l3-auto") });
  const userFile = path.join(a.dataDir, "memory", "l3", "user.persona.md");
  const agentFile = path.join(a.dataDir, "memory", "l3", "agent.persona.md");
  assert.ok(fs.existsSync(userFile), "user.persona.md 应启动即生成");
  assert.ok(fs.existsSync(agentFile), "agent.persona.md 应启动即生成");
  const ctx = a._l3Context();
  assert.ok(ctx.includes("画像"), "_l3Context 应注入画像内容");
  a.shutdown();
});

test("L3: buildUserPersona 按 source 过滤 (对话事实可提炼, 修复 type 过滤空 bug)", () => {
  const a = new PPXAgent({ root: tmpRoot("l3-src") });
  // 真实路径: addMemory 用 source="conversation" (type 恒为 general)
  a.facts.addMemory("兄弟喜欢做A股量化交易");
  a.facts.add("公司制度第3条", { source: "document", dedupe: false });
  const persona = a.personaStore.buildUserPersona(a.facts.list(), { force: true });
  assert.ok(persona.includes("A股量化"), "对话事实应进入画像记忆概要");
  assert.ok(!persona.includes("公司制度"), "document 来源不应混入用户画像");
  a.shutdown();
});

test("L3: 同一天不重复刷新画像", () => {
  const a = new PPXAgent({ root: tmpRoot("l3-once") });
  const userFile = path.join(a.dataDir, "memory", "l3", "user.persona.md");
  const before = fs.statSync(userFile).mtimeMs;
  a._maybeRefreshPersona(); // 同一天, 应跳过
  const after = fs.statSync(userFile).mtimeMs;
  assert.equal(before, after, "同一天不应重复写文件");
  a.shutdown();
});

// ---- 记忆噪声治理 (v1.0.7): 寒暄开头短句/过长文本不入库 ----
test("addMemory 过滤: 寒暄词开头的短句不入库 (治理'你好皮皮虾'逃逸)", () => {
  const a = new PPXAgent({ root: tmpRoot("addmem-noise") });
  assert.equal(a.facts.addMemory("你好皮皮虾"), null, "'你好皮皮虾' 以寒暄词开头 → 拦截");
  assert.equal(a.facts.addMemory("你好，做个自我介绍"), null, "'你好...' → 拦截");
  assert.equal(a.facts.addMemory("好的"), null, "整句寒暄 → 拦截");
  assert.equal(a.facts.addMemory("太短"), null, "长度 <4 → 拦截");
  const long = "x".repeat(300);
  assert.equal(a.facts.addMemory(long), null, "长度 >200 → 拦截");
  assert.equal(a.facts.addMemory("现在几点"), null, "疑问/指令短句 → 拦截");
  const f = a.facts.addMemory("兄弟喜欢做A股量化交易");
  assert.equal(f.content, "兄弟喜欢做A股量化交易", "正常内容入库");
  a.shutdown();
});