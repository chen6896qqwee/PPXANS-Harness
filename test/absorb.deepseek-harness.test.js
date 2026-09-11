// test/absorb.deepseek-harness.test.js - deepseek-harness 源码吸收与技能整合验证
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SkillLoader } from "../src/skills/loader.js";
import { LLMClient } from "../src/llm/client.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("deepseek-harness 源码已内嵌到 .deps/deepseek-harness", () => {
  const dshRoot = path.join(ROOT, ".deps", "deepseek-harness");
  assert.ok(fs.existsSync(dshRoot), ".deps/deepseek-harness 目录存在");
  assert.ok(fs.existsSync(path.join(dshRoot, "apps/cli/src/bin.ts")), "dsh CLI 入口存在");
  assert.ok(fs.existsSync(path.join(dshRoot, "packages/skill/skill/README.md")), "dsh skill 包存在");
  assert.ok(fs.existsSync(path.join(dshRoot, "docs/architecture.md")), "dsh 架构文档存在");
});

test("dsh 底座路径已接入 LLM 客户端默认值", () => {
  const clientSrc = fs.readFileSync(path.join(ROOT, "src", "llm", "client.js"), "utf8");
  assert.ok(clientSrc.includes('".deps", "deepseek-harness"'), "DEFAULT_DSH_ROOT 指向内嵌 dsh");
  assert.ok(clientSrc.includes("PPX_DSH_ROOT"), "保留 PPX_DSH_ROOT 覆盖能力");
});

test("LLMClient 将相对 dsh_root 解析到 ppx 根目录", () => {
  const c = new LLMClient({ id: "dsh", backend: "deepseek", dsh_root: ".deps/deepseek-harness" });
  assert.ok(path.isAbsolute(c.dshRoot), "dshRoot 应为绝对路径");
  assert.ok(c.dshRoot.endsWith(path.join(".deps", "deepseek-harness")), "dshRoot 指向内嵌 dsh");
});

test("config 的 providers 首位 dsh 指向内嵌 dsh", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "ppx.json"), "utf8"));
  assert.equal(cfg.providers[0].id, "dsh");
  assert.equal(cfg.providers[0].backend, "deepseek");
  assert.equal(cfg.providers[0].dsh_root, ".deps/deepseek-harness");
});

test("dsh 底座项目技能目录也包含新增技能", () => {
  const base = path.join(ROOT, ".deps", "deepseek-harness", ".dsh", "skills");
  for (const name of ["agent-professional-training", "cupid-lover-comms"]) {
    assert.ok(fs.existsSync(path.join(base, name, "SKILL.md")), `${name} 在 dsh .dsh/skills 中存在`);
  }
});

test("新增 Agent 专业训练技能可被 SkillLoader 发现并读取", () => {
  const l = new SkillLoader(path.join(ROOT, "skills"));
  const s = l.get("agent-professional-training");
  assert.ok(s, "agent-professional-training 可发现");
  assert.ok(s.description && s.description.length > 20, "description 已解析");
  const content = l.read("agent-professional-training");
  assert.ok(content.includes("Agent 专业训练规程"), "SKILL.md 内容完整");
});

test("新增丘比特沟通技能可被 SkillLoader 发现并读取", () => {
  const l = new SkillLoader(path.join(ROOT, "skills"));
  const s = l.get("cupid-lover-comms");
  assert.ok(s, "cupid-lover-comms 可发现");
  assert.ok(s.description && s.description.length > 20, "description 已解析");
  const content = l.read("cupid-lover-comms");
  assert.ok(content.includes("丘比特"), "SKILL.md 内容完整");
});
