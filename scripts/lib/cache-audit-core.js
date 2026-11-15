#!/usr/bin/env node
// scripts/lib/cache-audit-core.js - Provider 前缀缓存完整性审计的可复用逻辑 (scripts/cache-audit.js 与 test 共用)
// 背景 (2026-10-05, prompts.js _context 重排): 系统提示词按"静态块在前, 随 userMsg 的检索段在后"
// 组装, 为的是 provider 侧 prompt caching —— provider 只匹配**最长公共前缀**。重排本身的收益
// 完全依赖"静态前缀逐字节稳定"这一不变量: 一个时间戳 / 每会话 id / 随机值 / 绝对临时路径 /
// 向上漂移的记忆检索文本混进静态区, 缓存收益即对后续所有请求悄悄失效, 且没有任何 CI 信号。
// 本模块把该不变量做成可测的四个检查:
//   (a) static_prefix_stability  静态区字节跨请求恒定 (跨"仅 userMsg 不同"的请求)
//   (b) volatile_isolation       静态边界之前无时间戳/日期/随机/mkdtemp/临时路径/检索文本
//                                (四个互补子方法: 模式扫描 + 会话内 diff + 双独立实例 diff +
//                                 学习→重启 因果探针; 单用任一种都存在假通过空间)
//   (c) tool_array_canonicality  tools 数组序列化跨请求/跨实例恒定 (并观测是否名称规范序)
//   (d) append_only_history      轮内严格追加; 跨轮历史只延长不改写 (钉住"错误重试不改历史"规则)
// 2026-11-03 拆分: 纯文本分析 → cache-audit-text.js, 抓请求/探针 → cache-audit-capture.js,
// 本文件只留"分类 + 四个检查 + 度量"编排; 对外导出面与拆分前完全一致 (调用方/测试无需改)。
import path from "node:path";
import { PROJECT_ROOT, estTokens, lcpChars, blockLabelAt, volatileHits } from "./cache-audit-text.js";
import { captureSession, memoryDriftProbe } from "./cache-audit-capture.js";

// 对外口径保持: 拆分前从本模块导出的名字全部原样 re-export
export {
  PROJECT_ROOT, estTokens, lcpChars, serializeRequest, locateStaticTail,
  describeOffset, blockLabelAt, volatileHits,
} from "./cache-audit-text.js";
export {
  SCRIPT_TURNS, captureSession, PROBE_TURNS, PROBE_SEED_FACT, memoryDriftProbe,
} from "./cache-audit-capture.js";

// ---- 相邻请求对的分类: 分歧落在哪个区, 是否预期 ----
function classifyPair(prev, next) {
  const pS = prev.serialized, nS = next.serialized;
  const toolStrP = pS.text.slice(pS.regions.toolsStart, pS.regions.toolsEnd);
  const toolStrN = nS.text.slice(nS.regions.toolsStart, nS.regions.toolsEnd);
  if (toolStrP !== toolStrN) {
    return { region: "tools", expected: false, offset: pS.regions.toolsStart + lcpChars(toolStrP, toolStrN),
      reason: "tools 数组在静态前缀内分叉 (目录顺序/内容变化会作废整个缓存前缀) → src/tools/catalog.js toOpenAI()" };
  }
  if (!prev.boundary.ok || !next.boundary.ok) {
    return { region: "system", expected: false, offset: pS.regions.sysStart,
      reason: prev.boundary.note || next.boundary.note };
  }
  if (pS.system !== nS.system) {
    const local = lcpChars(pS.system, nS.system);
    const se = Math.min(prev.boundary.staticEnd, next.boundary.staticEnd);
    if (local < se) {
      return { region: "system.static", expected: false, offset: pS.regions.sysStart + local, staticEnd: se,
        reason: "静态区内分叉 @system+" + local + " (区块: " + blockLabelAt(nS.system, local) + ") —— 缓存前缀回归" };
    }
    return { region: "system.tail", expected: true, offset: pS.regions.sysStart + local, staticEnd: se,
      reason: "分歧在尾部检索段 (memory/scene, 随 userMsg 变化, 属预期): @system+" + local + " >= 静态边界 " + se };
  }
  // system 相同 (同轮多圆 / 检索段恰好一致): 逐条消息比对
  const pm = prev.messages, nm = next.messages;
  const firstNonSysP = pm.findIndex((m) => m.role !== "system");
  const firstNonSysN = nm.findIndex((m) => m.role !== "system");
  const pConv = pm.slice(firstNonSysP < 0 ? pm.length : firstNonSysP);
  const nConv = nm.slice(firstNonSysN < 0 ? nm.length : firstNonSysN);
  let j = 0;
  while (j < pConv.length && j < nConv.length && JSON.stringify(pConv[j]) === JSON.stringify(nConv[j])) j++;
  if (j >= pConv.length) {
    return { region: "messages.append", expected: true, offset: 0, appended: nConv.length - pConv.length,
      reason: "历史纯追加 (" + (nConv.length - pConv.length) + " 条新消息), 旧消息 0.." + (j - 1) + " 逐条全等" };
  }
  return { region: "messages.rewrite", expected: false, offset: 0, msgIndex: j,
    reason: "第 " + j + " 条既有消息被改写 (违反 append-only: 错误重试/降档不得重写历史)" };
}

