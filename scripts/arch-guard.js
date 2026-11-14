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
import { walkJs } from "./lib/walk-js.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const GRAPH = argv.includes("--graph");

// ---- 分层: 数值越小越底层。低层不得 import 高层 ----
// 注: mcp 标 L3 —— 它是"把已注册工具暴露成标准协议"的层, 天然在 tools 之上
//   (src/mcp/server.js 直接消费 ToolCatalog), 这是事实而不是缺陷。
// 注: plugin 标 L0 (2026-11-08 归位) —— 此前该目录同时装着 DI 容器 (index.js/context.js,
//   只依赖 utils) 与装配器 (builtin.js/v3.js, 依赖几乎全部模块, 标 L4), 同目录混两层,
//   全仓唯一的 agent→plugin 越层基线因此存在。装配器已搬去 src/agent/plugins/ (随 agent 层),
//   容器留在这里降为纯 L0, 基线清零。
const LAYERS = {
  utils: 0, protocol: 0, seam: 0, plugin: 0,
  // boot 标 L0 (2026-11-12 登记): 控制台 UTF-8 / 启动横幅 / 全局异常兜底是入口外壳,
  //   只依赖 utils; 从 utils 迁出后内核不必再为"启动时的一次性代码"付预算。
  boot: 0,
  core: 1, config: 1, llm: 1, bus: 1,
  memory: 2, permissions: 2, audit: 2, evidence: 2, evolve: 2,
  ans: 2, session: 2, skills: 2, security: 2, edit: 2,
  // verify 标 L2 (2026-11-12 登记): 回合后置条件闸门/声称核对/路径证据是"验证域",
  //   为 tools(L3) 与 selfcode(L2) 共用; 从 core(L1) 迁出后内核只留跨层原语,
  //   同时避免 tools → core 的领域级反向依赖。
  verify: 2,
  // 2026-11-12 碎片收敛: persona→memory / wiki→repomap / review→verify / commands→agent /
  //   selfheal→evolve / mode→agent/modes / planning→session / update→services / desktop→services,
  //   这些顶层名不再存在, 分层表随目录一并删除。
  repomap: 2, hooks: 2,
  // workgraph 标 L2 (2026-11-02 登记): 工单账本只依赖 node 内置模块, 由 channels(L3)/agent(L3)
  //   注入调用; 自身不认识 legion/delivery, 避免 账本 ↔ 编排/通道 的双向依赖。
  workgraph: 2,
  // flow 标 L2 (2026-11-02 登记): 原生入站流 (Trigger/两级准入/决策内核) 只依赖 utils 与
  //   workgraph 的只读状态, 是传输层 (channels L3) 与执行层 (agent L3) 共同的下游语义;
  //   它不认识 HTTP/飞书/微信, 也不发送消息。
  flow: 2,
  // channels 标 L3: 它既提供 HTTP/WebSocket 接入, 也承载 MCP over HTTP (依赖 mcp), 是与
  //   mcp 同层的"对外接入层", 不是被工具层调用的内部设施。
  // web 标 L3 (2026-10-31 登记): 本体形态 Web API (bot-api/plugin-api/usage-stats), 与 channels
  //   同为对外接入层; 目前只依赖 utils, 提前登记防止未来盲区 (新模块先登记再谈约束)。
  tools: 3, orchestrator: 3, services: 3, agent: 3, mcp: 3, channels: 3, web: 3,
};

// ---- 存量越层基线 (冻结, 只许减少不许增加) ----
// 每条都写清"为什么现在存在"与"清掉它需要什么", 免得变成没人敢动的死表。
// 2026-11-08 清零: 曾有唯一一条 agent→plugin (plugin/ 混装容器+装配器所致);
//   装配器搬去 src/agent/plugins/ 后该越层不再存在。
const ARCH_BASELINE = [
  // { from, to, why }
];

