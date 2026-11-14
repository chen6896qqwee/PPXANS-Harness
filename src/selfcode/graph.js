// src/selfcode/graph.js — 自身代码图谱 (2026-11-02)
//
// 定位: 自优化闭环的"眼睛"。self_edit 改的是单个文件, 但改之前必须知道:
//   这个文件被谁依赖、哪些测试覆盖它、改坏了会波及哪条链路。
//   本模块把仓库静态解析成文件级依赖图 (不执行代码, 零依赖), 供三处复用:
//     ① src/selfcode/audit.js      自审: 死代码/依赖环/巨石/静默 catch + 优化建议
//     ② src/tools/selfcode.js      自改时自动发现相关测试 (改完即验证)
//     ③ src/evolve/loop.js         Phase0 每日审计快照 (结构健康趋势)
//
// 契约:
//   · 只读。不写盘、不执行、不联网。
//   · 稳定排序。同一份代码两次调用输出逐字节一致 (可直接对比趋势)。
//   · 不把"可动态加载"当死代码一刀切: 无产品引用但**有测试引用**的模块标为 reserved,
//     只有"产品不可达 + 测试也不引用"才算 unwired (死代码候选)。
import fs from "node:fs";
import path from "node:path";
import { summarizeCatchScan } from "./catch-scan.js";
import { readJson } from "../utils/store.js";
import { stripComments } from "./source-text.js";

export const DEFAULT_SOURCE_DIRS = ["src", "bin", "electron", "scripts"];

function listSourceFiles(root, dirs = DEFAULT_SOURCE_DIRS) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "data" || e.name === ".ppx-cache") continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.(?:js|mjs|cjs)$/.test(e.name)) out.push(fp);
    }
  };
  for (const d of dirs) walk(path.resolve(root, d));
  return out.sort();
}

function resolveSpec(fromFile, spec) {
  if (!spec || typeof spec !== "string") return null;
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  if (spec.includes("${")) return null; // 动态拼接路径无法静态判定
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + ".js", base + ".mjs", base + ".cjs", path.join(base, "index.js")]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 下一个候选 */ }
  }
  return null;
}

const IMPORT_RES = [
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

// 去注释 (保留字符串) 的实现在 utils/source-text.js: 注释里的示例 import 不是依赖,
// 不剥注释会把文档示例误判成真实边 (config/index.js 曾因此被报成自环)。

// 相对引用解析: 返回 { deps, unresolved }。unresolved 只收"看起来是相对路径但文件不存在"的,
// 这是真实的断链信号 (改名/删文件后残留 import), 不是包引用。
function parseDeps(file) {
  let src = "";
  try { src = stripComments(fs.readFileSync(file, "utf8")); } catch { return { deps: [], unresolved: [] }; }
  const deps = new Set();
  const unresolved = new Set();
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const r = resolveSpec(file, spec);
      if (r) deps.add(r);
      else if (!spec.includes("${")) unresolved.add(spec);
    }
  }
  // Worker/子进程的字符串路径 (new URL("./sandbox-worker.js", import.meta.url) / spawn(node, [path]))
  for (const m of src.matchAll(/["'](\.{1,2}\/[^"']+\.(?:js|mjs|cjs))["']/g)) {
    const r = resolveSpec(file, m[1]);
    if (r) deps.add(r);
  }
  return { deps: [...deps], unresolved: [...unresolved] };
}

// readJson 收敛 (2026-11-08): utils/store.js readJson 同语义 (缺失静默回退 null, 损坏留 warn)。

// 入口 = package.json bin/main/exports/scripts + bin/ + electron/ + scripts/ + 已知 src 单文件入口
function discoverEntries(root, pkg = null) {
  const manifest = pkg ?? readJson(path.join(root, "package.json")) ?? {};
  const entries = new Set();
  const add = (rel) => {
    const abs = path.resolve(root, String(rel || ""));
    try { if (fs.statSync(abs).isFile()) entries.add(abs); } catch { /* 不存在不算入口 */ }
  };
  for (const v of Object.values(manifest.bin || {})) add(v);
  if (manifest.main) add(manifest.main);
  for (const v of Object.values(manifest.exports || {})) if (typeof v === "string") add(v);
  for (const cmd of Object.values(manifest.scripts || {})) {
    for (const m of String(cmd).matchAll(/\bnode\s+(?:--[^\s]+\s+)*([^\s&|;]+\.(?:js|mjs|cjs))/g)) add(m[1]);
  }
  for (const d of ["bin", "electron", "scripts"]) {
    for (const f of listSourceFiles(root, [d])) entries.add(f);
  }
  for (const rel of ["src/cli.js", "src/server.js", "src/agent-worker.js", "src/channels-cli.js", "src/cli-doctor.js", "src/mcp-stdio.js"]) add(rel);
  return [...entries].sort();
}

