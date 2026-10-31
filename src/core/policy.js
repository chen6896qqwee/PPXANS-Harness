// src/core/policy.js - 工具循环执行策略 (纯逻辑, 不依赖 agent 实例)
// 重构第一刀 (2026-09-14): 从 src/agent/index.js PPXAgent._llmWithTools 抽离。
// 抽走: 探索熔断 / 重复命令检测 / 溢出降档 / 错误重试 / 轮次上限 / 工具结果裁剪。
// 原则: 策略与执行分离 — agent 只负责"调 LLM、跑工具、传消息",
//       循环何时停、降档、重试、注入方向盘, 全由本模块决策。
//       依赖全部注入 (llm/tools/runTool/shrinkMessages/...), 无 agent 引用, 可独立测试。
// TOOL_ERROR_PREFIX 走 core/errors.js (纯常量, 零依赖) ——
//   原先从 ../tools/index.js 导入, 构成 core → tools 反向边 (与 tools → core/postcondition 成环)。
//   常量已下沉到 core(L1), 这里接上即可断环 (2026-10-10 arch-guard 检出 core → tools → core)。
import { TOOL_ERROR_PREFIX } from "./errors.js";
import { warn } from "../utils/logger.js";
import { stableJson } from "../utils/canonical.js";
import { runPostChecks, buildVerifyFeedback, formatGateFailure } from "./postcondition.js";

// ---- 阈值默认值 (config.agent.* 可覆盖) ----
export const DEFAULT_MAX_TOOL_ROUNDS = 8;
export const DEFAULT_TOOL_RESULT_BUDGET = 4000; // L4 toolResultBudget: 工具结果超过此长度裁剪, 防撑爆上下文
// 2026-10-24 (R10): 空回复哨兵 —— provider 返回空 content 且无 tool_calls 时循环以此收尾。
//   agent._llmWithFallback 据此判定"该 provider 没给出答案", 还有备选就切换下一个,
//   而不是把"(无回复)"当最终答案交付。
export const EMPTY_REPLY = "[皮皮虾] (无回复)";
// 对外错误文案统一转译 (含 llmFailedHint) —— 与 agent/_shortReason 共用同一实现, 防口径漂移
import { llmFailedHint } from "../utils/public-error.js";
export const DEFAULT_MAX_TOOL_ERROR_RETRY = 2;
export const DEFAULT_OVERFLOW_SHRINK_MAX = 2;
// 回合级后置校验闸门 (2026-10-05): 收尾前 harness 自跑确定性检查, 不过则经 steering 通道把
// 失败喂回模型修正 —— 修正机会上限 2 次, 用尽则诚实上报 (不是无限重试, 也不是静默放行)。
export const DEFAULT_MAX_POSTCHECK_RETRY = 2;

// P0③ harness 融断: 探索连击 / 重复命令 阈值 (config.agent.explore_break_limit / repeat_flag_limit 可调)
export const DEFAULT_EXPLORE_BREAK = 5;   // 连续 5 轮只读/查询无产出 -> 融断 (2026-10-30: 3 轮太紧, 见构造器注释)
export const DEFAULT_REPEAT_FLAG = 2;     // 同一工具+args 命中 2 次 -> 警告重复

// 同轮工具并发上限 (2026-10-30): 一轮里 LLM 可能一次吐出 N 个 tool_calls, 旧实现无条件
//   Promise.all 全放 —— N 个 run_command 就是 N 个 shell 子进程同时 spawn, Windows 上直接卡死,
//   内存/句柄也不设防。军团侧早有 max_concurrent_agents 背压, 工具侧一直没有。
//   默认 4 与 config.agent.legion.max_concurrent_per_call 同量级; 0 = 不限 (保留旧行为)。
export const DEFAULT_MAX_PARALLEL_TOOLS = 4;

// 轮次耗尽的收尾文案 (保持原有字节, 调用方/测试的口径不动)
export const EXHAUSTED_STOP_TEXT = "[皮皮虾] 工具调用轮次过多, 已停止。";

