// scripts/depcheck.js - 依赖完整性闸门 (零依赖)
//
// 背景 (2026-10-09): 本项目曾因 src/skills/ 【整个目录缺失】而完全无法启动 ——
//   src/agent/index.js (package.json 的 main) 在 import 阶段抛 ERR_MODULE_NOT_FOUND,
//   连带 CLI / Web / Serve / MCP 全部崩, 65 个测试文件在 import 阶段全灭。
//   而 npm test 的 TAP 输出里, 这类错误长得像"这个测试文件失败了", 极易被误读成单点 bug。
//   本脚本把"被引用但不存在"的相对模块一次性列出来, 并按目标聚合 ——
//   一眼能区分【目录级缺失】(如 src/skills/ 整体丢失) 与【单文件问题】。
//
// 用法:
//   node scripts/depcheck.js [rootDir]      # 默认当前目录
//   退出码: 0 = 完整, 1 = 存在缺失模块
//
// 扫描范围: 全树 .js/.mjs/.cjs, 跳过 node_modules / .git / data / dist / 隔离区 / .ppxtest
// dist-desktop: electron-builder 产物, 内含源码副本, 扫描会误报"缺失模块"
// 只检查【相对路径】import (`./x`, `../x`); node: 内置与裸包名 (外部依赖) 不在此职责内。

import fs from "node:fs";
import path from "node:path";
import { walkFiles } from "./lib/walk-js.js";

const ROOT = path.resolve(process.argv[2] || ".");
// .ppxtest 是冒烟/探针的临时归档目录 (git 忽略), 里面的脚本会引用随时可能被删的模块 ——
//   2026-11-08: boundary-probe.mjs 引用已移除的 seam/registry.js, 让整个 depcheck 变成 P0 阻塞。
//   临时产物不参与依赖完整性判定。
const SKIP_DIRS = ["node_modules", ".git", "data", "dist", "dist-desktop", ".cache", ".stage", ".x", ".ppxtest"];
const RESOLVE_SUFFIXES = ["", ".js", ".mjs", ".cjs", ".json"];

// ---- 收集待扫文件 (读不了的目录跳过, 不因一个坏目录中断整轮体检) ----
const files = walkFiles(ROOT, { exts: [".js", ".mjs", ".cjs"], skipDirs: SKIP_DIRS, tolerant: true });

// ---- 夹具生成器豁免 (2026-11-14): bench/tasks.js + bench/offline-plans.js 的字符串里
//   故意含有 "import ... from \"./x.js\"" —— 那是**写给沙箱的夹具内容** (多步链任务素材),
//   不是本仓真实依赖; 其正确性由 bench/falsify.js (oracle 判正/变异体判负) 与离线基准双门
//   单独覆盖。depcheck 的字符串保真扫描对它们是误报源, 显式豁免而不是全局削弱字符串检测。
const IGNORE_FILES = [/^bench[\\/]tasks\.js$/, /^bench[\\/]offline-plans\.js$/];

// ---- 去注释 / 去字符串: 避免把注释里的示例 import 当成真实依赖 ----
// 用状态机而不是正则 —— 正则在 "http://..." / 模板串 / 正则字面量上会误判。
// 返回一份「只保留代码骨架、字符串内容替换为占位符」的文本:
//   · 注释 → 空白
//   · 字符串/模板串 → "…" (但模块说明符的位置我们后面单独用原始文本定位)
// 简化策略: 只把【注释内容】清空, 字符串保持原样 —— 因为我们要找的 `from "..."` 本身就在字符串里。
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let state = "code"; // code | line | block | single | double | template
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; i += 2; continue; }
      if (c === '"') { state = "double"; out += c; i++; continue; }
      if (c === "'") { state = "single"; out += c; i++; continue; }
      if (c === "`") { state = "template"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") { if (c === "\n") { state = "code"; out += "\n"; } i++; continue; }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; i += 2; out += " "; continue; }
      if (c === "\n") out += "\n"; // 保留行号
      i++; continue;
    }
    // 字符串内部: 原样保留, 处理转义与结束符
    if (c === "\\") { out += c + (c2 || ""); i += 2; continue; }
    if ((state === "double" && c === '"') || (state === "single" && c === "'") || (state === "template" && c === "`")) {
      state = "code";
    }
    out += c; i++;
  }
  return out;
}

// ---- 抓相对模块说明符 ----
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']((?:\.\/|\.\.\/)[^"']*)["']/g;

function resolveTarget(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const suf of RESOLVE_SUFFIXES) {
    if (fs.existsSync(base + suf) && fs.statSync(base + suf).isFile()) return true;
  }
  // 目录 + index.*
  for (const ext of [".js", ".mjs", ".cjs", ".json"]) {
    const idx = path.join(base, "index" + ext);
    if (fs.existsSync(idx)) return true;
  }
  return fs.existsSync(base) && fs.statSync(base).isDirectory();
}

// ---- 主流程 ----
const missing = new Map(); // 目标绝对路径 -> 引用方相对路径集合

for (const f of files) {
  const relFile = path.relative(ROOT, f);
  if (IGNORE_FILES.some((re) => re.test(relFile))) continue;
  let src;
  try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
  const code = stripComments(src);
  let m;
  SPEC_RE.lastIndex = 0;
  while ((m = SPEC_RE.exec(code))) {
    const spec = m[1];
    if (resolveTarget(f, spec)) continue;
    const target = path.resolve(path.dirname(f), spec);
    if (!missing.has(target)) missing.set(target, new Set());
    missing.get(target).add(path.relative(ROOT, f));
  }
}

console.log(`[depcheck] 扫描 ${files.length} 个文件 (root=${ROOT})`);

if (missing.size === 0) {
  console.log("[depcheck] ✅ 依赖完整: 无「被引用但不存在」的相对模块");
  process.exit(0);
}

console.log(`[depcheck] ❌ 发现 ${missing.size} 个缺失目标:\n`);
const rows = [...missing.entries()].sort((a, b) => b[1].size - a[1].size);
for (const [target, refs] of rows) {
  const rel = path.relative(ROOT, target);
  const list = [...refs];
  // 引用方 ≥3 且集中在同一目录前缀 → 提示"目录级缺失"
  const dirs = new Set(list.map((r) => path.dirname(r).split(path.sep).slice(0, 2).join("/")));
  const hint = list.length >= 3 && dirs.size <= 2 ? "  ⚠ 疑似【目录级缺失】" : "";
  console.log(`  ✗ ${rel}${hint}`);
  console.log(`      引用方 ${list.length} 处: ${list.slice(0, 8).join(", ")}${list.length > 8 ? ` …(共 ${list.length})` : ""}`);
  console.log("");
}

console.log("[depcheck] 判定: 存在缺失模块 → 这是 P0, 会阻塞启动与测试。先补齐再谈其他。");
process.exit(1);
