#!/usr/bin/env node
// scripts/claim-gate.js - 功能宣称闸门 (2026-10-24)
// 动机: README 数字有同步闸门 (readme-sync-check), 但**能力宣称**没有 —— "六事件钩子链"、
//   "@ 引用文件" 这类句子可以写着写着就漂移成死代码 (2026-10 审计实测: 9 个 v3 模块里
//   SQ/3 个钩子/11 条命令/evidence manifest 均为 provide-only)。本闸门把每条面向用户的
//   能力宣称钉到一个测试证据上:
//     · claim    README 必须出现的宣称短语 (宣称不在了 → 条目过期, 提示清理清单)
//     · test     佐证测试文件 (必须存在)
//     · expect   测试/源码里必须存在的字符串 (测试名片段或实现锚点)
// 任何一侧漂移 → 闸门红。新增能力时在 claim-gate.json 加一行即可。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "scripts", "claim-gate.json");
const README = path.join(ROOT, "README.md");

const entries = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const readme = fs.readFileSync(README, "utf8");

let failures = 0;
for (const e of entries) {
  const problems = [];
  // ① README 宣称在场 (宣称撤了 → 清理本条; 宣称在 → 必须有证据)
  if (!readme.includes(e.claim)) {
    problems.push(`README 未找到宣称 "${e.claim}" —— 若功能已撤除请同步删除本条`);
  }
  // ② 证据测试文件在场
  const testFile = path.join(ROOT, e.test);
  if (!fs.existsSync(testFile)) {
    problems.push(`证据测试缺失: ${e.test}`);
  } else {
    // ③ 证据锚点: 默认在测试文件找; 提供 target 时改查源码文件 (实现锚点)
    const target = e.target ? path.join(ROOT, e.target) : testFile;
    if (!fs.existsSync(target)) {
      problems.push(`锚点目标缺失: ${e.target || e.test}`);
    } else {
      const hay = fs.readFileSync(target, "utf8");
      if (!hay.includes(e.expect)) {
        problems.push(`证据锚点缺失: "${e.expect}" 不在 ${path.relative(ROOT, target)}`);
      }
    }
  }
  if (problems.length) {
    failures++;
    console.log(`  ✗ ${e.claim}`);
    for (const p of problems) console.log(`      ${p}`);
  } else {
    console.log(`  ✓ ${e.claim}  ←  ${e.test}`);
  }
}

console.log(`\n宣称闸门: ${entries.length - failures}/${entries.length} 条有证据`);
process.exitCode = failures ? 1 : 0;