// 轮次耗尽的强制收口 (2026-10-30): 旧行为是 8 轮用完后直接甩一句"轮次过多, 已停止" ——
//   前 7 轮读过的文件、改过的代码、跑过的测试全部作废, 用户拿到的是零信息。
//   这里补一次**不带工具**的收口调用, 让模型基于已有轨迹给出结论。代价是 +1 次 LLM 调用,
//   换的是"任务做了一半但用户至少知道做到了哪"。关掉用 config.agent.exhausted_finalize=false。
export const EXHAUSTED_FINALIZE_PROMPT = [
  "工具调用轮次已达上限, 现在开始不允许再调用任何工具。",
  "请只基于上面已经产生的工具结果, 直接给出最终收口:",
  "1) 已完成且已验证的事实/操作 (必须有工具结果支撑, 不要凭印象补);",
  "2) 未完成的部分, 以及卡在哪一步、缺什么信息;",
  "3) 用户可以立即执行的下一步建议。",
  "纪律: 不要编造没做过的检查, 不要宣称未验证的成功, 不确定就写不确定。",
].join("\n");

// 探索类工具集 (read-only/发现; 不算"产出或修改")
export const EXPLORE_TOOLS = new Set([
  "read_file", "list_dir", "web_search", "fetch_page", "memory_search", "read_document",
  "get_time", "read_image", "ocr_image", "list_schedules", "list_capabilities", "replay_session",
]);

// 判断是否为「上下文溢出」错误 (常见信号: 消息含 context/length/token/window, 或 HTTP 400/413)
// 注意: AbortError(用户取消/内部超时中止) 一律不算溢出, 沿用 retry.js 不重试约定。
export function isOverflowError(e) {
  if (!e) return false;
  if (e.name === "AbortError" || e.code === "ABORT_ERR") return false;
  const status = (typeof e.status === "number" ? e.status : e.statusCode) ?? null;
  if (status === 413) return true; // 请求体过大 (content too large)
  if (status !== null && status !== 400 && (status >= 500 || status < 400)) return false; // 服务端/非 4xx 非溢出
  const msg = String(e?.message || e || "");
  // 仅在消息出现上下文/长度/token 相关措辞时判为溢出, 普适 HTTP 400 不误判
  if (status === 400) {
    return /context|token|length|window/i.test(msg);
  }
  return /context\s*(size)?\s*exceeded|maximum\s*context\s*length|too\s*many\s*tokens|context\s*window|token\s*(limit|budget)|exceeds?\s*(the\s*)?(model|context|token)|insufficient\s*context/i.test(msg);
}

// LLM 调用失败的兜底提示: 附排查指引, 避免裸抛错误对用户不友好
// 2026-10-09: 不再直接拼 ${message} 原文 —— 那会把 ERR_HTTP_HEADERS_SENT / EPIPE / 原始 JSON
//   这类内部细节漏给用户。改为走 utils/public-error 的统一转译 (与降级路径 _shortReason 同一口径)。
// 参数兼容: 可传 Error 对象, 也可传字符串 (历史调用方传的是 e.message)。
export function LLM_FAILED_HINT(err) {
  return llmFailedHint(err);
}

// L4 toolResultBudget: 裁剪超长工具结果, 保留头尾关键信息 (默认 4000, config.agent.tool_result_budget 可调)
export function trimToolResult(r, budget = DEFAULT_TOOL_RESULT_BUDGET) {
  const s = String(r || "");
  if (s.length <= budget) return s;
  const head = s.slice(0, budget * 0.7);
  const tail = s.slice(-budget * 0.3);
  return head + `\n...[结果已裁剪: 共 ${s.length} 字符, 保留头尾 ${budget}]...\n` + tail;
}

// 工具结果 → OpenAI 消息 content: 图片 data URL 转 image_url 块 (多模态), 否则文本裁剪
export function toToolContent(result, budget = DEFAULT_TOOL_RESULT_BUDGET) {
  const s = String(result || "");
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(s)) {
    return [{ type: "image_url", image_url: { url: s } }];
  }
  return trimToolResult(s, budget);
}

// ---- 超时检测与重试 (v1.6.0 第四刀: 首个功能增量, 非等价重构) ----
// 语义: 工具层 (seam.js runWithPolicy) 已用 AbortController 真中断底层执行 (资源超时),
//       这里负责策略层: 超时结果识别 + 幂等工具重试一次 + tool.timeout 事件采集。
// 边界 (最小版本): 不搞退避/熔断/自适应预算 — 留到有真实超时数据后 (第五刀) 再设计。
// 返回: { result, elapsedMs, timedOut, retried }
export function isTimeoutResult(r) {
  return typeof r === "string" && r.startsWith(TOOL_ERROR_PREFIX) && r.includes("超时");
}

