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
// 隔离与安全: 与 scripts/bench.js 同一 stub 捕获模式 —— agent.llm/allProviders 被强制替换为
// 捕获桩, 绝不产生真实 LLM 网络调用; dataDir 恒为系统临时目录下的 mkdtemp (ctx-profile 同款:
// root 用仓库根以获得与生产一致的 persona/skills/config, 写盘全部落临时 dataDir), 清理走
// tmp-agent.js 的安全护栏 cleanupTmp (不在安全区则抛错绝不删)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../../src/agent/index.js";
import { cleanupTmp } from "./tmp-agent.js";
import { setLevel } from "../../src/utils/logger.js";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url)); // scripts/lib
export const PROJECT_ROOT = path.dirname(path.dirname(LIB_DIR)); // 项目根

// ---- token 估算: 与 scripts/ctx-profile.js 同一口径 (中文 1 字 ≈ 1 tok, 其余 4 字符 ≈ 1 tok) ----
// 两处闸门口径一致, 才能直接对照 ctx-profile 的 4500 tok 预算与 AWS 512 tok 最小 checkpoint。
export function estTokens(s) {
  const t = String(s || "");
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(cjk + (t.length - cjk) / 4);
}

// ---- 字符级最长公共前缀 ----
export function lcpChars(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i++) if (a[i] !== b[i]) break;
  return i;
}

// ---- 请求序列化: 按 provider 视角"tools 数组 → system 消息 → 会话消息"拼成一个可比字符串 ----
// 每段带区域标记, 便于把分歧偏移量映射回"哪个区/哪个区块/第几条消息"。
export function serializeRequest({ tools, messages }) {
  const msgs = messages || [];
  const toolStr = JSON.stringify(tools || []);
  let sysStr = "";
  let firstNonSystem = 0;
  while (firstNonSystem < msgs.length && msgs[firstNonSystem]?.role === "system") {
    sysStr += (sysStr ? "\n\n" : "") + String(msgs[firstNonSystem].content ?? "");
    firstNonSystem++;
  }
  let text = "TOOLS\n" + toolStr + "\nSYSTEM\n";
  const regions = {
    toolsStart: 6,
    toolsEnd: 6 + toolStr.length,
    sysStart: text.length,
    sysEnd: text.length + sysStr.length,
    msgs: [],
  };
  text += sysStr + "\nMSGS\n";
  for (let i = firstNonSystem; i < msgs.length; i++) {
    const mStr = JSON.stringify(msgs[i]);
    const start = text.length;
    text += "M#" + i + "\n" + mStr + "\n";
    regions.msgs.push({ index: i, start, end: text.length });
  }
  return { text, regions, system: sysStr, msgCount: msgs.length - firstNonSystem, toolsLen: toolStr.length };
}

// ---- 动态检索段定位: 从组装好的 system 串里算出"静态边界" ----
// _context() 的组装规则是: 静态块 + "\n\n" + memory.context(userMsg) [+ "\n\n" + scenes.activeContext()]。
// captureSession 处已把这两个检索调用包装记账 (捕获到"当次请求实际产出的动态段"), 这里做尾部校验:
//   - 若捕获到的动态段确实贴在 system 尾部 → 静态边界 = 尾部起点 (静态区 = 之前全部字节);
//   - 若贴不上 (检索段不在尾部 / 组装规则漂移) → 说明动态内容泄漏进静态区或 _context 结构变了 →
//     按失败处理并给尽调偏移。选择"校验失败=不通过"而非"猜一个边界", 杜绝静默假通过。
export function locateStaticTail(system, memoryCtx, sceneCtx) {
  if (typeof memoryCtx !== "string" || memoryCtx === "") {
    return { staticEnd: system.length, ok: false, note: "未捕获到 memory 检索段 (无法确证静态边界, 按不可证处理)" };
  }
  const tail = sceneCtx ? memoryCtx + "\n\n" + sceneCtx : memoryCtx;
  const staticEnd = system.length - tail.length;
  if (staticEnd >= 0 && system.slice(staticEnd) === tail) {
    return { staticEnd, ok: true, note: "" };
  }
  const idx = system.lastIndexOf(memoryCtx);
  if (idx === -1) {
    return { staticEnd: 0, ok: false, note: "memory 检索段未在 system 尾部且整体找不到 —— 检索内容疑似已渗入静态区或组装顺序漂移" };
  }
  return { staticEnd: idx, ok: false, note: "动态段位置与 join 规则不符 (场景段缺失或顺序漂移)" };
}