// ---- 全量审计: 四个命名检查 + 前缀经济学度量 ----
export function auditCaptures(captures, { second = null, drift = null, projectRoot = PROJECT_ROOT } = {}) {
  const checks = [];
  const pairs = [];
  const base = captures[0];
  const baseStatic = base && base.system != null ? base.system.slice(0, base.boundary.staticEnd) : "";

  for (let i = 1; i < captures.length; i++) {
    const prev = captures[i - 1], next = captures[i];
    const cls = classifyPair(prev, next);
    const charLcp = lcpChars(prev.serialized.text, next.serialized.text);
    pairs.push({
      from: i - 1, to: i,
      sameTurn: prev.turn === next.turn,
      turnBoundary: prev.turn !== next.turn,
      lcpChars: charLcp,
      lcpTokens: estTokens(prev.serialized.text.slice(0, charLcp)),
      tailChars: next.serialized.text.length - charLcp,
      tailTokens: estTokens(next.serialized.text.slice(charLcp)),
      ...cls,
    });
  }

  // (a) 静态前缀稳定性: 每对相邻请求的分歧不得早于静态边界; 静态区各请求逐字节等于基准
  const staticMismatches = [];
  captures.forEach((c, i) => {
    if (!c.boundary.ok) { staticMismatches.push({ req: i, why: c.boundary.note }); return; }
    const st = c.system.slice(0, c.boundary.staticEnd);
    if (st !== baseStatic || c.boundary.staticEnd !== base.boundary.staticEnd) {
      const off = lcpChars(st, baseStatic);
      staticMismatches.push({ req: i, at: off, block: blockLabelAt(c.system, off),
        sample: JSON.stringify(c.system.slice(Math.max(0, off - 40), off + 40)) });
    }
  });
  const breaksStatic = pairs.filter((p) => !p.expected && (p.region === "system.static" || p.region === "system" || p.region === "tools"));
  checks.push({
    id: "static_prefix_stability",
    name: "(a) 静态前缀稳定性",
    pass: staticMismatches.length === 0 && breaksStatic.length === 0 && captures.length >= 3,
    detail: staticMismatches.length === 0 && breaksStatic.length === 0
      ? captures.length + " 个捕获请求, " + pairs.length + " 对相邻请求: 静态区逐字节恒定, 无跨静态区分叉"
      : "静态区分叉: " + JSON.stringify(staticMismatches.length ? staticMismatches : breaksStatic).slice(0, 400),
    mismatches: staticMismatches,
  });

  // (b) 易变值隔离: 扫描 + 会话内 diff + 双实例 diff (三法互补, 单一方法都可能假通过)
  const hits = captures.length ? volatileHits(baseStatic, { projectRoot }) : [];
  const b1 = checks[0].pass; // 会话内静态区跨请求恒定 (含"检索文本向上漂移"——漂移必然破坏恒定)
  let b3 = { pass: true, detail: "未提供第二实例 (跨实例 diff 未执行)" };
  if (second && second.length) {
    const sBase = second[0];
    const sStatic = sBase.system != null ? sBase.system.slice(0, sBase.boundary.staticEnd) : "";
    if (sStatic === baseStatic && sBase.boundary.staticEnd === base.boundary.staticEnd) {
      b3 = { pass: true, detail: "双独立实例 (不同 mkdtemp dataDir) 静态区逐字节一致" };
    } else {
      const off = lcpChars(baseStatic, sStatic);
      b3 = { pass: false, detail: "跨实例静态区差异 @+" + off + " (区块: " + blockLabelAt(sBase.system, off) + ") 样例B=" +
        JSON.stringify(sBase.system.slice(Math.max(0, off - 30), off + 50)) + " 样例A=" +
        JSON.stringify(baseStatic.slice(Math.max(0, off - 30), off + 50)) };
    }
  }
  const bFails = [];
  if (hits.length) bFails.push("静态区命中易变模式: " + hits.map((h) => h.id + "@" + h.at
    + " 区块[" + blockLabelAt(baseStatic, h.at) + "] 样例" + JSON.stringify(h.sample)).join("; "));
  if (!b1) bFails.push("会话内静态区随请求变化 (含检索文本漂移)");
  if (!b3.pass) bFails.push(b3.detail);
  if (drift && drift.ran && !drift.pass) bFails.push(drift.detail);
  checks.push({
    id: "volatile_isolation",
    name: "(b) 易变值隔离",
    pass: bFails.length === 0,
    detail: bFails.length ? bFails.join(" | ")
      : "扫描(时间戳/日期/时钟/epoch/mkdtemp/uuid/临时路径)零命中; 会话内静态区恒定; " + b3.detail
        + "; " + (drift && drift.ran ? drift.detail : "学习→重启 探针未执行"),
    subs: { scan: hits, withinSession: b1, crossInstance: b3, learnRelaunch: drift || { ran: false, pass: true, detail: "未执行" } },
  });
  // 观察项 (不计入失败): workspace 区块把进程工作根打进静态区 —— prompts.js 明示"root 每进程恒定"
  const rootInStatic = baseStatic.includes(path.resolve(projectRoot));
  if (rootInStatic) {
    checks.push({
      id: "static_region_root_path",
      name: "(b·观测) 静态区含工作根绝对路径",
      pass: true, warn: true,
      detail: "【工作目录】区块 (src/agent/prompts.js _workspacePrompt) 把进程工作根逐字写入静态区: 会话内恒定, "
        + "不伤进程内前缀缓存; 但跨机器/跨工作目录的会话前缀不同 → provider 缓存不共享。设计决策 (prompts.js 注释), 不判失败。",
    });
  }

  // (c) 工具数组规范性: 同会话跨请求恒定 + 双实例恒定; 顺带观测是否名称规范序
  const toolStrs = captures.map((c) => JSON.stringify(c.tools));
  const toolsStable = toolStrs.every((s) => s === toolStrs[0]);
  let crossAgentSame = null;
  if (second && second.length) crossAgentSame = JSON.stringify(second[0].tools) === toolStrs[0];
  const names = (captures[0] ? captures[0].tools : []).map((t) => t.function.name);
  const isAlphaSorted = JSON.stringify(names) === JSON.stringify([...names].sort());
  const regOrder = (captures[0] && base && names.length) ? JSON.stringify(names) : "";
  checks.push({
    id: "tool_array_canonicality",
    name: "(c) 工具数组恒定/规范",
    pass: toolsStable && crossAgentSame !== false,
    detail: (toolsStable
      ? "会话内 " + toolStrs.length + " 个请求 tools 序列化逐字节一致"
      : "tools 数组在会话内发生变化! 观测序A=" + JSON.stringify(names)
        + " —— 源: src/tools/catalog.js toOpenAI() 的 [...this.tools.values()] (Map 插入序), 它在请求最前, 变化即作废整个缓存前缀")
      + (crossAgentSame == null ? "" : crossAgentSame ? "; 双独立实例 tools 逐字节一致" : "; 双独立实例 tools 不一致 —— 源: src/tools/catalog.js toOpenAI() (Map 插入序受注册时序影响)")
      + "; 是否名称规范序: " + (isAlphaSorted ? "是" : "否 (= Map 注册序, 依赖装配顺序恒定; 见 src/tools/catalog.js toOpenAI() 的 [...this.tools.values()])"),
    order: names, canonicalByName: isAlphaSorted, stable: toolsStable && crossAgentSame !== false,
    _regOrderRef: regOrder,
  });

  // (d) append-only 历史:
  //   d1 轮内 (同一 chat() 的连续工具圆): 完整消息列表严格前缀 (逐条 deep-equal) —— 钉住
  //      "错误重试/注入方向盘只追加不改写" (src/core/policy.js 语义)。
  //   d2 跨轮 (每轮首个请求): 非 system 部分须逐条延续上一轮首个请求 (会话日志 append-only 投影)。
  //   注: 跨轮"完整列表前缀"本就不成立 —— system 尾部检索段随 userMsg 变化 + 工具圆中间消息
  //      (assistant.tool_calls / tool 结果) 不落会话日志, 下一轮投影只剩 user/assistant 定稿。
  //      这是设计使然而非改写, 故 d2 只比非 system 且比"轮首→轮首"。诚实标注检查范围。
  const d1Fails = [];
  for (let i = 1; i < captures.length; i++) {
    const prev = captures[i - 1], next = captures[i];
    if (prev.turn !== next.turn || prev.turn < 0) continue;
    if (next.messages.length < prev.messages.length) { d1Fails.push({ pair: i - 1 + "→" + i, why: "消息数缩水 (疑似溢出降档改写)" }); continue; }
    for (let j = 0; j < prev.messages.length; j++) {
      if (JSON.stringify(prev.messages[j]) !== JSON.stringify(next.messages[j])) {
        d1Fails.push({ pair: i - 1 + "→" + i, msgIndex: j, why: "既有消息被改写" });
        break;
      }
    }
  }
  const firstOfTurn = new Map();
  for (const c of captures) if (c.round === 1 && !firstOfTurn.has(c.turn)) firstOfTurn.set(c.turn, c);
  const turnIds = [...firstOfTurn.keys()].sort((a, b) => a - b);
  const d2Fails = [];
  for (let k = 1; k < turnIds.length; k++) {
    const prev = firstOfTurn.get(turnIds[k - 1]), next = firstOfTurn.get(turnIds[k]);
    const pConv = prev.messages.filter((m) => m.role !== "system");
    const nConv = next.messages.filter((m) => m.role !== "system");
    for (let j = 0; j < pConv.length; j++) {
      if (j >= nConv.length || JSON.stringify(pConv[j]) !== JSON.stringify(nConv[j])) {
        d2Fails.push({ pair: "turn" + turnIds[k - 1] + "→" + turnIds[k], msgIndex: j, why: "上一轮历史在下一轮请求中被改写/丢弃" });
        break;
      }
    }
  }
  const toolRoundSeen = captures.some((c) => c.messages.some((m) => m.role === "tool"));
  checks.push({
    id: "append_only_history",
    name: "(d) 历史 append-only",
    pass: d1Fails.length === 0 && d2Fails.length === 0,
    detail: d1Fails.length + d2Fails.length === 0
      ? "轮内严格追加 (" + pairs.filter((p) => p.sameTurn).length + " 对) + 跨轮历史只延长 (" + Math.max(0, turnIds.length - 1) + " 对); 含工具往返: " + (toolRoundSeen ? "是" : "否")
      : "违反 append-only: " + JSON.stringify({ d1Fails, d2Fails }).slice(0, 400),
    scopeNote: "跨轮完整列表前缀按设计不成立 (system 动态尾 + 工具中间消息不入日志), d2 只比非 system 轮首→轮首",
  });

  // ---- 前缀经济学: 稳定前缀 vs 每请求重计费尾部 ----
  const turnBoundaryPairs = pairs.filter((p) => p.turnBoundary);
  const stablePrefixChars = turnBoundaryPairs.length
    ? Math.min(...turnBoundaryPairs.map((p) => p.lcpChars))
    : (pairs.length ? Math.min(...pairs.map((p) => p.lcpChars)) : 0);
  const rebilledAvg = turnBoundaryPairs.length
    ? Math.round(turnBoundaryPairs.reduce((a, p) => a + p.tailChars, 0) / turnBoundaryPairs.length)
    : 0;
  const toolsChars = base ? base.serialized.regions.toolsEnd - base.serialized.regions.toolsStart : 0;
  const metrics = {
    captures: captures.length,
    requestsPerTurn: turnIds.reduce((m, t) => m + captures.filter((c) => c.turn === t).length, 0),
    staticChars: base ? base.boundary.staticEnd : 0,
    staticTokens: estTokens(baseStatic),
    toolsChars,
    toolsTokens: estTokens(base ? base.serialized.text.slice(base.serialized.regions.toolsStart, base.serialized.regions.toolsEnd) : ""),
    stablePrefixChars,
    stablePrefixTokens: estTokens(base ? base.serialized.text.slice(0, stablePrefixChars) : ""),
    rebilledTailCharsAvg: rebilledAvg,
    rebilledTailTokensAvg: turnBoundaryPairs.length
      ? Math.round(turnBoundaryPairs.reduce((a, p) => a + p.tailTokens, 0) / turnBoundaryPairs.length) : 0,
    pairs,
  };
  const AWS_MIN_CHECKPOINT = 512;
  metrics.verdict = "可缓存前缀 ≈ " + metrics.stablePrefixTokens + " tok (工具 " + metrics.toolsTokens
    + " + 静态提示区 " + metrics.staticTokens + "): "
    + (metrics.stablePrefixTokens >= AWS_MIN_CHECKPOINT ? "已越过" : "未越过")
    + " AWS 最小可缓存 checkpoint 512 tok"
    + (metrics.stablePrefixTokens >= 4096 ? ", 也超过最大档 4096" : metrics.stablePrefixTokens >= 1024 ? ", 且超过 1024 档" : "");
  return { checks, metrics, pairs, baseStatic };
}