export async function callWithTimeoutRetry({
  name, args, runTool,
  isIdempotent = true,       // 幂等工具才自动重试 (避免非幂等工具副作用二次执行)
  budgetMs = null,           // 工具超时预算 (toolTimeoutOf 注入, 事件采集用)
  onEvent = null,
}) {
  const ev = (type, payload) => { if (onEvent) { try { onEvent(type, payload); } catch {} } };
  const t0 = Date.now();
  let result = await runTool(name, args);
  let elapsedMs = Date.now() - t0;
  if (!isTimeoutResult(result)) return { result, elapsedMs, timedOut: false, retried: false };
  // 超时: 非幂等不重试 (副作用安全边界), 直接返回结构化错误
  if (!isIdempotent) {
    ev("tool/timeout", { tool: name, elapsedMs, budgetMs, retried: false, skippedRetry: true });
    return { result, elapsedMs, timedOut: true, retried: false };
  }
  // 幂等: 重试一次
  ev("tool/timeout", { tool: name, elapsedMs, budgetMs, retried: false });
  const t1 = Date.now();
  result = await runTool(name, args);
  elapsedMs = Date.now() - t1;
  if (isTimeoutResult(result)) {
    ev("tool/timeout", { tool: name, elapsedMs, budgetMs, retried: true, gaveUp: true });
    return { result, elapsedMs, timedOut: true, retried: true };
  }
  return { result, elapsedMs, timedOut: false, retried: true };
}

// ---- 工具循环策略状态机 ----
// 每轮工具循环的决策都收敛到这里: 阈值从 config 读, 状态在实例内, 判定是纯方法。
// 换策略 = 换这个类, 不动 agent 主循环。
export class ToolLoopPolicy {
  constructor(cfg = {}) {
    const c = cfg || {};
    this.maxRounds = Number(c.max_tool_rounds) || DEFAULT_MAX_TOOL_ROUNDS;
    this.resultBudget = Number(c.tool_result_budget) || DEFAULT_TOOL_RESULT_BUDGET;
    this.maxErrorRetry = Number(c.max_tool_error_retry) || DEFAULT_MAX_TOOL_ERROR_RETRY;
    this.exploreBreak = Number(c.explore_break_limit) || DEFAULT_EXPLORE_BREAK;
    this.repeatFlag = Number(c.repeat_flag_limit) || DEFAULT_REPEAT_FLAG;
    this.overflowShrinkMax = DEFAULT_OVERFLOW_SHRINK_MAX;
    // 回合级后置校验闸门 (2026-10-05): 默认开 —— 不藏在配置后面的默认关里。
    this.postCheck = c.postcondition_gate !== false;
    // 脏配置回落默认而不是 NaN; 0 是合法值 (拦一次即诚实收尾)
    const retries = Number(c.postcondition_retries);
    this.maxPostCheckRetry = Number.isFinite(retries) && retries >= 0 ? retries : DEFAULT_MAX_POSTCHECK_RETRY;
    this.postCheckRetries = 0;
    // 同轮独立工具调用并发执行 (2026-10-01 优化): 默认开, agent.parallel_tool_calls=false 回退串行
    this.parallelToolCalls = c.parallel_tool_calls !== false;
    // 同轮并发上限 (2026-10-30): 默认 4; 0 = 不限 (旧行为); 脏配置回落默认而不是 NaN
    const parallelCap = Number(c.max_parallel_tools);
    this.maxParallelTools = Number.isFinite(parallelCap) && parallelCap >= 0
      ? Math.trunc(parallelCap)
      : DEFAULT_MAX_PARALLEL_TOOLS;
    // 轮次耗尽收口 (2026-10-30): 默认开 —— "做了一半"比"什么都没给"值钱, 不藏在默认关里
    this.exhaustedFinalize = c.exhausted_finalize !== false;

    // 运行时状态 (每轮循环实例持有, 重启归零)
    this.errorRetries = 0;
    this.exploreStreak = 0;
    this.seenSig = new Map();
    this.overflowShrinks = 0;
  }

  // 溢出判定: 是否该降档裁剪后重试 (未超降档次数上限 && 确实是溢出错误)
  shouldShrinkOverflow(e) {
    return this.overflowShrinks < this.overflowShrinkMax && isOverflowError(e);
  }

