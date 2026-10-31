// src/selfcode/verify.js — 自改验证器 (2026-10-27)
//
// 一道改动能"算数"必须同时过三关, 全部确定性、零依赖、无 LLM:
//   ① 语法关   node --check (复用 core/postcondition.js 的唯一实现)
//   ② 行为关   node --test 跑指定测试文件, TAP 解析 (复用 evolve/selfiterate.js)
//   ③ 边界关   改动文件必须落在 root 内, 且不得顺手改测试文件 (修代码不修考卷)
//
// 刻意不做的事: 不做 lint、不做覆盖率门 —— 那属于发布流程 (npm run verify),
// 自改闭环的判定标准只有一个: 原来红的测试现在绿了, 且没把别的搞坏。
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JS_SELF_CHECK_EXT } from "../core/postcondition.js";
import { runTestFile } from "../evolve/selfiterate.js";

const execFileP = promisify(execFile);

// ---- 边界关: 路径规范化 + 测试文件保护 ----
// 禁区: node_modules / .git / 账本自身 (改这些不是"改自己", 是砸自己饭碗)
const DENY_SEGMENTS = ["node_modules", ".git", ".ppx-cache"];

// allowTestEdit=false 时, 目标是已知测试文件就拒 (自改代码不能自己改考卷过关)
// 2026-10-30 修复: 旧实现只认调用方显式传入的 testFiles, 而 engine 每次传的是空数组 ——
//   保护等于不存在, 模型可以自改 test/*.test.js 让红变绿。现在按路径特征自动识别测试文件,
//   不依赖调用方自觉; allowTestEdit 仅保留给程序化内部调用, 工具面不再暴露该开关。
const TEST_DIR_RE = /(^|[\\/])(test|tests|__tests__|spec|specs)([\\/]|$)/i;
const TEST_FILE_RE = /(\.test\.|\.spec\.|^test[-_])[^\\/]*$/i;

export function isTestFile(relPath) {
  const rel = String(relPath || "");
  if (TEST_DIR_RE.test(rel)) return true;
  return TEST_FILE_RE.test(path.basename(rel));
}

export function guardPath(root, relPath, { testFiles = [], allowTestEdit = false } = {}) {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, String(relPath || ""));
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    return { ok: false, error: `路径逃逸: ${relPath} 不在 root (${rootAbs}) 之内` };
  }
  const segs = path.relative(rootAbs, abs).split(path.sep);
  const hit = segs.find((s) => DENY_SEGMENTS.includes(s));
  if (hit) return { ok: false, error: `禁区: ${relPath} 位于 ${hit}/ 之下, 不允许自改` };
  if (/(^|[\\/])selfcode[\\/](ledger\.jsonl|backups[\\/])/.test(path.relative(rootAbs, abs))) {
    return { ok: false, error: `禁区: 不许动自改账本本身 (${relPath})` };
  }
  const allowedExt = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".jsonc"]);
  if (!allowedExt.has(path.extname(abs).toLowerCase())) {
    return { ok: false, error: `不允许自改该类型文件: ${path.basename(abs)} (仅 js/mjs/cjs/json/md/txt)` };
  }
  if (!allowTestEdit) {
    const relNorm = path.relative(rootAbs, abs);
    const tset = new Set((testFiles || []).map((p) => path.resolve(rootAbs, p)));
    if (tset.has(abs) || isTestFile(relNorm)) {
      return { ok: false, error: `拒绝改测试文件: ${relNorm} (修代码不修考卷; 测试保护不可由工具参数关闭)` };
    }
  }
  return { ok: true, abs, rel: path.relative(rootAbs, abs) };
}