// 把"整条序列化请求里的绝对偏移"翻译回人话: 落在 tools / system 静态区 / system 动态尾 / 第几条消息。
// --verbose 与失败详情都靠它, 这样"缓存前缀在第几个字节断掉"能直接定位到区块或消息。
export function describeOffset(serialized, offset, boundary = null) {
  const r = serialized.regions;
  if (offset < r.toolsStart) return { region: "header", label: "序列化头部区段标记", local: offset };
  if (offset < r.toolsEnd) return { region: "tools", label: "tools 数组 (请求最前, 任何变动作废整个前缀)", local: offset - r.toolsStart };
  if (offset < r.sysStart) return { region: "separator", label: "tools/system 区段分隔标记", local: offset - r.toolsEnd };
  const sysLocal = offset - r.sysStart;
  if (sysLocal < r.sysEnd - r.sysStart) {
    const inStatic = boundary && boundary.ok ? sysLocal < boundary.staticEnd : true;
    return { region: "system", label: inStatic ? "system 静态区 (应逐字节恒定)" : "system 动态检索尾 (随 userMsg 变化, 预期)",
      local: sysLocal, staticEnd: boundary ? boundary.staticEnd : null };
  }
  for (const m of r.msgs) {
    if (offset >= m.start && offset < m.end) return { region: "message", label: "会话消息 #" + m.index, local: offset - m.start, msgIndex: m.index };
  }
  return { region: "tail", label: "消息列表末尾 (纯追加的起点)", local: offset - r.sysEnd };
}

// 把 system 串内的偏移映射回"最近一个区块标题", 供失败时人肉定位 (与 ctx-profile 的分节拆解同一思路)
export function blockLabelAt(systemStr, offset) {
  const head = systemStr.slice(0, Math.max(0, offset));
  const lines = head.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(【[^】]{1,30}】|#|##)\s*\S{0,24}/.exec(lines[i]);
    if (m) return lines[i].slice(0, 30);
  }
  return "(前导区: 核心价值/人格)";
}

// ---- 静态区易变值扫描 (检查 b 的扫描半边; 与双实例 diff 互补, 防"两个样本恰好相等"的假通过) ----
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export function volatileHits(staticRegion, { projectRoot = PROJECT_ROOT } = {}) {
  const hits = [];
  const patterns = [
    ["iso-timestamp", /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/],
    ["date", /\d{4}[-/]\d{1,2}[-/]\d{1,2}/],
    ["clock", /\b\d{2}:\d{2}:\d{2}\b/],
    ["epoch-ms", /\b1\d{12}\b/],
    ["mkdtemp-dir", /ppx-[a-z0-9][a-z0-9._-]*-[A-Za-z0-9]{6}\b/],
    ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ];
  for (const [id, re] of patterns) {
    const m = re.exec(staticRegion);
    if (m) hits.push({ id, at: m.index, sample: staticRegion.slice(m.index, m.index + 34) });
  }
  // os.tmpdir() 绝对路径混进静态区 = 每进程随机值 (workspace 越界/夹具泄漏级风险)。
  // 例外: 仓库根本身就位于临时目录时 (某些 CI runner), 工作目录区块合法含此前缀 → 跳过避免恒红。
  const tmp = path.resolve(os.tmpdir());
  const rootLower = path.resolve(projectRoot).toLowerCase();
  const tmpInRepo = rootLower.startsWith(tmp.toLowerCase() + path.sep.toLowerCase());
  const rootIsTmp = rootLower === tmp.toLowerCase();
  if (!tmpInRepo && !rootIsTmp) {
    const i = staticRegion.toLowerCase().indexOf(tmp.toLowerCase());
    if (i >= 0) hits.push({ id: "tmpdir-path", at: i, sample: staticRegion.slice(i, i + 40) });
  }
  return hits;
}

// ---- 捕获桩: 与 scripts/bench.js 的 stubLLM 同族, 额外把每次 apiChat 的出户载荷记账 ----
function makeCapturingStub(dyn) {
  const captures = [];
  const stub = {
    providerId: "capture-stub",
    backend: "stub", // 非 "http" → visionUserContent 原样返回字符串, 多模态链路不进图
    model: "ppx-capture-stub",
    vision: false,
    dsml: false,
    supportsNativeToolCalls: true,
    supportsStream: true,
    context_window: 128000,
    captures,
    _responses: [],
    _nextResponse() {
      return stub._responses.length ? stub._responses.shift() : { content: "[stub-fallback] 脚本外调用 (审计应报异常)" };
    },
    async apiChat(messages, opts = {}) {
      const r = stub._nextResponse();
      captures.push({
        turn: dyn.current ? dyn.current.turn : -1,
        round: dyn.current ? ++dyn.current.round : -1,
        messages: structuredClone(messages),
        tools: structuredClone(opts.tools || []),
        system: dyn.current ? dyn.current.system : null,
        memoryCtx: dyn.current ? dyn.current.memoryCtx : null,
        sceneCtx: dyn.current ? dyn.current.sceneCtx : null,
      });
      return {
        message: { role: "assistant", content: r.content ?? null, tool_calls: r.tool_calls ?? null },
        usage: null,
      };
    },
    // 辅助链路 (记忆提炼/摘要等) 走 chat: 返回固定无 JSON 文本, 解析失败自然降级, 不进 captures
    async chat() { return { content: "[stub-aux]" }; },
    async streamChat() { return "[stub-aux]"; },
  };
  return stub;
}