  // 溢出降档: 计数 +1, 返回更紧的历史预算 (逐档缩紧, 下限 200)
  nextOverflowCap(histTokenCap) {
    this.overflowShrinks++;
    return Math.max(200, Math.floor(histTokenCap / (this.overflowShrinks + 1)));
  }

  // 记录本轮工具调用, 返回需要注入模型的方向盘消息 (无则 null)
  // 两种熔断: 连续探索无新目标 / 重复执行相同工具+参数
  recordTurn(toolCalls) {
    const called = (toolCalls || []).filter((tc) => tc.type === "function" && tc.function);
    if (!called.length) return null;
    let allExplore = true;
    for (const tc of called) {
      if (!EXPLORE_TOOLS.has(tc.function?.name || "")) { allExplore = false; break; }
    }
    let repeatHit = false;
    for (const tc of called) {
      let a = {};
      try { a = JSON.parse(tc.function.arguments || "{}"); } catch {}
      // 2026-10-30: 签名键序无关 —— 同一组参数换键序重发, 旧实现算作"新调用"漏判重复
      const sig = (tc.function?.name || "") + "::" + stableJson(a, 120);
      this.seenSig.set(sig, (this.seenSig.get(sig) || 0) + 1);
      if (this.seenSig.get(sig) >= this.repeatFlag) repeatHit = true;
    }
    // 探索熔断 (2026-10-30 校正阈值): 原阈值 3 轮太紧 —— "读 5 个文件再动手"是最常见的
    //   合法工作流, 却在第 3 轮被当成空转叫停, 直接把任务做一半掐了 (成功率受损)。
    //   连续只读轮数提到 5, 并保持 repeat 检测作为"重复同一调用"的独立短周期告警。
    if (allExplore) this.exploreStreak++; else this.exploreStreak = 0;
    if (repeatHit) { this.exploreStreak = 0; this.seenSig.clear(); }
    if (allExplore && this.exploreStreak >= this.exploreBreak) {
      this.exploreStreak = 0; this.seenSig.clear();
      return "检测到连续探索循环: 连续 " + this.exploreBreak + " 轮只有只读/查询工具, 未产生任何产出或修改。"
        + "请停止继续探测, 基于已获得的信息直接给出结论或交付物; 若确实缺少关键信息, 明确说明并结束本轮, 不要空转。";
    }
    if (repeatHit) {
      return "检测到重复执行相同工具与参数。请不要再重复该调用, 换一条不同路径推进, 或直接基于现有信息产出结论。";
    }
    return null;
  }

  // 工具错误: 是否该把错误喂回模型修正重试 (未超重试上限)
  shouldRetryErrors(errors) {
    if (!errors || !errors.length) return false;
    if (this.errorRetries >= this.maxErrorRetry) return false;
    this.errorRetries++;
    return true;
  }

  // ---- 自省裁决 (Reflective 内核): 对工具失败做语义分类, 决定重试策略 ----
  // 在机械次数重试之上加一道闸门: 硬拒绝类错误 (黑名单/审批拒/权限/deny/DENY_HINT)
  // 不许盲目改写命令绕过, 直接拦停; 可修正类错误才走次数重试。
  // 返回 { action: "stop"|"retry", reason } — 纯方法, 可独立测试。
  selfReviewError(errors) {
    if (!errors || !errors.length) return null;
    const text = errors.join("\n");
    // 硬拒绝特征: 命中命令守卫拦截 / 审批被拒 / 权限拒绝 / 黑名单
    if (/命中后不要重试|改造命令绕过|硬黑名单|审批被拒绝|审批拒绝|权限.*拒|deny|DENY|拦截/i.test(text)) {
      return {
        action: "stop",
        reason: "这是硬性拒绝类错误, 盲目重试或改写命令会绕过安全闸门 — 停下不重试, 说明原因或请用户调整配置。",
      };
    }
    // 可修正类错误 (命令不存在/文件缺失/参数错等): 走次数重试道
    return { action: "retry", reason: "可修正错误, 喂回模型重试 (仍受次数上限约束)" };
  }

  // 后置校验失败后是否还给它一次修正机会 (调用即计数)。
  // 计数器封顶 → 第 3 次必然 false, 不可能活锁; 用尽后由调用方走诚实上报。
  shouldRetryPostCheck() {
    if (!this.postCheck) return false;
    if (this.postCheckRetries >= this.maxPostCheckRetry) return false;
    this.postCheckRetries++;
    return true;
  }
}

