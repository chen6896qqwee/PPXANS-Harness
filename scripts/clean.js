#!/usr/bin/env node
// scripts/clean.js - 本地测试/构建产物清理 (2026-11-02)
//
// 只删可再生成的产物, 绝不碰 data/ (运行期记忆)、config/ (含密钥)、test/ (源码测试)、
// skills/、uploads/ 等用户状态。默认幂等, 可重复执行。
//
// 用法:
//   node scripts/clean.js            # 清理 .ppxtest / coverage / dist-desktop / 根目录日志
//   node scripts/clean.js --dry-run  # 只列出将删除的路径
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");

const TARGETS = [
  ".ppxtest",
  "coverage",
  ".nyc_output",
  "dist-desktop",
];

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      total += sizeOf(path.join(p, e.name));
    }
    return total;
  } catch { return 0; }
}

let removed = 0;
let bytes = 0;
for (const rel of TARGETS) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const b = sizeOf(p);
  console.log(`  ${DRY ? "would remove" : "remove"}  ${rel}  (${(b / 1024 / 1024).toFixed(1)} MB)`);
  bytes += b;
  removed++;
  if (!DRY) fs.rmSync(p, { recursive: true, force: true });
}

// 根目录下的本地日志 (*.log) —— 只删根目录一层, 不递归进 data/logs。
try {
  for (const f of fs.readdirSync(ROOT)) {
    if (!f.endsWith(".log")) continue;
    const p = path.join(ROOT, f);
    try {
      if (fs.statSync(p).isFile()) {
        console.log(`  ${DRY ? "would remove" : "remove"}  ${f}  (${(fs.statSync(p).size / 1024).toFixed(1)} KB)`);
        if (!DRY) fs.unlinkSync(p);
        removed++;
      }
    } catch { /* best effort */ }
  }
} catch { /* ignore */ }

console.log(`\n[clean] ${DRY ? "将删除" : "已删除"} ${removed} 项, 释放约 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
