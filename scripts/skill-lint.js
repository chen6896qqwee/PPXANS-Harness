#!/usr/bin/env node
// scripts/skill-lint.js - Skill 质量门槛 CLI (零 LLM, 可接 CI)
// 依据《Skill 蓝皮书 2026》: 元数据与描述质量是 skill 分发的第一瓶颈。
// 用法:
//   node scripts/skill-lint.js             # 报告全部技能, error > 0 时退出码 1
//   node scripts/skill-lint.js --strict    # warning 也算失败 (发版前门禁)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintSkillDir } from "../src/skills/lint.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const { results, pass, warn, fail, error } = lintSkillDir(path.join(ROOT, "skills"));

console.log("皮皮虾 Skill 质量检查 | 门槛依据: Skill 蓝皮书 2026 (元数据=分发瓶颈)\n");
if (error) {
  console.error("✗", error);
  process.exit(1);
}
for (const r of results) {
  const flag = !r.ok ? "✗" : r.warnings.length ? "△" : "✓";
  console.log(`${flag} ${r.name}`);
  for (const e of r.errors) console.log(`    [${e.id}] ${e.msg}`);
  for (const w of r.warnings) console.log(`    [${w.id}] ${w.msg}`);
}
console.log(`\n=== Skill 检查: ${pass} 全过 / ${warn} 有告警 / ${fail} 不合格 ===`);
const bad = strict ? pass + warn : pass + warn + fail;
process.exit((strict ? warn : fail) > 0 ? 1 : 0);