// ---- 有界并发 (2026-10-30) ----
// 保序 + 有上限地跑一组异步任务: 结果数组下标与输入一致 (下游按 tool_calls 顺序回传/配对,
// 顺序不能变)。limit <= 0 视为不限 (由调用方决定是否走这里)。任一项抛错 → 整体 reject,
// 与 Promise.all 语义一致 (其他已启动的任务无法取消, 与旧实现同)。
export async function mapBounded(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const cap = Math.max(1, Math.min(Math.trunc(Number(limit)) || 1, list.length));
  const out = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: cap }, () => worker()));
  return out;
}

// ---- 工具循环主驱动 (原 PPXAgent._llmWithTools) ----
// 依赖全部注入, 不持有 agent 引用:
//   seedMessages     初始消息数组 (system + history + user)
//   llm              LLM 客户端 (apiChat)
//   tools            OpenAI 格式工具声明数组 ([] = 禁用工具)
//   config           完整配置 (读 config.agent.* 阈值)
//   isInterrupted    () => boolean, 中断信号
//   onStep           (ev) => void, 推理轮次事件
//   runTool          (name, args) => Promise<string>, 工具执行 (trace/事件由调用方负责)
//   shrinkMessages   (messages, budget) => messages, 溢出降档裁剪 (agent 上下文管理职责)
//   histTokenCap     () => number, 当前历史 token 预算上限
//   onEvent          (type, payload) => void, 可选策略事件回调 (工具失败路径: 溢出降档/熔断/错误重试/超时), 供 trace 埋点
//   isIdempotentTool (name) => boolean, 工具是否幂等可安全重试 (默认全 true)
//   toolTimeoutOf    (name) => number|null, 工具超时预算 (事件采集用, 默认 null)
export async function runToolLoop({
  seedMessages,
  llm,
  tools,
  config = {},
  isInterrupted = () => false,
  onStep = null,
  onEvent = null,
  // onAssistantMsg (2026-10-10): 每轮模型回包后回调 { round, content, toolCalls } —— 供调用方
  //   采集"轮内中间草稿"(带工具调用的半成品回答), 落进 memory/turns 的可重建上下文。
  //   不影响任何既有语义: 不传即零开销。
  onAssistantMsg = null,
  isIdempotentTool = () => true,
  toolTimeoutOf = () => null,
  // 2026-10-24: 循环内预算闸门 —— () => string|null, 返回非空文案 = 预算已耗尽。
  //   旧闸门只在 chat 入口检查一次; 8 轮工具循环 × provider 重试的花费入口根本看不见。
  //   每轮 LLM 调用前检查一次, 触发即收口 (已执行的工作不回滚, 诚实上报预算截断)。
  budgetBlocked = null,
  // 2026-10-24 (R4): 流式工具循环 —— onDelta(text) 逐字回调每轮的模型文本增量;
  //   signal 透传给流式请求 (中断立即掐断上游)。两者缺省 = 完全走原非流式路径。
  onDelta = null,
  signal = null,
  runTool,
  shrinkMessages,
  histTokenCap = () => 8192,
  // 回合级后置校验的注入点 (2026-10-05): { rootDir, capabilityOf, exec }。
  // 不传 = 不启用闸门 (纯逻辑测试/无工作区的调用方不受影响)。
  postCondition = null,
}) {
  const policy = new ToolLoopPolicy(config.agent || config);
  let messages = [...seedMessages];
  // 本回合同的工具调用轨迹 ({name, args, result}) —— 后置校验据此判断"本轮到底动过什么"
  const turnCalls = [];
  const userMsg = [...seedMessages].reverse().find((m) => m && m.role === "user")?.content || "";
  const ev = (type, payload) => { if (onEvent) { try { onEvent(type, payload); } catch {} } };

  for (let round = 0; round < policy.maxRounds; round++) {
    if (isInterrupted()) return "[皮皮虾] 任务已被中断 (operator cancelled).";
    // 2026-10-24: 循环内预算闸门 (每轮 LLM 调用前) —— budget.usd 之类入口闸管不住
    //   "单轮循环内部"的持续花费。非空返回值 = 预算耗尽文案, 直接收口。
    if (budgetBlocked && round > 0) {
      const blocked = (() => { try { return budgetBlocked(); } catch { return null; } })();
      if (blocked) {
        ev("tool/budget_blocked", { round });
        return `[皮皮虾] 预算闸门触发, 循环在第 ${round}/${policy.maxRounds} 轮前收口。已完成的步骤保留; ${blocked}`;
      }
    }
    if (onStep) { try { onStep({ type: "step", round, maxRounds: policy.maxRounds, ts: Date.now() }); } catch {} }

    let resp;
    try {
      // 2026-10-24 (R4): 流式工具循环 —— 调用方给了 onDelta 且 provider 支持流式时,
      //   走 SSE 流式 (文本增量实时回调, 增量 tool_call 累积); 失败时若尚未吐出任何
      //   增量则静默退非流式重发 (用户无感知), 已吐出过增量则抛给上层回退链
      //   (回退重放有非幂等工具回放缓存保护, 不会双执行)。
      const streamCapable = !!(onDelta && typeof llm.apiChatStream === "function" && llm.supportsStream !== false);
      let streamedAny = false;
      const emit = streamCapable && onDelta
        ? (text, meta) => { streamedAny = true; onDelta(text, meta); }
        : null;
      try {
        resp = streamCapable
          ? await llm.apiChatStream(messages, { tools, onDelta: emit, signal })
          : await llm.apiChat(messages, {
            tools,
            toolRunner: async (name, args) => runTool(name, args),
            signal, // (R12) 非流式同样可被中断
          });
      } catch (streamErr) {
        // 2026-10-24 (R12): 用户中断不是"流式能力失败" —— 禁止静默退非流式重发
        //   (否则叫停被吞掉, 换非流式把整篇重跑一遍 = 二次计费 + 违背"绝不降级重发")。
        const userAborted = streamErr?.name === "AbortError" || streamErr?.code === "ABORT_ERR"
          || (signal && signal.aborted);
        if (streamCapable && !streamedAny && !userAborted) {
          ev("tool/stream-fallback", { round });
          // (R17) no-ex-assign: 兜底失败的新错误放独立变量, 不再重赋 catch 参数
          //   (原 streamErr = apiErr 写法触发 eslint error, 语义不变)。
          let fallbackErr = null;
          try {
            resp = await llm.apiChat(messages, {
              tools,
              toolRunner: async (name, args) => runTool(name, args),
              signal, // (R12) 非流式兜底同样可被中断 (兜底本身已被 userAborted 守卫排除在中断外)
            });
          } catch (apiErr) {
            resp = null;
            fallbackErr = apiErr; // 非流式兜底也失败 → 按新错误走外层 (溢出判定/回退链)
          }
          // 2026-10-24 (R10): 兜底结果为"空回复"时不算成功 —— 有的 provider 流式
          //   不支持但 apiChat 返回空 content 不抛错, 若当最终答案, 空回复会顶掉
          //   后续 provider 的真回答。空 = 继续抛原 streamErr 走回退链。
          if (resp) {
            const m = resp.message || {};
            const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
            if (!m.content && !hasCalls) { resp = null; fallbackErr = fallbackErr || streamErr; }
          }
          if (fallbackErr) throw fallbackErr;
        } else {
          throw streamErr;
        }
      }
    } catch (e) {
      // 上下文溢出: 降档裁剪历史后重发 (不影响其它错误路径 — 非溢出照常抛出,
      // 交由上层 _llmWithFallback 切换 provider / 调用方处理)
      if (policy.shouldShrinkOverflow(e)) {
        const cap = policy.nextOverflowCap(histTokenCap());
        ev("tool/overflow", { round, shrink: policy.overflowShrinks, max: policy.overflowShrinkMax });
        warn(`上下文溢出, 降档裁剪后重试 (${policy.overflowShrinks}/${policy.overflowShrinkMax}): ${String(e?.message || e).slice(0, 120)}`);
        messages = shrinkMessages(messages, cap);
        continue;
      }
      throw e;
    }

    const msg = resp.message;
    messages.push(msg);
    if (onAssistantMsg) { try { onAssistantMsg({ round, content: msg.content || "", toolCalls: msg.tool_calls || [] }); } catch { /* 采集异常不阻断主链 */ } }

    const toolCalls = msg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const draft = msg.content || EMPTY_REPLY;
      // ---- 回合级后置校验闸门 (2026-10-05) ----
      // 提示词纪律与写后自查只覆盖单次调用; 这里补的是**回合级**: 收尾前 harness 自己跑确定性
      // 检查, 不过则经既有 steering 通道把失败喂回模型 (可行动、非堵墙), 修正机会 ≤2,
      // 用尽则诚实上报 (没有哪个工具可以宣称自己证明不了的成功)。
      if (postCondition && postCondition.rootDir && policy.postCheck) {
        const gate = await runPostChecks({
          rootDir: postCondition.rootDir,
          calls: turnCalls,
          finalMessage: draft,
          userMessage: userMsg,
          capabilityOf: postCondition.capabilityOf || null,
          exec: postCondition.exec,
        });
        ev("tool/postcheck", {
          round, failures: gate.failures.length, notes: gate.notes.length,
          checked: gate.checked, ran: gate.ran, spawns: gate.spawns, ms: gate.ms,
        });
        if (gate.failures.length) {
          const checks = gate.failures.map((f) => f.id);
          if (policy.shouldRetryPostCheck()) {
            ev("tool/postcheck_retry", {
              round, attempt: policy.postCheckRetries, max: policy.maxPostCheckRetry, checks, ms: gate.ms,
            });
            messages.push({
              role: "user",
              content: buildVerifyFeedback({
                failures: gate.failures, notes: gate.notes,
                attempt: policy.postCheckRetries, max: policy.maxPostCheckRetry,
              }),
            });
            continue;
          }
          ev("tool/postcheck_exhausted", {
            round, attempts: policy.postCheckRetries, failures: gate.failures.length, checks,
          });
          return formatGateFailure({
            failures: gate.failures, notes: gate.notes,
            attempts: policy.postCheckRetries, draft,
          });
        }
      }
      return draft;
    }

    // 工具错误重试: 若本轮有工具失败, 汇总错误喂回模型修正后重试 (最多 maxErrorRetry 次)
    // 并发执行 (2026-10-01 优化, 审计 P1 遗留项): 同一轮的 tool_calls 相互独立
    // (OpenAI 语义: 数组内无依赖), 串行会让 N 个独立调用的延迟线性叠加。
    // Promise.all 保序: messages 回传顺序与 errors 汇总顺序仍与 tool_calls 一致,
    // 下游 (recordTurn 重复检测 / 错误喂回) 语义不变。agent.parallel_tool_calls=false 回退串行。
    const callable = [];
    for (const tc of toolCalls) {
      if (tc.type === "function" && tc.function) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        callable.push({ tc, args });
      }
    }
    // v1.6.0 第四刀语义保留: 超时检测 + 幂等重试一次 (tool/timeout 事件采集 P50/P95/P99 数据基础)
    const execOne = ({ tc, args }) => callWithTimeoutRetry({
      name: tc.function.name,
      args,
      runTool,
      isIdempotent: isIdempotentTool(tc.function.name),
      budgetMs: toolTimeoutOf(tc.function.name),
      onEvent,
    }).then((r) => ({ tc, ...r }));
    const errors = [];
    const collect = (tc, result) => {
      // 2026-10-10 修复 (P1): 原用 `_id` 传工具调用 id —— 这是非标准字段, 严格 OpenAI 兼容
      //   后端在第二轮会因"tool 消息缺 tool_call_id / 无法与 assistant tool_calls.id 配对"回 400。
      //   现携带标准 `tool_call_id`; `_id` 保留供内部追踪 (不发送给后端的场景仍可用)。
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        _id: tc.id,
        content: toToolContent(result, policy.resultBudget),
      });
      if (result.startsWith(TOOL_ERROR_PREFIX)) errors.push(result);
      let a = {};
      try { a = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      turnCalls.push({ name: tc.function?.name || "", args: a, result });
    };
    if (policy.parallelToolCalls) {
      // 2026-10-30: 有界并发 — cap>0 且本轮调用数超限时按批跑; 未超限保持原来的全并发
      const cap = policy.maxParallelTools;
      let settled;
      if (cap > 0 && callable.length > cap) {
        ev("tool/parallel_bounded", { round, calls: callable.length, cap });
        settled = await mapBounded(callable, cap, execOne);
      } else {
        settled = await Promise.all(callable.map(execOne));
      }
      for (const { tc, result } of settled) collect(tc, result);
    } else {
      // 串行回退路径 (旧行为): 逐个执行 + 逐个回传
      for (const item of callable) {
        const { result } = await execOne(item);
        collect(item.tc, result);
      }
    }
    if (policy.shouldRetryErrors(errors)) {
      // 自省裁决 (Reflective 内核): 硬拒绝类错误直接拦停, 不得盲目改写命令绕过
      // 语义闸门在次数闸门之前: 即使重试次数未满, 硬拒绝也不重试 (安全红线)
      const verdict = policy.selfReviewError(errors);
      if (verdict && verdict.action === "stop") {
        ev("tool/self_review_stop", { round, reason: verdict.reason, retries: policy.errorRetries });
        messages.push({
          role: "user",
          content: "自省裁决: " + verdict.reason + "\n失败详情:\n" + errors.join("\n") + "\n请停止重试, 直接基于已有信息给出结论, 或向用户说明原因。",
        });
        continue;
      }
      ev("tool/error_retry", { round, errors: errors.length, retries: policy.errorRetries, max: policy.maxErrorRetry });
      messages.push({
        role: "user",
        content: "以下工具调用失败, 请修正参数或改用其他方式后重试:\n" + errors.join("\n"),
      });
      continue;
    }

    // P0③ harness 融断: 探索循环 / 重复命令 (无产出的自转) → 注入方向盘给模型
    const steer = policy.recordTurn(toolCalls);
    if (steer) {
      if (steer.includes("连续探索循环")) ev("tool/explore_break", { round });
      else ev("tool/repeat_warn", { round });
      messages.push({ role: "user", content: steer });
      continue;
    }
  }
  // ---- 轮次耗尽: 强制收口 (2026-10-30) ----
  // 旧行为: 循环跑满 maxRounds 就 return 一句"轮次过多, 已停止", 中间几轮的工作全丢。
  // 新行为: 若确实执行过工具 (有轨迹)、用户没叫停、预算没烧穿, 补一次**无工具**的调用
  //   让模型基于已有结果收口; 收口失败/空回复/无轨迹时仍回落到原文案 (绝不假装成功)。
  const finalizeNote = await exhaustedFinalizeText({
    llm, messages, policy, turnCalls, isInterrupted, budgetBlocked, ev, onDelta,
  });
  if (finalizeNote) return finalizeNote;
  return EXHAUSTED_STOP_TEXT;
}