// 测试引用: 对每个 src 文件, 哪些测试直接 import 了它 (反向索引)。
function testIndex(root, files) {
  const testDir = path.join(root, "test");
  const tests = fs.existsSync(testDir)
    ? fs.readdirSync(testDir).filter((n) => n.endsWith(".test.js")).map((n) => path.join(testDir, n))
    : [];
  const byFile = new Map();
  const testDeps = new Map();
  for (const t of tests) {
    const { deps } = parseDeps(t);
    testDeps.set(t, deps);
    for (const d of deps) {
      if (!byFile.has(d)) byFile.set(d, []);
      byFile.get(d).push(path.relative(root, t));
    }
  }
  return { tests, byFile, testDeps };
}

export function buildGraph({ root = process.cwd(), dirs = DEFAULT_SOURCE_DIRS } = {}) {
  const absRoot = path.resolve(root);
  const files = listSourceFiles(absRoot, dirs);
  const fileSet = new Set(files);
  const graph = new Map();
  const unresolved = [];
  for (const f of files) {
    const r = parseDeps(f);
    graph.set(f, r.deps.filter((d) => fileSet.has(d)));
    if (r.unresolved.length) unresolved.push({ file: path.relative(absRoot, f), specs: r.unresolved.sort() });
  }
  const entries = discoverEntries(absRoot);
  const entrySet = new Set(entries.filter((e) => fileSet.has(e)));

  const reachable = new Set();
  const queue = [...entrySet];
  while (queue.length) {
    const f = queue.pop();
    if (reachable.has(f)) continue;
    reachable.add(f);
    for (const d of graph.get(f) || []) if (!reachable.has(d)) queue.push(d);
  }

  const { tests, byFile, testDeps } = testIndex(absRoot, files);
  const unreachable = files.filter((f) => !reachable.has(f));
  const unwired = unreachable.filter((f) => !byFile.has(f));
  const reserved = unreachable.filter((f) => byFile.has(f));

  return {
    root: absRoot,
    files,
    graph,
    entries,
    reachable,
    unreachable,
    unwired,
    reserved,
    cycles: findCycles(files, graph),
    unresolved,
    tests,
    testRefs: byFile,
    testDeps,
  };
}

export function findCycles(files, graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(files.map((f) => [f, WHITE]));
  const stack = [];
  const found = [];
  const seen = new Set();
  const dfs = (n) => {
    color.set(n, GRAY);
    stack.push(n);
    for (const m of graph.get(n) || []) {
      const c = color.get(m) ?? WHITE;
      if (c === GRAY) {
        const i = stack.indexOf(m);
        const cyc = [...stack.slice(i), m];
        const key = [...cyc].sort().join("|");
        if (!seen.has(key)) { seen.add(key); found.push(cyc); }
      } else if (c === WHITE) dfs(m);
    }
    stack.pop();
    color.set(n, BLACK);
  };
  for (const f of [...graph.keys()].sort()) if ((color.get(f) ?? WHITE) === WHITE) dfs(f);
  return found;
}

// 反向依赖: 谁 import 了我 (含传递闭包) + 哪些测试覆盖我。
// 改动前问"会波及谁", 改动后问"该跑哪些测试" —— 同一个索引回答。
export function impactOf(root, relFiles, { maxDependents = 30, maxTests = 8 } = {}) {
  const g = buildGraph({ root });
  const absSeed = relFiles.map((f) => path.resolve(root, f)).filter((f) => g.graph.has(f));
  const reverse = new Map();
  for (const [f, deps] of g.graph) {
    for (const d of deps) {
      if (!reverse.has(d)) reverse.set(d, []);
      reverse.get(d).push(f);
    }
  }
  const direct = new Set();
  for (const f of absSeed) for (const r of reverse.get(f) || []) direct.add(r);
  // 传递闭包 (BFS), 上限防爆
  const transitive = new Set(direct);
  const q = [...direct];
  while (q.length && transitive.size < maxDependents * 4) {
    const f = q.pop();
    for (const r of reverse.get(f) || []) if (!transitive.has(r)) { transitive.add(r); q.push(r); }
  }
  const tests = new Set();
  for (const f of [...absSeed, ...transitive]) {
    for (const t of g.testRefs.get(f) || []) tests.add(t);
    // 同名/同前缀测试兜底 (项目约定 src/llm/fence.js ↔ test/fence*.test.js)
    const base = path.basename(f).replace(/\.[^.]+$/, "");
    for (const t of g.tests) {
      const tb = path.basename(t).replace(/\.test\.js$/, "");
      if (tb === base || tb.startsWith(base + ".") || tb.startsWith(base + "-")) tests.add(path.relative(root, t));
    }
  }
  const rel = (f) => path.relative(root, f).replace(/\\/g, "/");
  return {
    changed: absSeed.map(rel),
    directDependents: [...direct].map(rel).sort().slice(0, maxDependents),
    transitiveDependents: [...transitive].map(rel).sort().slice(0, maxDependents),
    relatedTests: [...tests].sort().slice(0, maxTests),
    totalDependents: transitive.size,
    totalTests: tests.size,
  };
}

