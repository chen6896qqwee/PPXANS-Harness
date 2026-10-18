#!/usr/bin/env node
// scripts/coverage-gate.js — Node 内置测试覆盖率门禁 (离线)
// 用法:
//   node scripts/coverage-gate.js                默认行覆盖 >= 85%
//   node scripts/coverage-gate.js --min=90       自定义阈值
//   PPX_MIN_COVERAGE=90 node scripts/coverage-gate.js
// 退出码: 0 = 全量测试通过且行覆盖达标; 1 = 测试失败 / 覆盖率不达标 / 无法解析覆盖率。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const NODE = process.execPath;

function parseMin(argv) {
  const fromArg = argv.find((a) => a.startsWith("--min="));
  if (fromArg) {
    const n = Number(fromArg.split("=")[1]);
    if (Number.isFinite(n)) return n;
  }
  const env = Number(process.env.PPX_MIN_COVERAGE);
  if (Number.isFinite(env) && env > 0) return env;
  return 85;
}

const MIN = parseMin(process.argv.slice(2));
const args = ["--test", "--experimental-test-coverage", "--test-force-exit", "test/*.test.js"];
const r = spawnSync(NODE, args, {
  cwd: ROOT,
  encoding: "utf8",
  shell: false,
  maxBuffer: 512 * 1024 * 1024,
  env: { ...process.env, NO_COLOR: "1" },
});
const out = `${r.stdout || ""}${r.stderr || ""}`;

console.log(`[coverage-gate] 全量测试 + Node 内置覆盖率 (阈值: 行覆盖 >= ${MIN}%)`);
const tail = out.trim().split(/\r?\n/).slice(-30).join("\n");
if (tail) console.log(tail);

if (r.status !== 0) {
  console.error(`[coverage-gate] ✗ 全量测试未通过 (exit ${r.status})`);
  process.exitCode = 1;
  process.exit();
}

const m = out.match(/all files\s*\|?\s*(\d+(?:\.\d+)?)/);
if (!m) {
  console.error("[coverage-gate] ✗ 无法从测试输出解析 all files 行覆盖率");
  process.exitCode = 1;
  process.exit();
}

const line = Number(m[1]);
if (!Number.isFinite(line)) {
  console.error("[coverage-gate] ✗ 解析到的行覆盖率不是数字: " + m[1]);
  process.exitCode = 1;
  process.exit();
}

console.log(`[coverage-gate] 行覆盖 = ${line}% (阈值 ${MIN}%)`);
if (line < MIN) {
  console.error(`[coverage-gate] ✗ 行覆盖低于门禁: ${line}% < ${MIN}%`);
  process.exitCode = 1;
} else {
  console.log(`[coverage-gate] ✓ 覆盖率门禁通过`);
}