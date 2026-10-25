#!/usr/bin/env node
// scripts/silent-catch-guard.mjs — 空 catch 静态守卫 (2026-10-10 新增, 对应评价报告 P0-3)
//
// 动机: 本项目 2026-10-10 出现一次「加功能但没接线」事故 —— estimateCost 未 import,
//   ReferenceError 被同行 `catch {}` 吃掉, 成本护栏 100% 静默失效且无人发现。
//   空 catch 本身不是错, 但**吞掉关键路径异常且不留痕**是必须门禁的。
//
// 用法:
//   node scripts/silent-catch-guard.mjs            # report 模式: 列出全部空 catch (不失败)
//   node scripts/silent-catch-guard.mjs --strict   # strict 模式: 关键路径空 catch 即失败 (CI 门禁)
//   node scripts/silent-catch-guard.mjs --json     # 机器可读输出
//
// 关键路径 (strict 下禁止裸空 catch, 必须 debug()/warn() 留痕):
//   文件命中以下任一目录/关键词, 视为"账目/持久化/审计/记忆"关键路径:
//     audit/  memory/  llm/  config/  session/  evidence/
//   且 catch 块所在函数名包含: account/flush/persist/write/save/load/record/audit/append/store/sync

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

const args = process.argv.slice(2);
const STRICT = args.includes("--strict");
const JSON_OUT = args.includes("--json");

// 关键路径判定
const CRITICAL_DIRS = ["audit", "memory", "llm", "config", "session", "evidence"];
const CRITICAL_WORDS = ["account", "flush", "persist", "write", "save", "load", "record", "audit", "append", "store", "sync"];

// 匹配「空 catch」: catch {} / catch(e) {} / catch (e) { } / catch { /* 注释 */ }
// 允许块内只有空白或注释 —— 这类仍属"无留痕"。
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)*\}/g;

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

// 找 catch 之前最近的函数名 (粗粒度, 够用)
function nearestFnName(lines, upto) {
  for (let i = upto; i >= 0 && i > upto - 60; i--) {
    const m = lines[i].match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
    if (m) return m[1];
    const m2 = lines[i].match(/^\s*_?([A-Za-z_$][\w$]*)\s*\(.*\)\s*\{/);
    if (m2) return m2[1];
  }
  return "";
}

const files = walk(SRC);
const findings = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  const text = fs.readFileSync(f, "utf8");
  const lines = text.split(/\r?\n/);
  let m;
  EMPTY_CATCH.lastIndex = 0;
  while ((m = EMPTY_CATCH.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const lineNo = before.split(/\r?\n/).length;
    const fn = nearestFnName(lines, lineNo - 1);
    const inCriticalDir = CRITICAL_DIRS.some((d) => rel.includes(`/src/${d}/`) || rel.startsWith(`src/${d}/`));
    const hitsCriticalWord = CRITICAL_WORDS.some((w) => fn.toLowerCase().includes(w));
    const critical = inCriticalDir || hitsCriticalWord;
    findings.push({ file: rel, line: lineNo, fn, critical, snippet: lines[lineNo - 1]?.trim().slice(0, 100) });
  }
}

const criticalFindings = findings.filter((x) => x.critical);

if (JSON_OUT) {
  console.log(JSON.stringify({ total: findings.length, critical: criticalFindings.length, findings }, null, 2));
  process.exit(STRICT && criticalFindings.length ? 1 : 0);
}

console.log(`[silent-catch-guard] src/ 内空 catch 共 ${findings.length} 处, 其中关键路径 ${criticalFindings.length} 处`);
if (criticalFindings.length) {
  console.log("\n关键路径 (strict 下必须留痕 debug()/warn()):");
  for (const x of criticalFindings) console.log(`  ${x.file}:${x.line}  fn=${x.fn || "?"}  ${x.snippet}`);
}
if (!STRICT) {
  console.log(`\n提示: 其余 ${findings.length - criticalFindings.length} 处散落在非关键路径 (UI 回调/事件派发等), 允许静默。`);
  console.log("运行 `--strict` 可将其余关键路径空 catch 作为 CI 门禁。");
}

if (STRICT && criticalFindings.length) {
  console.error(`\n[silent-catch-guard] FAIL: 关键路径存在 ${criticalFindings.length} 处静默 catch, 请改为留痕。`);
  process.exit(1);
}
console.log("\n[silent-catch-guard] PASS");