// ---- 脚本化多轮会话 (≥3 真实请求载荷, 含一次工具往返) ----
// 消息刻意避开 _localIntent 的本地命中模式 (问候/时间/读文件 X/记住 X/关于 X), 保证每轮都真出 LLM 请求。
export const SCRIPT_TURNS = [
  {
    user: "帮我梳理一下这个仓库的模块结构",
    replies: ["[stub] 模块梳理: src/agent 为核心, src/tools 为能力层, src/memory 分层承载。"],
  },
  {
    user: "请用工具读取 config/ppx.json, 概述其中的 provider 配置",
    replies: [
      { toolCalls: [{ id: "audit-call-1", name: "read_file", args: { path: "config/ppx.json" } }] },
      "[stub] 已读取 config/ppx.json: 一个 OpenAI 兼容 http provider。",
    ],
  },
  {
    user: "上面那次工具调用读到的内容一句话概括",
    replies: ["[stub] 一段 provider 接入配置。"],
  },
];

function buildResponses(turns) {
  const out = [];
  for (const t of turns) {
    for (const r of t.replies) {
      if (typeof r === "string") out.push({ content: r });
      else if (r && r.toolCalls) {
        out.push({
          content: r.content ?? "",
          tool_calls: r.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
          })),
        });
      } else out.push({ content: "[stub]" });
    }
  }
  return out;
}

/**
 * 构建隔离 agent + 捕获桩, 驱动脚本化多轮会话, 返回逐请求的真实出户载荷。
 * @param {object} o
 * @param {Array}  o.turns    脚本轮次 (默认 SCRIPT_TURNS)
 * @param {string} o.prefix   mkdtemp dataDir / sessionKey 前缀 (双实例 diff 时用不同前缀)
 * @param {(agent:object, ctx:object)=>void} [o.fixture] 测试夹具钩子 (只允许 monkey-patch, 禁改生产源码)
 * @param {string} [o.projectRoot] agent 工作根 (默认仓库根; persona/skills/config 与生产一致)
 * @param {string} [o.dataDir] 复用已存在的数据目录 (漂移探针: 同一目录"学习后重启"第二趟)
 * @param {boolean} [o.keepDataDir] 收尾时保留目录 (探针要把第一趟的学习结果留给第二趟)
 */