// 可读的依赖清单 (给 self_audit 报告/自改上下文用)
export function summarizeGraph(g, { top = 10 } = {}) {
  const rel = (f) => path.relative(g.root, f).replace(/\\/g, "/");
  const swallowedSites = [];
  const sizes = g.files.map((f) => {
    let text = "";
    try { text = fs.readFileSync(f, "utf8"); } catch { /* 读不到按 0 */ }
    const lines = text ? text.split("\n").length : 0;
    // 静默 catch 口径与 scripts/silent-catch-guard.mjs 同源 (catch-scan.js), 禁止各写一套。
    const scan = summarizeCatchScan(text, rel(f));
    for (const x of scan.sites) {
      if (!x.swallowed) continue;
      swallowedSites.push({ file: rel(f), line: x.line, fn: x.fn, critical: x.critical, reason: x.criticalReason });
    }
    return {
      file: rel(f),
      lines,
      bytes: Buffer.byteLength(text),
      silentCatches: scan.empty,
      criticalSilentCatches: scan.criticalEmpty,
      loggedCatches: scan.logged,
      swallowedCatches: scan.swallowed,
      criticalSwallowedCatches: scan.criticalSwallowed,
      acknowledgedCatches: scan.acknowledged,
      criticalAcknowledgedCatches: scan.criticalAcknowledged,
      expiredAcks: scan.expiredAcks,
      criticalExpiredAcks: scan.criticalExpiredAcks,
      undatedAcks: scan.undatedAcks,
      criticalUndatedAcks: scan.criticalUndatedAcks,
    };
  });
  return {
    modules: g.files.length,
    edges: [...g.graph.values()].reduce((a, d) => a + d.length, 0),
    entries: g.entries.length,
    reachable: g.reachable.size,
    unreachable: g.unreachable.map(rel),
    reserved: g.reserved.map(rel),
    unwired: g.unwired.map(rel),
    cycles: g.cycles.map((c) => c.map(rel)),
    unresolved: g.unresolved,
    largest: [...sizes].sort((a, b) => b.lines - a.lines).slice(0, top),
    silentCatchHotspots: sizes.filter((s) => s.lines > 80)
      .map((s) => ({ ...s, perKLine: Number((s.silentCatches * 1000 / s.lines).toFixed(1)) }))
      .sort((a, b) => b.perKLine - a.perKLine).slice(0, top),
    totalLines: sizes.reduce((a, s) => a + s.lines, 0),
    swallowedSites,
    catchTotals: {
      empty: sizes.reduce((a, s) => a + s.silentCatches, 0),
      criticalEmpty: sizes.reduce((a, s) => a + s.criticalSilentCatches, 0),
      logged: sizes.reduce((a, s) => a + s.loggedCatches, 0),
      swallowed: sizes.reduce((a, s) => a + s.swallowedCatches, 0),
      criticalSwallowed: sizes.reduce((a, s) => a + s.criticalSwallowedCatches, 0),
      acknowledged: sizes.reduce((a, s) => a + s.acknowledgedCatches, 0),
      criticalAcknowledged: sizes.reduce((a, s) => a + s.criticalAcknowledgedCatches, 0),
      expiredAcks: sizes.reduce((a, s) => a + s.expiredAcks, 0),
      criticalExpiredAcks: sizes.reduce((a, s) => a + s.criticalExpiredAcks, 0),
      undatedAcks: sizes.reduce((a, s) => a + s.undatedAcks, 0),
      criticalUndatedAcks: sizes.reduce((a, s) => a + s.criticalUndatedAcks, 0),
    },
  };
}
