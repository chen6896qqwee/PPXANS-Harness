#!/usr/bin/env node
// scripts/arch-guard.js - 模块分层依赖守卫 (零依赖)
//
// 为什么需要 (2026-10-07 评估报告 P1-6):
//   src/ 下有 33 个顶层模块目录。分层是否单向、有没有环, 目前**只靠 review 人工保证** ——
//   而人工保证的真实含义是"没人检查"。依赖环一旦形成, 表现是改一处炸一片、测试顺序敏感、
//   循环 import 拿到半初始化的 undefined, 且往往在几周后才以某个诡异 bug 的形式暴露。
//
// 做法: 静态解析 import 语句 → 建"顶层目录级"依赖图 → 断言两件事:
//   ① 无环 (环 = 模块边界事实上不存在)
//   ② 分层单向: 高层可以依赖低层, 低层不得反向依赖高层 (layer 数值小的不得 import 大的)
//
// 用法:
//   node scripts/arch-guard.js          # 报告 (列出违规, 有环即非零退出)
//   node scripts/arch-guard.js --check  # CI 闸门模式 (环 + 新增违规都红)
//   node scripts/arch-guard.js --graph  # 打印依赖边
//
// 基线机制 (关键设计): 存量违规一次性记进 ARCH_BASELINE (下面那个常量), 闸门只拦**新增**。
//   为什么不禁绝存量的: 33 个模块的存量越层不是今天能一次理清的, 而"全红"的闸门等于
//   没有闸门 (第一次跑就红 → 加 || true → 永久失效)。这里要的是**棘轮**: 存量冻结,
//   只许变好不许变坏。每一条基线都写了理由, 谁能清掉就直接从表里删掉。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const GRAPH = argv.includes("--graph");

// ---- 分层: 数值越小越底层。低层不得 import 高层 ----
// 注: mcp 标 L3 —— 它是"把已注册工具暴露成标准协议"的层, 天然在 tools 之上
//   (src/mcp/server.js 直接消费 ToolCatalog), 这是事实而不是缺陷。
// 注: plugin 标 L4 —— 它是装配器 (builtin.js 几乎 import 全世界的模块)。但 plugin/index.js
//   同时又是 DI 容器 (Context/compose/loadPlugins), 只依赖 utils, 语义上属 L0。
//   同一个目录里装了两层东西, 这是真实的历史债: 拆开要把容器下沉到 core, 属独立重构窗口。
const LAYERS = {
  utils: 0, protocol: 0, seam: 0,
  core: 1, config: 1, llm: 1, bus: 1,
  memory: 2, permissions: 2, audit: 2, evidence: 2, evolve: 2,
  ans: 2, session: 2, skills: 2, security: 2, edit: 2,
  review: 2, repomap: 2, selfheal: 2, wiki: 2, hooks: 2, commands: 2, persona: 2,
  // channels 标 L3: 它既提供 HTTP/WebSocket 接入, 也承载 MCP over HTTP (依赖 mcp), 是与
  //   mcp 同层的"对外接入层", 不是被工具层调用的内部设施。
  tools: 3, orchestrator: 3, services: 3, agent: 3, mode: 3, mcp: 3, channels: 3,
  plugin: 4,
};

// ---- 存量越层基线 (冻结, 只许减少不许增加) ----
// 每条都写清"为什么现在存在"与"清掉它需要什么", 免得变成没人敢动的死表。
const ARCH_BASELINE = [
  // { from, to, why }
  {
    from: "agent", to: "plugin",
    why: "plugin/ 目录里同时装着 DI 容器 (index.js, 只依赖 utils, 应属 L0) 与装配器 (builtin.js/v3.js, 依赖几乎全部模块, 属 L4)。agent 用的是容器那半边, 但目录粒度分不开。清掉它要把 Context/compose/loadPlugins 下沉到 src/core/, 属独立重构窗口。",
  },
];

function listJs(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith(".js")) out.push(fp);
    }
  })(dir);
  return out;
}

// 顶层模块名: src/xxx/... → xxx; src/xxx.js → xxx (单文件模块)
function moduleOf(file) {
  const rel = path.relative(SRC, file).split(path.sep);
  return rel.length > 1 ? rel[0] : path.basename(rel[0], ".js");
}