function listJs(dir) {
  const out = [];
  walkJs(dir, (fp) => out.push(fp));
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

// ---- 内核行数预算 (2026-10-08, 轻内核路线图缺口 1) ----
// 愿景: "内核代码尽量少, 每一行都需要有充分理由"。行数不设闸 = 每次往内核塞东西都
// 无人报警, 轻内核会静默退化成胖内核。规则: 四个内核目录 (core/plugin/utils/config)
// 各有预算上限, 超限只告警不拦 (记录漂移趋势), 超限 20% 以上才失败 —— 给合理的演进
// 留出缓冲, 但让"塞东西进内核"这个动作必须先改这里的预算数字 (显式决策 > 静默膨胀)。
// 预算基线 = 2026-10-08 实测值取整上浮 (core 1205 / plugin 575 / utils 957 / config 856)。
// 2026-10-11 上调 src/utils 1100 → 1400: 实测 1332。增长来自通用基础设施的自然补齐
//   (代理转发 / 轨迹 / 限流 / 脱敏 / 预写日志), 非业务逻辑塞入; 且 arch-guard 按目录计,
//   目录内再拆也不减总量, 故显式上调并冻结 —— 再涨须再次决策。
// 2026-10-31 上调 src/utils 1400 → 1750: 实测 1707。本次是**搬移不是增长** —— 收编
//   orchestrator/session-key.js (94 行纯函数, 零依赖) 以消除 ans(L2)→orchestrator(L3) 的
//   新增越层依赖; 全仓总行数不变, 会话键属通用基础设施, utils 是其自然归属。
// 2026-11-02 上调 src/plugin 650 → 880: 实测 795。增长全部来自插件信任边界加固 ——
//   capabilities 白名单/清单形状校验/realpath 越界检查/未知能力 fail-closed 与管理 API 同源校验。
//   这是安全代码而非业务逻辑; 能力契约本体已下沉到 protocol(L0), 避免 web(L3)→plugin(L4) 越层。
// 2026-11-03 显式上调 src/core 1300 → 1500 (实测 1462)、src/config 950 → 1050 (实测 1010)。
//   这是"老实调预算"而不是拆解, 理由: 两处超限都是内核职责内的安全/治理代码 ——
//   core 被工具循环治理 (policy 676 行: 探索熔断/重复检测/溢出降档/错误重试/结果裁剪)
//   与后置条件校验 (postcondition 607 行) 占满; config 被 provider/通道/设置校验占满。
//   目录内再拆不减少总量, 拆出目录又会破坏分层归属 (core 是 L1, 不能再往 L0 塞业务)。
//   上调后 core 97% / config 96%, 再涨须重新决策。
// 2026-11-03 上调 src/utils 1750 → 1850 (实测 1800): 关键路径 catch 留痕的读取端 ——
//   catch-log 增加调用点定位/溢出计数/聚合统计, 让"只写不读"的留痕真正能被 shutdown 与
//   /health 看见。这是观测基础设施, 不是业务逻辑; 目录内再拆不减总量。
// 2026-11-05 显式上调 src/config 1050 → 1400 (实测 1339): DSH 吸收 Step 5a 新增
//   ans_lane.v1 配置归一化 (src/config/ans-lane.js, 288 行) —— 24 个叶子键的版本/来源/
//   mode↔create_ticket/数值夹取/目标净化/安全不变量, 全部是启动期安全治理, 属 config 内核职责。
//   不能移到 src/ans (L2): config 是 L1, 反向依赖会破分层; 目录内再拆也不减总量。
//   上调后 96%, 再涨须重新决策。
// 2026-11-08 下调 src/plugin 880 → 400 (实测 264): L4 装配器 (builtin.js 427 + v3.js 93)
//   搬去 src/agent/plugins/, plugin/ 只剩纯 L0 容器 (context.js 93 + index.js 171)。
//   这是搬移不是增长, 预算回落并留出容器演进的缓冲。
const KERNEL_BUDGET = {
  // 2026-11-12 重新标定 (内核减重后按"当前实际 + 适度余量"收紧, 防止删掉的重量悄悄长回来):
  //   core 1552→178 行 (验证域迁 verify/, 工具循环迁 agent/loop/), 预算 1500→400;
  //   utils 2113→1529 行 (出站网络迁 security/, 启动外壳迁 boot/), 预算 1850→1650;
  //   plugin 未变, 预算 400→320 (当前 266 行)。
  "src/core": 400,
  "src/plugin": 320,
  "src/utils": 1650,
  "src/config": 1400,
};
function dirLines(dir) {
  let n = 0;
  walkJs(dir, (p) => { n += fs.readFileSync(p, "utf8").split("\n").length; });
  return n;
}
console.log("\n  --- 内核行数预算 (轻内核缺口 1) ---");
for (const [dir, budget] of Object.entries(KERNEL_BUDGET)) {
  const n = dirLines(path.join(ROOT, dir));
  const pct = Math.round((n / budget) * 100);
  const mark = pct <= 100 ? "✓" : pct <= 120 ? "△" : "✗";
  console.log(`  ${mark} ${dir}: ${n} 行 / 预算 ${budget} (${pct}%)`);
  if (pct > 120) { console.error(`    超预算 20% —— 塞进内核的功能必须重新评估 (拆到插件/技能层, 或显式上调预算)`); bad++; }
}

console.log(bad ? "" : "\n  ✓ 架构守卫通过");
process.exit(bad ? 1 : 0);
