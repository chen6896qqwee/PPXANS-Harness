#!/usr/bin/env node
// scripts/native-guard.js — 自研溯源守卫 (零依赖)
//
// 目的: 把"仅借鉴设计、源码全部自研"从一句声明变成可执行约束。
//   ① 禁止 import 任何上游项目 (dsh/deepseek-harness/openclaw/...);
//   ② 禁止 vendored 源码标记 (上游版权头 / 上游 src 路径);
//   ③ 每个登记的设计来源必须有原生模块落点, 且模块真实存在;
//   ④ 每个来源必须在 docs/PROVENANCE.md 有对应条目;
//   ⑤ 来源 token 不得重复归属。
//
// 用法:
//   node scripts/native-guard.js          # 报告
//   node scripts/native-guard.js --check  # 闸门模式 (有 issue 即非零退出; 当前默认同等)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkJs } from "./lib/walk-js.js";

const ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_REL = "config/native-provenance.json";
const DOC_REL = "docs/PROVENANCE.md";

function listJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  walkJs(dir, (fp) => out.push(fp));
  return out;
}

export function loadRegistry(root = ROOT_DEFAULT) {
  const p = path.join(root, REGISTRY_REL);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function countToken(text, token) {
  if (!token) return 0;
  // 纯标识符 token 用词边界计数, 避免 "ACE" 命中 "PLACE"/"SPACE" 造成虚高。
  if (/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/.test(token)) {
    const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, "g");
    return (text.match(re) || []).length;
  }
  let n = 0;
  let i = 0;
  for (;;) {
    const j = text.indexOf(token, i);
    if (j < 0) break;
    n += 1;
    i = j + token.length;
  }
  return n;
}

/**
 * 审计仓库的自研溯源状态。
 * @returns {{ok:boolean, issues:string[], stats:object}}
 */
export function auditNative(root = ROOT_DEFAULT) {
  const issues = [];
  let registry;
  try {
    registry = loadRegistry(root);
  } catch (e) {
    return { ok: false, issues: [`无法读取 ${REGISTRY_REL}: ${e.message}`], stats: {} }; // swallowed-ok(2026-11-03): 已转为 issues 回传
  }

  if (!Array.isArray(registry.origins) || registry.origins.length === 0) {
    issues.push("注册表没有 origins");
  }

  // ---- 注册表结构 / token 唯一性 / 模块存在性 ----
  const seenIds = new Set();
  const tokenOwner = new Map();
  let moduleCount = 0;
  for (const o of registry.origins || []) {
    const id = String(o.id || "");
    if (!id) { issues.push("存在缺少 id 的来源条目"); continue; }
    if (seenIds.has(id)) issues.push(`来源 id 重复: ${id}`);
    seenIds.add(id);
    if (!Array.isArray(o.tokens) || o.tokens.length === 0) issues.push(`来源 ${id} 缺少 tokens`);
    for (const tok of o.tokens || []) {
      const key = String(tok);
      if (tokenOwner.has(key)) issues.push(`token "${key}" 同时属于 ${tokenOwner.get(key)} 与 ${id}`);
      else tokenOwner.set(key, id);
    }
    if (!Array.isArray(o.modules) || o.modules.length === 0) {
      issues.push(`来源 ${id} 没有原生模块落点`);
      continue;
    }
    for (const rel of o.modules) {
      const fp = path.join(root, rel);
      if (!fp.startsWith(path.join(root, "src") + path.sep)) {
        issues.push(`来源 ${id} 的模块不在 src/ 下: ${rel}`);
        continue;
      }
      if (!fs.existsSync(fp)) issues.push(`来源 ${id} 的原生模块不存在: ${rel}`);
      else moduleCount += 1;
    }
  }

  // ---- 文档必须逐条登记 ----
  const docPath = path.join(root, DOC_REL);
  const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
  if (!doc) issues.push(`缺少溯源文档 ${DOC_REL}`);
  for (const id of seenIds) {
    if (!doc.includes(id)) issues.push(`溯源文档未登记来源: ${id}`);
  }

  // ---- 源码: 禁止上游 import / vendored 标记 ----
  const files = listJs(path.join(root, "src"));
  const importFrom = /\bfrom\s*["']([^"']+)["']/g;
  const importCall = /\bimport\s*\(\s*["']([^"']+)["']/g;
  const requireCall = /\brequire\s*\(\s*["']([^"']+)["']/g;
  const forbidden = (spec) => (registry.forbiddenImportPrefixes || []).some((p) => String(spec).startsWith(p));
  const markers = registry.forbiddenSourceMarkers || [];
  const stats = { files: files.length, origins: seenIds.size, modules: moduleCount, mentions: {}, imports: 0 };

  for (const fp of files) {
    const rel = path.relative(root, fp).replace(/\\/g, "/");
    const text = fs.readFileSync(fp, "utf8");
    for (const re of [importFrom, importCall, requireCall]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const spec = m[1];
        if (forbidden(spec)) issues.push(`${rel}: 禁止 import 上游模块 "${spec}"`);
        stats.imports += 1;
      }
    }
    for (const marker of markers) {
      if (text.includes(marker)) issues.push(`${rel}: 发现上游源码标记 "${marker}"`);
    }
    for (const [tok, id] of tokenOwner) {
      const n = countToken(text, tok);
      if (n > 0) stats.mentions[id] = (stats.mentions[id] || 0) + n;
    }
  }

  return { ok: issues.length === 0, issues, stats };
}

function main() {
  const r = auditNative(ROOT_DEFAULT);
  console.log(`[native-guard] 来源 ${r.stats.origins || 0} 个, 原生模块 ${r.stats.modules || 0} 个, 扫描 ${r.stats.files || 0} 个文件`);
  for (const o of loadRegistry(ROOT_DEFAULT).origins) {
    const n = r.stats.mentions[o.id] || 0;
    console.log(`  · ${o.id.padEnd(24)} 设计提及 ${String(n).padStart(3)} 次  →  ${o.modules.length} 个原生模块`);
  }
  if (!r.ok) {
    console.error("\n[native-guard] 发现自研溯源问题:");
    for (const i of r.issues) console.error(`  ✗ ${i}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n✓ 全部为自研实现: 无上游 import、无 vendored 标记、每个设计来源都有原生落点与文档登记。");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