// ---- 语法关: 逐文件 node --check ----
//
// 2026-10-27 实测踩到的坑 (值得记一辈子): 直接 `node --check x.js` 时, 如果文件含 `export`
// 而所在目录链上没有 `type: "module"` 的 package.json, **退出码是 0** —— Node 先按 CJS 编译
// 失败, 识别到 ESM 语法后切换解析器, 但这条路径不回报语法错误。手工验过:
//   node --check /tmp/y2.js   # 内容: export const x = (1 + 2;   → exit 0 (!!)
//   node --check /tmp/y2.mjs  # 同样内容                      → exit 1 (正确报错)
// 自改常常发生在临时夹具/新目录里, 所以不能赌 .js 的解析模式。做法: `.js` 先复制成同目录的
// 临时 `.mjs` 再 check (同目录 = 同一 package.json 语境, 又不改原文件), `.cjs/.mjs` 原样 check,
// `.json` 走 JSON.parse。这条纪律不修就等于语法关形同虚设。
async function checkOneSyntax(abs, { timeoutMs = 5000 } = {}) {
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".json" || ext === ".jsonc") {
    try {
      JSON.parse(fs.readFileSync(abs, "utf8"));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `${path.basename(abs)}: JSON 解析失败 — ${e.message}` };
    }
  }
  if (!JS_SELF_CHECK_EXT.has(ext)) return { ok: true, skipped: true };

  let target = abs;
  let tmp = null;
  if (ext === ".js") {
    tmp = path.join(path.dirname(abs), ".ppx-syncheck-" + Math.random().toString(36).slice(2, 8) + ".mjs");
    try { fs.writeFileSync(tmp, fs.readFileSync(abs)); target = tmp; } catch { tmp = null; }
  }
  try {
    await execFileP(process.execPath, ["--check", target], { timeout: timeoutMs, windowsHide: true });
    return { ok: true };
  } catch (e) {
    const lines = String((e && e.stderr) || (e && e.message) || "").split("\n");
    const first = lines.find((l) => /Error/i.test(l)) || lines.find((l) => l.trim()) || "解析失败";
    return { ok: false, error: `${path.basename(abs)}: ${first.trim().slice(0, 200)}` };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

// 返回 { ok, checked, failed: [{file, error}] }
export async function syntaxGate(absFiles = [], { timeoutMs = 5000 } = {}) {
  const failed = [];
  let checked = 0;
  for (const abs of absFiles) {
    if (!fs.existsSync(abs)) continue;
    checked++;
    const r = await checkOneSyntax(abs, { timeoutMs });
    if (!r.ok) failed.push({ file: abs, error: r.error });
  }
  return { ok: failed.length === 0, checked, failed };
}

// ---- 行为关: 跑测试文件, 汇总 TAP ----
// tests: 相对 root 的测试文件路径数组; 返回 { ok, ran, total, pass, fail, failed[], details[] }
export async function testGate(root, tests = [], { timeoutMs = 120000 } = {}) {
  const details = [];
  let total = 0, pass = 0, fail = 0;
  const failed = [];
  for (const t of tests) {
    const abs = path.resolve(root, t);
    if (!fs.existsSync(abs)) {
      details.push({ test: t, ok: false, error: "测试文件不存在" });
      fail++;
      failed.push(`${t} (文件不存在)`);
      continue;
    }
    const r = await runTestFile(abs, { cwd: root, timeoutMs });
    const tap = r.tap || { ok: false, total: 0, pass: 0, fail: 1, failed: ["(TAP 解析失败)"] };
    total += tap.total || 0;
    pass += tap.pass || 0;
    fail += tap.fail || 0;
    for (const f of tap.failed || []) failed.push(f);
    details.push({
      test: t,
      ok: !!tap.ok,
      total: tap.total || 0,
      pass: tap.pass || 0,
      fail: tap.fail || 0,
      failed: tap.failed || [],
      timeout: /timeout-killed/.test(r.out || ""),
    });
  }
  return { ok: fail === 0, ran: tests.length, total, pass, fail, failed: failed.slice(0, 20), details };
}

// ---- 三关合一 ----
// changed: 绝对路径数组 (已落盘或待落盘的源码文件); tests: 相对路径数组
export async function verifyChange({ root, changed = [], tests = [], syntaxTimeoutMs = 5000, testTimeoutMs = 120000 } = {}) {
  const syntax = await syntaxGate(changed, { timeoutMs: syntaxTimeoutMs });
  // 语法不过就不跑测试 —— 白跑一遍只会浪费两分钟并给出误导性的红
  if (!syntax.ok) {
    return { ok: false, stage: "syntax", syntax, tests: null, summary: `语法未通过 (${syntax.failed.length} 个文件), 已跳过测试` };
  }
  if (!tests.length) {
    return { ok: true, stage: "syntax", syntax, tests: null, summary: "语法通过 (未指定测试, 行为未验证)" };
  }
  const t = await testGate(root, tests, { timeoutMs: testTimeoutMs });
  return {
    ok: t.ok,
    stage: "tests",
    syntax,
    tests: t,
    summary: t.ok ? `语法通过; 测试 ${t.pass}/${t.total} 通过` : `测试未通过: ${t.fail} 个失败 — ${t.failed.slice(0, 5).join(" | ")}`,
  };
}