// ---- 完整审计流程 (两次独立会话 + 学习→重启探针 + 检查 + 度量)。fixture 仅用于负例演示 ----
export async function runFullAudit({ fixture = null, projectRoot = PROJECT_ROOT, keepCaptures = false, driftProbe = true } = {}) {
  const run1 = await captureSession({ prefix: "cache-audit-1", fixture, projectRoot });
  const run2 = await captureSession({ prefix: "cache-audit-2", fixture, projectRoot });
  let result;
  try {
    // 探针不吃 fixture: 它验的是"真实管线里记忆内容会不会落进静态区"这一因果关系
    const drift = driftProbe ? await memoryDriftProbe({ projectRoot }) : null;
    result = auditCaptures(run1.captures, { second: run2.captures, drift, projectRoot });
    result.run2Captures = run2.captures.length;
    result.drift = drift;
    // keepCaptures: --verbose 需要相邻请求的序列化全文来打印分歧上下文 (不进 --json, 免刷屏)
    if (keepCaptures) result.capturesDetail = run1.captures;
  } finally {
    await run1.teardown();
    await run2.teardown();
  }
  return result;
}

// ---- 测试夹具 (刻意注入的破坏, 只 monkey-patch 实例, 绝不动 src/) ----
// volatile-clock: 往 persona 静态块尾贴当前时间 (任务书指定的负例形态)。
// static-drift:   经验(habits 静态块)尾部挂递增计数 —— 模拟"记忆行向上漂移"进静态区。
export const FIXTURES = {
  "volatile-clock": (agent) => {
    const p = agent.persona;
    const orig = p.systemPrompt.bind(p);
    p.systemPrompt = (userName) => orig(userName) + "\n[clock] " + new Date().toISOString();
  },
  "static-drift": (agent) => {
    const ex = agent.experience;
    const orig = ex.context.bind(ex);
    let n = 0;
    ex.context = () => orig() + "\n[drift " + ++n + "]";
  },
};
