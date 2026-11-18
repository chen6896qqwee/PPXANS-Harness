#!/usr/bin/env node
// scripts/test-map.js — 测试地图生成器 (模块 ↔ 测试 的反向索引)
//
// 动机: 测试文件按修复批次命名 (fixes-2026-09-xx / *r13*), 从文件名看不出覆盖关系。
//   本脚本从测试文件的 import 反推, 回答两件事: 改某模块该跑哪些测试; 哪些测试不 import src。
//   docs/TEST-MAP.md 由本脚本生成 (`node scripts/test-map.js --md > docs/TEST-MAP.md`)。
//
// 用法:
//   node scripts/test-map.js                 总览 (文件数/模块数/覆盖率/孤儿测试)
//   node scripts/test-map.js permissions     查包含关键字的模块 → 覆盖它的测试
//   node scripts/test-map.js --uncovered     没有被任何测试直接 import 的模块
//   node scripts/test-map.js --md            输出完整 Markdown (供 TEST-MAP.md)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const IMPORT_RE = /(?:from\s*|import\s*\(\s*)["'](\.\.\/src\/[^"']+)["']/g;

const testFiles = walk(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.js"));
const srcFiles = walk(path.join(ROOT, "src")).filter((f) => f.endsWith(".js"));

const moduleToTests = new Map();
const testToModules = new Map();
for (const tf of testFiles) {
  const text = fs.readFileSync(tf, "utf8");
  const mods = new Set();
  for (const m of text.matchAll(IMPORT_RE)) {
    const abs = path.resolve(path.dirname(tf), m[1]);
    if (!fs.existsSync(abs)) continue; // 动态/条件路径不存在就不算
    mods.add(rel(abs));
  }
  testToModules.set(rel(tf), [...mods].sort());
  for (const mod of mods) {
    if (!moduleToTests.has(mod)) moduleToTests.set(mod, []);
    moduleToTests.get(mod).push(path.basename(tf));
  }
}

const modules = srcFiles.map(rel);
const covered = modules.filter((m) => moduleToTests.has(m));
const uncovered = modules.filter((m) => !moduleToTests.has(m));
const orphans = [...testToModules.entries()].filter(([, mods]) => mods.length === 0).map(([t]) => t);
const coverage = modules.length ? (covered.length / modules.length * 100).toFixed(1) : "0.0";

const argv = process.argv.slice(2);
const keyword = argv.find((a) => !a.startsWith("--"));
const md = argv.includes("--md");
const showUncovered = argv.includes("--uncovered");

if (md) {
  const lines = [];
  lines.push("<!-- 由 node scripts/test-map.js --md 生成, 不要手改 -->");
  lines.push("");
  lines.push("# 测试地图: 改哪个模块, 跑哪些测试");
  lines.push("");
  lines.push("测试文件长期按「修复批次」命名, 从文件名看不出覆盖关系。本表由测试文件的 import 反推生成,");
  lines.push("解决两个问题: 改一处不用跑全量, 也不会漏掉藏在日期文件里的契约。");
  lines.push(`规模 (${new Date().toISOString().slice(0, 10)}): ${testFiles.length} 个测试文件 / ${modules.length} 个 src 模块, `
    + `${covered.length} 个模块被直接 import (${coverage}% 下界), ${orphans.length} 个孤儿测试 (不 import 任何 src 模块, 多为静态契约/脚本检查)。`);
  lines.push("");
  lines.push("```bash");
  lines.push("node scripts/test-map.js              # 总览");
  lines.push("node scripts/test-map.js permissions  # 查某模块相关测试");
  lines.push("node scripts/test-map.js --uncovered  # 没被任何测试直接 import 的模块");
  lines.push("node scripts/test-map.js --md         # 重新生成本文件");
  lines.push("```");
  lines.push("");
  lines.push("## 模块 → 测试");
  lines.push("");
  lines.push("| 模块 | 覆盖它的测试 |");
  lines.push("|---|---|");
  for (const mod of modules.slice().sort()) {
    const tests = moduleToTests.get(mod);
    if (!tests) continue;
    lines.push(`| \`${mod}\` | ${tests.slice().sort().map((t) => `\`${t}\``).join("<br>")} |`);
  }
  lines.push("");
  lines.push("## 孤儿测试 (不 import src)");
  lines.push("");
  lines.push(orphans.length ? orphans.sort().map((t) => `- \`${t}\``).join("\n") : "(无)");
  lines.push("");
  process.stdout.write(lines.join("\n"));
  process.exit(0);
}

if (showUncovered) {
  console.log(`未被任何测试直接 import 的模块 (${uncovered.length}/${modules.length}):`);
  for (const m of uncovered.sort()) console.log("  " + m);
  process.exit(0);
}

if (keyword) {
  const hits = modules.filter((m) => m.includes(keyword));
  if (!hits.length) { console.error(`没有匹配 "${keyword}" 的 src 模块`); process.exit(1); }
  for (const m of hits.sort()) {
    const tests = moduleToTests.get(m) || [];
    console.log(`\n${m}`);
    console.log(tests.length ? tests.sort().map((t) => "  - " + t).join("\n") : "  (无直接 import 的测试)");
  }
  process.exit(0);
}

console.log(`测试文件: ${testFiles.length}`);
console.log(`src 模块: ${modules.length} (被直接覆盖 ${covered.length} / ${coverage}% 下界)`);
console.log(`孤儿测试: ${orphans.length}`);
console.log(`未覆盖模块: ${uncovered.length} (node scripts/test-map.js --uncovered 查看)`);
