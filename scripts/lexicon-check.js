#!/usr/bin/env node
// scripts/lexicon-check.js — 界面文案一致性门禁 (2026-11-13)
//
// 词典 (webapp/src/i18n/lexicon.js) 规定: 用户界面只说
//   助手 / 项目 / 任务 / 运行状态 / 执行过程 / 工作模式 / 运行阶段
// 内核叫法 (本体/空间/工单/身体/轨迹/姿态/生命周期/新开一局/新手指引) 只许出现在
// 代码与注释里, 不许漏进任何用户可见文案 (模板文本、属性、toast/报错/确认框)。
//
// 扫描口径: 注释先被剔除 (注释是给开发者看的), 剩下的每一行都按用户可见处理。
// 例外写法: 同一行或上一行写 `lexicon-ok(YYYY-MM-DD): 理由` —— 与 swallowed-ok 同款约定。
//
// 用法: node scripts/lexicon-check.js [--root <目录>] [--verbose]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INTERNAL_ALIAS } from "../webapp/src/i18n/lexicon.js";
import { walkFiles } from "./lib/walk-js.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_TERMS = Object.keys(INTERNAL_ALIAS);
const DEFAULT_SCAN_ROOT = path.join(ROOT, "webapp", "src");

/** 注释剔除: 保留换行, 让行号与原文一一对应 */
export function stripComments(src, ext) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  let s = src;
  if (ext === ".vue") s = s.replace(/<!--[\s\S]*?-->/g, blank);
  s = s.replace(/\/\*[\s\S]*?\*\//g, blank);
  // 行注释: `//` 前必须是行首或非 `:`/字符/下划线 —— 放过 https:// 这类 URL
  s = s.replace(/(^|[^:\w])\/\/[^\n]*/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  return s;
}

/** 单文件扫描: 返回 [{ line, term, userWord, text }] */
export function scanSource(src, { file = "", ext = path.extname(file) || ".js" } = {}) {
  const rawLines = src.split(/\r?\n/);
  const visible = stripComments(src, ext).split(/\r?\n/);
  const hits = [];
  visible.forEach((line, i) => {
    if (!line) return;
    const allow = (rawLines[i] || "").includes("lexicon-ok") || (rawLines[i - 1] || "").includes("lexicon-ok");
    if (allow) return;
    for (const term of INTERNAL_TERMS) {
      if (line.includes(term)) {
        hits.push({ line: i + 1, term, userWord: INTERNAL_ALIAS[term], text: rawLines[i].trim() });
        break;
      }
    }
  });
  return hits;
}

/** 目录扫描: 返回 [{ file, line, term, userWord, text }] */
export function scanRoot(root = DEFAULT_SCAN_ROOT) {
  const findings = [];
  for (const file of walkFiles(root, { exts: [".js", ".vue"] })) {
    if (file.endsWith(path.join("i18n", "lexicon.js"))) continue;
    const hits = scanSource(fs.readFileSync(file, "utf8"), { file });
    for (const h of hits) findings.push({ file, ...h });
  }
  return findings;
}

function arg(name, def = null) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = arg("root") || DEFAULT_SCAN_ROOT;
  const verbose = process.argv.includes("--verbose");
  const findings = scanRoot(path.resolve(String(root)));
  if (!findings.length) {
    console.log(`  ✓ 界面文案无内部词泄漏 (扫描 ${INTERNAL_TERMS.length} 个内部叫法)`);
    if (verbose) console.log(`    根: ${root}`);
  } else {
    for (const f of findings) {
      const rel = path.relative(ROOT, f.file).replace(/\\/g, "/");
      console.log(`  ✗ ${rel}:${f.line}  「${f.term}」→ 用户词「${f.userWord}」`);
      console.log(`      ${f.text}`);
    }
    console.log(`\n文案门禁: ${findings.length} 处内部词泄漏进用户可见文案`);
  }
  process.exitCode = findings.length ? 1 : 0;
}
