// test/skill-sections.test.js - SKILL.md 章节解析 (反合理化/验证门禁)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseFrontmatter, parseSections, SkillLoader } from "../src/skills/loader.js";

test("parseSections 解析 ## 章节", () => {
  const md = `# 标题\n\n## 流程\n1. 做 A\n2. 做 B\n\n## 反合理化\n- 借口\n\n## 验证\n- [ ] 证据\n`;
  const s = parseSections(md);
  assert.ok(s["流程"].includes("做 A"));
  assert.ok(s["反合理化"].includes("借口"));
  assert.ok(s["验证"].includes("证据"));
  assert.equal(s["不存在的章节"], undefined);
});

test("SkillLoader.readSection 按需读章节", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-skill-"));
  const skillDir = path.join(dir, "demo");
  fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, "SKILL.md"),
    "---\nname: demo\ndescription: 示例\n---\n\n# demo\n\n## 流程\n做一件事\n\n## 反合理化\n- 别偷懒\n");
  const loader = new SkillLoader(dir);
  assert.equal(loader.readSection("demo", "反合理化"), "- 别偷懒");
  assert.equal(loader.readSection("demo", "流程"), "做一件事");
  assert.equal(loader.readSection("demo", "不存在"), null);
  assert.equal(loader.readSection("missing-skill", "流程"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