// 抽 import/export-from 的相对路径目标
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
const BARE_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function importsOf(file) {
  const s = fs.readFileSync(file, "utf8");
  const found = [];
  for (const re of [IMPORT_RE, BARE_RE]) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(s))) found.push(m[1]);
  }
  return found
    .filter((spec) => spec.startsWith(".")) // 只管相对引用 (node: 内建与包引用不受本约束)
    .map((spec) => path.resolve(path.dirname(file), spec))
    .filter((p) => p.startsWith(SRC))
    .map(moduleOf);
}

// ---- 建图 ----
const files = listJs(SRC);
const edges = new Map(); // from -> Set<to>
for (const f of files) {
  const from = moduleOf(f);
  if (!edges.has(from)) edges.set(from, new Set());
  for (const to of importsOf(f)) if (to !== from) edges.get(from).add(to);
}

if (GRAPH) {
  console.log("=== 模块依赖边 (顶层目录级) ===");
  for (const [from, tos] of [...edges.entries()].sort()) {
    console.log(`  ${from.padEnd(14)} → ${[...tos].sort().join(", ")}`);
  }
  console.log("");
}

// ---- ① 环检测 (DFS 三色标记) ----
function findCycles() {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...edges.keys()].map((k) => [k, WHITE]));
  const cycles = [];
  const stack = [];
  const dfs = (n) => {
    color.set(n, GRAY);
    stack.push(n);
    for (const m of edges.get(n) || []) {
      if (!color.has(m)) { color.set(m, WHITE); }
      const c = color.get(m) ?? WHITE;
      if (c === GRAY) {
        const i = stack.indexOf(m);
        cycles.push([...stack.slice(i), m]);
      } else if (c === WHITE) dfs(m);
    }
    stack.pop();
    color.set(n, BLACK);
  };
  for (const n of [...edges.keys()].sort()) if ((color.get(n) ?? WHITE) === WHITE) dfs(n);
  return cycles;
}

// ---- ② 越层检测 ----
function findViolations() {
  const out = [];
  for (const [from, tos] of edges.entries()) {
    const lf = LAYERS[from];
    if (lf === undefined) continue; // 未登记模块不参与判定 (新模块先登记再谈约束)
    for (const to of tos) {
      const lt = LAYERS[to];
      if (lt === undefined) continue;
      if (lt > lf) out.push({ from, to, fromLayer: lf, toLayer: lt });
    }
  }
  return out.sort((a, b) => (a.from < b.from ? -1 : 1));
}

const cycles = findCycles();
const violations = findViolations();
const baselineKey = (v) => `${v.from}->${v.to}`;
const baselineSet = new Set(ARCH_BASELINE.map((b) => `${b.from}->${b.to}`));
const fresh = violations.filter((v) => !baselineSet.has(baselineKey(v)));
const staleBaseline = ARCH_BASELINE.filter((b) => !violations.some((v) => baselineKey(v) === `${b.from}->${b.to}`));

console.log("=== 架构守卫 ===");
console.log(`  模块数: ${edges.size}    依赖边: ${[...edges.values()].reduce((a, s) => a + s.size, 0)}`);
console.log(`  依赖环: ${cycles.length}`);
for (const c of cycles.slice(0, 10)) console.log(`    🔴 ${c.join(" → ")}`);
console.log(`  越层依赖: ${violations.length} (基线内 ${violations.length - fresh.length}, 新增 ${fresh.length})`);
for (const v of fresh.slice(0, 20)) console.log(`    🟠 ${v.from}(L${v.fromLayer}) → ${v.to}(L${v.toLayer})`);
if (staleBaseline.length) {
  console.log(`  ⚪ 基线里已不存在的违规 (可清理): ${staleBaseline.map((b) => `${b.from}->${b.to}`).join(", ")}`);
}

let bad = 0;
if (cycles.length) { console.error("\n  ✗ 存在依赖环 —— 模块边界事实上不成立"); bad++; }
if (CHECK && fresh.length) { console.error(`\n  ✗ 新增 ${fresh.length} 条越层依赖 (存量已冻结在基线, 新增一律不放过)`); bad++; }

console.log(bad ? "" : "\n  ✓ 架构守卫通过");
process.exit(bad ? 1 : 0);
