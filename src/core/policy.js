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
import { runPostChecks, buildVerifyFeedback, formatGateFailure } from "./postcondition.js";
import { toolResultStatus, toolResultContent, toolOutcome } from "./tool-result.js";

// ---- 阈值默认值 (config.agent.* 可覆盖) ----
export const DEFAULT_MAX_TOOL_ROUNDS = 8;
export const DEFAULT_TOOL_RESULT_BUDGET = 4000; // L4 toolResultBudget: 工具结果超过此长度裁剪, 防撑爆上下文
// 对外错误文案统一转译 (含 llmFailedHint) —— 与 agent/_shortReason 共用同一实现, 防口径漂移
import { llmFailedHint } from "../utils/public-error.js";
export const DEFAULT_MAX_TOOL_ERROR_RETRY = 2;
export const DEFAULT_OVERFLOW_SHRINK_MAX = 2;
// 回合级后置校验闸门 (2026-10-05): 收尾前 harness 自跑确定性检查, 不过则经 steering 通道把
// 失败喂回模型修正 —— 修正机会上限 2 次, 用尽则诚实上报 (不是无限重试, 也不是静默放行)。
export const DEFAULT_MAX_POSTCHECK_RETRY = 2;

// P0③ harness 融断: 探索连击 / 重复命令 阈值 (config.agent.explore_break_limit / repeat_flag_limit 可调)
export const DEFAULT_EXPLORE_BREAK = 3;   // 连续 3 轮只有只读/查询无产出 -> 融断
export const DEFAULT_REPEAT_FLAG = 2;     // 同一工具+args 命中 2 次 -> 警告重复

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
  const s = String(toolResultContent(result) || "");
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
  return toolResultStatus(r).timedOut;
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
  // 两种熔断: 连续探索无产出 / 重复执行相同工具+参数
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
      const sig = (tc.function?.name || "") + "::" + JSON.stringify(a).slice(0, 120);
      this.seenSig.set(sig, (this.seenSig.get(sig) || 0) + 1);
      if (this.seenSig.get(sig) >= this.repeatFlag) repeatHit = true;
    }
    if (allExplore) this.exploreStreak++; else this.exploreStreak = 0;
    if (repeatHit) { this.exploreStreak = 0; this.seenSig.clear(); }
    if (allExplore && this.exploreStreak >= this.exploreBreak) {
      this.exploreStreak = 0; this.seenSig.clear();
      return "检测到连续探索循环: 连续 " + this.exploreBreak + " 轮只有只读/查询工具, 未产生任何产出或修改。请停止继续探测, 基于已获得的信息直接给出结论或交付物; 若确实缺少关键信息, 明确说明并结束本轮, 不要空转。";
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
  isReadOnlyTool = () => false,
  canonicalizeToolArgs = (_name, args) => args,
  toolTimeoutOf = () => null,
  runTool,
  shrinkMessages,
  histTokenCap = () => 8192,
  // 回合级后置校验的注入点 (2026-10-05): { rootDir, capabilityOf, exec }。
  // 不传 = 不启用闸门 (纯逻辑测试/无工作区的调用方不受影响)。
  postCondition = null,
  // Turn-local state survives provider handoff; never use it across user turns.
  loopState = null,
}) {
  const state = loopState || {};
  const policy = state.policy ||= new ToolLoopPolicy(config.agent || config);
  let messages = state.messages ||= [...seedMessages];
  // 本回合同的工具调用轨迹 ({name, args, result}) —— 后置校验据此判断"本轮到底动过什么"
  const turnCalls = state.turnCalls ||= [];
  const userMsg = [...seedMessages].reverse().find((m) => m && m.role === "user")?.content || "";
  const ev = (type, payload) => { if (onEvent) { try { onEvent(type, payload); } catch {} } };
  const callKey = (name, args) => {
    const stable = (v) => Array.isArray(v) ? v.map(stable)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
    return `${name}:${JSON.stringify(stable(canonicalizeToolArgs(name, args)))}`;
  };
  // Each actual dispatch supplies one handoff receipt, including failed/unknown
  // outcomes: a timeout or nonzero exit does not prove no side effect committed.
  // Consume it once so
  // the model can still request another deliberate identical operation after
  // seeing that the first replay did not commit. Reused receipts are not commits.
  const protectedReceipts = new Map();
  if (state.resuming) {
    for (const c of turnCalls) {
      const status = c.status || toolResultStatus(c.result);
      if (c.receiptReused || status.dispatched === false || isReadOnlyTool(c.name) || isIdempotentTool(c.name)) continue;
      // Original proposals and authoritative executed args are aliases for one
      // dispatch, not two receipts. Consuming either alias consumes both.
      const retained = { receipt: toolOutcome(c.result, status), consumed: false };
      const keys = new Set([callKey(c.name, c.args), callKey(c.name, c.proposalArgs ?? c.args)]);
      for (const key of keys) {
        if (!protectedReceipts.has(key)) protectedReceipts.set(key, []);
        protectedReceipts.get(key).push(retained);
      }
    }
  }

  for (let round = state.nextRound || 0; round < policy.maxRounds; round++) {
    state.nextRound = round;
    if (isInterrupted()) return "[皮皮虾] 任务已被中断 (operator cancelled).";
    if (onStep) { try { onStep({ type: "step", round, maxRounds: policy.maxRounds, ts: Date.now() }); } catch {} }

    let resp;
    try {
      resp = await llm.apiChat(messages, {
        tools,
        toolRunner: async (name, args) => runTool(name, args),
      });
    } catch (e) {
      // 上下文溢出: 降档裁剪历史后重发 (不影响其它错误路径 — 非溢出照常抛出,
      // 交由上层 _llmWithFallback 切换 provider / 调用方处理)
      if (policy.shouldShrinkOverflow(e)) {
        const cap = policy.nextOverflowCap(histTokenCap());
        ev("tool/overflow", { round, shrink: policy.overflowShrinks, max: policy.overflowShrinkMax });
        warn(`上下文溢出, 降档裁剪后重试 (${policy.overflowShrinks}/${policy.overflowShrinkMax}): ${String(e?.message || e).slice(0, 120)}`);
        messages = shrinkMessages(messages, cap);
        state.messages = messages;
        state.nextRound = round + 1;
        continue;
      }
      // Only model-request failures may trigger provider handoff. An uncertain
      // tool/verification exception must not be retried as a fresh task.
      if (e && typeof e === "object") e.ppxModelRequestFailure = true;
      throw e;
    }

    const msg = resp.message;
    messages.push(msg);
    state.nextRound = round + 1;
    if (onAssistantMsg) { try { onAssistantMsg({ round, content: msg.content || "", toolCalls: msg.tool_calls || [] }); } catch { /* 采集异常不阻断主链 */ } }

    const toolCalls = msg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const draft = msg.content || "[皮皮虾] (无回复)";
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
    const execOne = ({ tc, args }) => {
      const key = callKey(tc.function.name, args);
      const retained = protectedReceipts.get(key)?.find((entry) => !entry.consumed);
      if (retained) {
        retained.consumed = true;
        ev("tool/replay_prevented", { tool: tc.function.name, reason: "one previous non-idempotent dispatch receipt consumed during provider handoff" });
        return Promise.resolve({ tc, result: retained.receipt, receiptReused: true, elapsedMs: 0, timedOut: false, retried: false });
      }
      return callWithTimeoutRetry({
        name: tc.function.name,
        args,
        runTool,
        isIdempotent: isIdempotentTool(tc.function.name),
        budgetMs: toolTimeoutOf(tc.function.name),
        onEvent,
      }).then((r) => ({ tc, ...r }));
    };
    const errors = [];
    const collect = (tc, result, receiptReused = false) => {
      // 2026-10-10 修复 (P1): 原用 `_id` 传工具调用 id —— 这是非标准字段, 严格 OpenAI 兼容
      //   后端在第二轮会因"tool 消息缺 tool_call_id / 无法与 assistant tool_calls.id 配对"回 400。
      //   现携带标准 `tool_call_id`; `_id` 保留供内部追踪 (不发送给后端的场景仍可用)。
      let contentForModel = toToolContent(result, policy.resultBudget);
      if (receiptReused) {
        const notice = toolResultStatus(result).ok
          ? "[回执复用] 这是本轮先前调用的回执; 本次未再次执行该非幂等操作。"
          : "[回执复用] 先前调用返回失败或结果未知, 不能据此断定未提交; 本次未再次执行该非幂等操作。";
        contentForModel = Array.isArray(contentForModel)
          ? [...contentForModel, { type: "text", text: notice }]
          : contentForModel + "\n" + notice;
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        _id: tc.id,
        content: contentForModel,
      });
      const status = toolResultStatus(result);
      const content = toolResultContent(result);
      if (!status.ok) errors.push(String(content));
      let a = {};
      try { a = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      turnCalls.push({ name: tc.function?.name || "", args: status.executedArgs ?? a,
        proposalArgs: a, result: content, status, receiptReused });
    };
    if (policy.parallelToolCalls) {
      const settled = await Promise.all(callable.map(execOne));
      for (const { tc, result, receiptReused } of settled) collect(tc, result, receiptReused);
    } else {
      // 串行回退路径 (旧行为): 逐个执行 + 逐个回传
      for (const item of callable) {
        const { result, receiptReused } = await execOne(item);
        collect(item.tc, result, receiptReused);
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
  return "[皮皮虾] 工具调用轮次过多, 已停止。";
}