export async function captureSession({
  turns = SCRIPT_TURNS, prefix = "cache-audit", fixture = null, projectRoot = PROJECT_ROOT,
  dataDir: providedDir = null, keepDataDir = false,
} = {}) {
  setLevel("error"); // 日志降噪: 保证 --json 的 stdout 纯净 (console.log 型 info 不再串流)
  const dataDir = providedDir || fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${prefix}-`));
  if (!fs.existsSync(path.join(dataDir, "config", "ppx.json"))) {
    // 空 provider 配置: 仓库 config/ppx.json 里若配了真实 provider (且环境变量有 key), 构造时
    // 会建真实客户端 —— 这里给 dataDir 一份独立配置, 加上下面 allProviders 强制替换, 双保险。
    fs.mkdirSync(path.join(dataDir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config", "ppx.json"), JSON.stringify({ providers: [] }, null, 2), "utf8");
  }
  // root=仓库根 (同 ctx-profile), dataDir/globalDataDir 强制临时目录 → 写盘不落仓库。
  const agent = new PPXAgent({ root: projectRoot, configFile: null, dataDir, globalDataDir: dataDir });
  // 网络硬隔离: 配置里若有真实 provider, 构造出的真实客户端必须整体换成捕获桩 (绝不出户)
  agent.evolve.enabled = false; // 关异步自进化, 防 fire-and-forget 中途往经验/技能注入变项 (审计测的是提示词管线)
  agent.auxLLM = null;
  const dyn = { current: null };
  const stub = makeCapturingStub(dyn);
  stub._responses = buildResponses(turns);
  agent.llm = stub;
  agent.allProviders = [stub];
  // 记账动态检索段: _context 每轮调用一次 memory.context(userMsg)/scenes.activeContext(userMsg),
  // 包装这两个调用即可拿到"当次请求真实的动态尾部", 用于定位静态边界 (不改其行为, 原样透传)。
  const origMemCtx = agent.memory.context.bind(agent.memory);
  const origSceneCtx = agent.scenes.activeContext.bind(agent.scenes);
  const origContext = agent._context.bind(agent);
  let turnSeq = 0;
  agent.memory.context = (u) => { const v = origMemCtx(u); (dyn.pending || (dyn.pending = {})).memoryCtx = v; return v; };
  agent.scenes.activeContext = (t) => { const v = origSceneCtx(t); (dyn.pending || (dyn.pending = {})).sceneCtx = v; return v; };
  agent._context = (userMsg) => {
    dyn.pending = {};
    const S = origContext(userMsg);
    turnSeq += 1;
    dyn.current = {
      turn: turnSeq,
      round: 0,
      system: S,
      memoryCtx: dyn.pending.memoryCtx ?? null,
      sceneCtx: dyn.pending.sceneCtx ?? "",
    };
    return S;
  };
  if (fixture) fixture(agent, { projectRoot, dataDir, turns });
  const sessionKey = "cache-audit-" + prefix;
  for (const t of turns) await agent.chat(t.user, { sessionKey });

  const captures = stub.captures.map((c) => ({
    ...c,
    serialized: serializeRequest({ tools: c.tools, messages: c.messages }),
    boundary: c.system == null
      ? { staticEnd: 0, ok: false, note: "请求不经 _context (非常规链路)" }
      : locateStaticTail(c.system, c.memoryCtx, c.sceneCtx),
  }));
  const teardown = async () => {
    try { await agent.shutdown(); } catch { /* 收尾失败不影响断言 */ }
    if (!keepDataDir) cleanupTmp(dataDir, { quiet: true }); // 安全护栏: 路径不在系统临时区内会抛错绝不删
  };
  return { agent, dataDir, captures, sessionKey, projectRoot, fixture, teardown };
}

// ---- 学习→重启 漂移探针 (检查 b 的因果半边, 不是模式匹配) ----
// 模式扫描只能抓"长得像时间戳/随机值"的字节; 记忆内容长得不像易变值, 但只要它落在静态区,
// 每一次学习都会在下次启动时作废整个缓存前缀。这里用真实管线做一次因果实验:
//   趟 A: 干净 dataDir → 走生产 API 往长期记忆写一条事实 (agent.facts.add) → 关闭
//   趟 B: 同一个 dataDir 重新启动实例 (启动即按当前记忆重建 L3 画像) → 比较两趟的静态区
// 若静态区随之改变 → 记忆内容确证位于缓存前缀之内 (回归); 若逐字节不变 → 该子方法可证地通过。
// 探针不接受 fixture (负例夹具会污染因果归因), 只用一次单轮会话取一份静态区。
export const PROBE_TURNS = [{ user: "审计探针: 一句话确认收到", replies: ["[stub] 探针确认。"] }];
export const PROBE_SEED_FACT = "审计探针写入的长期记忆样本 缓存前缀漂移检查";

export async function memoryDriftProbe({ projectRoot = PROJECT_ROOT } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-cache-drift-"));
  const seed = (agent) => { agent.facts.add(PROBE_SEED_FACT, { source: "manual", dedupe: false }); };
  let before = null, after = null;
  try {
    before = await captureSession({ turns: PROBE_TURNS, prefix: "cache-drift-a", projectRoot, dataDir: dir, keepDataDir: true, fixture: seed });
    after = await captureSession({ turns: PROBE_TURNS, prefix: "cache-drift-b", projectRoot, dataDir: dir });
  } finally {
    if (before) await before.teardown();
    if (after) await after.teardown();
    if (!after) cleanupTmp(dir, { quiet: true }); // 异常路径也要回收临时目录
  }
  const b = before.captures[0], a = after.captures[0];
  if (!b || !a || !b.boundary.ok || !a.boundary.ok) {
    return { ran: true, pass: false, detail: "探针未能定界静态边界 (不可证 → 按不通过处理)" };
  }
  const bs = b.system.slice(0, b.boundary.staticEnd);
  const as = a.system.slice(0, a.boundary.staticEnd);
  if (bs === as) {
    return { ran: true, pass: true, staticChars: bs.length,
      detail: "学习→重启 后静态区逐字节不变 (" + bs.length + " 字符): 记忆内容确证不进缓存前缀" };
  }
  const off = lcpChars(bs, as);
  return {
    ran: true, pass: false, offset: off,
    block: blockLabelAt(as, off),
    sample: as.slice(Math.max(0, off - 20), off + 70),
    detail: "学习→重启 漂移: 仅新增一条长期记忆 (" + JSON.stringify(PROBE_SEED_FACT) + ") 后重启实例, 静态区在 @+"
      + off + " 处变化 (区块: " + blockLabelAt(as, off) + ") —— 记忆派生文本被烘进缓存前缀, "
      + "每次学习都会在下次启动作废整个前缀缓存。重启后该处内容: " + JSON.stringify(as.slice(Math.max(0, off - 20), off + 70)),
  };
}

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
