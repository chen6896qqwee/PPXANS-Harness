#!/usr/bin/env node
// scripts/package-scan.js — 打包产物安全扫描 (2026-10-30)
//
// 背景: 3.5.0 的 electron-builder 配置把整个 config/** 打进安装包, 结果开发者本机的
//   config/ppx.json (self_code/self_iteration = apply, 每日进化) 和 ppx.json.bak-* 一起
//   发给了所有用户; 若本机配置里有明文 api_key, 也会原样泄露。
//
// 本脚本对**实际产物目录**做最后一道检查:
//   · 禁止出现 config/ppx.json 与任何 config/*.bak-*
//   · 禁止出现 data/、uploads/、.ppx/ 等运行数据
//   · config 下 JSON 不允许出现非占位符的 api_key / auth_token / secret
// 用法:
//   node scripts/package-scan.js <dir> [--verbose]
// 退出码: 0 = 干净; 1 = 发现禁止内容。
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const verbose = process.argv.includes("--verbose");
if (!dir) {
  console.error("用法: node scripts/package-scan.js <产物目录> [--verbose]");
  process.exit(2);
}
const root = path.resolve(dir);
if (!fs.existsSync(root)) {
  console.error(`[package-scan] 目录不存在: ${root}`);
  process.exit(2);
}

const problems = [];
const PLACEHOLDER = /^(|x+|xxx+|sk-xxx.*|YOUR_.*|<.*>|replace[-_ ]?me|changeme|test|dummy|example)$/i;

function rel(p) { return path.relative(root, p).replace(/\\/g, "/"); }

function walk(d, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fp = path.join(d, e.name);
    const r = rel(fp);
    if (e.isDirectory()) {
      if (/^(node_modules|dist|dist-desktop|\.git|\.ppx-cache)$/.test(e.name)) continue;
      if (/^(data|uploads|\.ppx)(\/|$)/.test(r)) { problems.push(`运行数据目录被打包: ${r}/`); continue; }
      walk(fp, depth + 1);
      continue;
    }
    if (!e.isFile()) continue;
    const base = e.name.toLowerCase();
    if (base === "ppx.json" && /(^|\/)config\//.test(r)) problems.push(`用户配置被打包: ${r}`);
    if (/^ppx\.json\.(bak|backup)|\.bak-/.test(base) && /(^|\/)config\//.test(r)) problems.push(`配置备份被打包: ${r}`);
    if (base === "audit-hmac-key") problems.push(`审计密钥被打包: ${r}`);
    // 只扫 config 下的 JSON: 源码/测试/参考素材里有大量形似凭据的测试字面量, 扫了只会误报。
    if (!/\.(json|jsonc)$/i.test(base) || !/(^|\/)config\/[^/]+$/i.test(r)) continue;
    let text = "";
    try { text = fs.readFileSync(fp, "utf8"); } catch { continue; }
    for (const m of text.matchAll(/"(api_key|apiKey|auth_token|authToken|secret|client_secret)"\s*:\s*"([^"]*)"/gi)) {
      const val = String(m[2] || "").trim();
      if (val && !PLACEHOLDER.test(val)) problems.push(`疑似明文凭据: ${r} → ${m[1]}`);
    }
  }
}

walk(root);

if (verbose) console.log(`[package-scan] 扫描完成: ${root} (${problems.length} 个问题)`);
if (problems.length) {
  console.error("[package-scan] 产物不安全:");
  for (const p of problems.slice(0, 20)) console.error("  ✗ " + p);
  if (problems.length > 20) console.error(`  … 其余 ${problems.length - 20} 项省略`);
  process.exit(1);
}
console.log("[package-scan] ✓ 未发现用户配置/备份/运行数据/明文凭据");
