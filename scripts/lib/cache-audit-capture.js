// scripts/lib/cache-audit-capture.js - 前缀缓存审计的"抓请求"层
// 从 scripts/lib/cache-audit-core.js 拆出 (2026-11-03): 捕获桩 + 脚本化多轮会话 +
// 学习→重启漂移探针。隔离与安全不变: agent.llm/allProviders 强制替换为捕获桩,
// 绝不产生真实 LLM 网络调用; dataDir 恒为系统临时目录下的 mkdtemp, 清理走
// tmp-agent.js 的安全护栏 cleanupTmp (不在安全区则抛错绝不删)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../../src/agent/index.js";
import { cleanupTmp } from "./tmp-agent.js";
import { setLevel } from "../../src/utils/logger.js";
import {
  PROJECT_ROOT, serializeRequest, locateStaticTail,
  lcpChars, blockLabelAt,
} from "./cache-audit-text.js";

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
