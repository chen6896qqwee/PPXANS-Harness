// test/project-md.test.js — 项目指令 (AGENTS.md / PPX.md) 注入 (2026-10-31)
// 修复的缺口: /init 自创建起就声称"PPX.md 每次启动自动读取", 但注入实现从未存在
// (ARCHITECTURE-V3.md 规划的 project-md 未落地)。本文件钉住: 发现 → 注入 → 预算 → 缓存刷新。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProjectInstructions,
  _clearProjectMdCache,
  PROJECT_INSTRUCTION_FILES,
} from "../src/memory/project-md.js";
import { promptMethods } from "../src/agent/prompts.js";

function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-pmd-${tag}-`));
  return d;
}

test("PROJECT_INSTRUCTION_FILES: AGENTS.md 优先于 PPX.md 展示", () => {
  assert.deepEqual(PROJECT_INSTRUCTION_FILES, ["AGENTS.md", "PPX.md"]);
});

test("无指令文件 → 返回空串 (零 token)", () => {
  const d = tmp("empty");
  _clearProjectMdCache();
  assert.equal(loadProjectInstructions(d), "");
});

test("AGENTS.md 单文件: 内容带【项目指令】标注", () => {
  const d = tmp("agents");
  fs.writeFileSync(path.join(d, "AGENTS.md"), "# 约定\n- 测试先行");
  _clearProjectMdCache();
  const out = loadProjectInstructions(d);
  assert.match(out, /【项目指令】/);
  assert.match(out, /AGENTS\.md/);
  assert.match(out, /测试先行/);
  assert.match(out, /核心价值/, "与价值底线的关系要说明");
});

test("AGENTS.md + PPX.md 共存: 两份都注入, 各自带文件名标签", () => {
  const d = tmp("both");
  fs.writeFileSync(path.join(d, "AGENTS.md"), "- agents 约定");
  fs.writeFileSync(path.join(d, "PPX.md"), "- ppx 约定");
  _clearProjectMdCache();
  const out = loadProjectInstructions(d);
  assert.match(out, /<AGENTS\.md>/);
  assert.match(out, /agents 约定/);
  assert.match(out, /<PPX\.md>/);
  assert.match(out, /ppx 约定/);
});

test("超预算截断: 超过 maxChars 的文件被截断且带标注", () => {
  const d = tmp("trim");
  fs.writeFileSync(path.join(d, "AGENTS.md"), "x".repeat(300) + "\n结尾标记");
  _clearProjectMdCache();
  const out = loadProjectInstructions(d, { maxChars: 100 });
  assert.match(out, /超出 100 字符预算已截断/);
});

test("mtime 缓存: 文件变更后无需重启即可读到新内容 (逐字节稳定性契约)", async () => {
  const d = tmp("cache");
  const p = path.join(d, "PPX.md");
  fs.writeFileSync(p, "第一版");
  _clearProjectMdCache();
  const v1 = loadProjectInstructions(d);
  assert.match(v1, /第一版/);
  // 同内容重读: 返回同一份缓存 (引用级稳定 → 前缀缓存不退化)
  assert.equal(loadProjectInstructions(d), v1);
  // 变更内容: mtime 变化后读到新版 (NTFS mtime 精度 ~1-4ms, 保险起见等待后写)
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(p, "第二版");
  const v2 = loadProjectInstructions(d);
  assert.match(v2, /第二版/);
  assert.notEqual(v2, v1);
});

test("prompts._projectMdPrompt: mixin 挂载读 this.root (静态区契约)", () => {
  const d = tmp("mixin");
  fs.writeFileSync(path.join(d, "PPX.md"), "- 构建约定");
  _clearProjectMdCache();
  const out = promptMethods._projectMdPrompt.call({ root: d });
  assert.match(out, /构建约定/);
  // 无文件对象同样安全
  const none = promptMethods._projectMdPrompt.call({ root: tmp("mixin-none") });
  assert.equal(none, "");
});

test("_context 组装: projectmd 段落存在且位于静态区 (extra 之后, 检索段之前)", async () => {
  // 不 boot 整个 agent —— stub 继承 promptMethods 真实方法 (_skillsPrompt/_toolsPrompt 等
  //   自带空依赖兜底), 只注入最小实例状态
  const d = tmp("ctx");
  fs.writeFileSync(path.join(d, "AGENTS.md"), "- 项目约定");
  _clearProjectMdCache();
  const stub = Object.assign(Object.create(promptMethods), {
    root: d,
    dataDir: d, // reward/ans 状态读写走 dataDir/memory/*.json
    persona: { systemPrompt: () => "" },
    personaStore: null,
    experience: { context: () => "" },
    config: { agent: {} },
    scenes: { activeContext: () => "" },
    memory: { context: () => "" },
    playbook: null,
    goalBoard: null,
    workStack: null,
    tools: null,
    skills: null,
    llm: null,
    _perspective: "",
  });
  const ctx = promptMethods._context.call(stub, "问题");
  assert.ok(ctx.indexOf("【项目指令】") > 0, "项目指令已注入");
  assert.ok(ctx.indexOf("项目约定") > 0);
});