// 轮次耗尽收口: 返回「收口正文 + 诚实标注」或 null (= 调用方回落硬停止文案)。
// 边界: 无工具轨迹不收口 (没有可总结的东西, 多花一次调用纯亏); 中断/预算优先。
async function exhaustedFinalizeText({
  llm, messages, policy, turnCalls, isInterrupted, budgetBlocked, ev, onDelta,
}) {
  if (!policy.exhaustedFinalize) return null;
  if (!turnCalls || !turnCalls.length) return null;                    // 没有实际动作, 不编总结
  try { if (isInterrupted && isInterrupted()) return null; } catch { return null; }
  if (budgetBlocked) {
    // 预算已烧穿时再补一次调用 = 明知没钱还点单, 直接放弃收口
    try { if (budgetBlocked()) return null; } catch { /* 闸门本身异常: 不当作已耗尽 */ }
  }
  if (!llm || typeof llm.apiChat !== "function") return null;
  ev("tool/exhausted_finalize", { rounds: policy.maxRounds, calls: turnCalls.length });
  const okCalls = turnCalls.filter((c) => !String(c.result || "").startsWith(TOOL_ERROR_PREFIX)).length;
  try {
    const resp = await llm.apiChat(
      [...messages, { role: "user", content: EXHAUSTED_FINALIZE_PROMPT }],
      { tools: [] }, // 关键: 不给工具 —— 否则模型会继续调用, 收口变成第 9 轮
    );
    const text = String(resp?.message?.content || "").trim();
    if (!text) return null;
    if (typeof onDelta === "function") {
      // 流式通道: 收口正文同样要给用户看到 (此前只在非流式返回里)
      try { onDelta(text, { finalize: true }); } catch { /* 推送失败不影响返回值 */ }
    }
    return [
      text,
      "",
      "---",
      `⚠️ 工具轮次上限已用尽 (${policy.maxRounds} 轮 / ${turnCalls.length} 次工具调用, 其中 ${okCalls} 次成功)。` +
        "以上是基于已完成步骤的收口总结, 本轮未再执行任何新操作; 未完成的部分见上文第 2 条。",
    ].join("\n");
  } catch (e) {
    warn(`轮次耗尽收口失败, 回落硬停止: ${String(e?.message || e).slice(0, 120)}`);
    return null;
  }
}
