// src/core/policy.js - 工具循环执行策略 (纯逻辑, 不依赖 agent 实例)
// 重构第一刀 (2026-09-14): 从 src/agent/index.js PPXAgent._llmWithTools 抽离。
// 抽走: 探索熔断 / 重复命令检测 / 溢出降档 / 错误重试 / 轮次上限 / 工具结果裁剪。
// 原则: 策略与执行分离 — agent 只负责"调 LLM、跑工具、传消息",
//       循环何时停、降档、重试、注入方向盘, 全由本模块决策。
//       依赖全部注入 (llm/tools/runTool/shrinkMessages/...), 无 agent 引用, 可独立测试。
import { TOOL_ERROR_PREFIX } from "../tools/index.js";
import { warn } from "../utils/logger.js";

// ---- 阈值默认值 (config.agent.* 可覆盖) ----
export const DEFAULT_MAX_TOOL_ROUNDS = 8;
export const DEFAULT_TOOL_RESULT_BUDGET = 4000; // L4 toolResultBudget: 工具结果超过此长度裁剪, 防撑爆上下文
export const DEFAULT_MAX_TOOL_ERROR_RETRY = 2;
export const DEFAULT_OVERFLOW_SHRINK_MAX = 2;

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
export function LLM_FAILED_HINT(message) {
  return `[皮皮虾] LLM 调用失败: ${message}
排查指引: 1) 检查 config/ppx.json 的 providers 是否配置了可用的 API key (export XXX_API_KEY=...); 2) 本地模型 (lmstudio) 是否在运行; 3) 启动 ppx-serve 看日志确认模型加载。`;
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
  isIdempotentTool = () => true,
  toolTimeoutOf = () => null,
  runTool,
  shrinkMessages,
  histTokenCap = () => 8192,
}) {
  const policy = new ToolLoopPolicy(config.agent || config);
  let messages = [...seedMessages];
  const ev = (type, payload) => { if (onEvent) { try { onEvent(type, payload); } catch {} } };

  for (let round = 0; round < policy.maxRounds; round++) {
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
        continue;
      }
      throw e;
    }

    const msg = resp.message;
    messages.push(msg);

    const toolCalls = msg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return msg.content || "[皮皮虾] (无回复)";
    }

    // 工具错误重试: 若本轮有工具失败, 汇总错误喂回模型修正后重试 (最多 maxErrorRetry 次)
    const errors = [];
    for (const tc of toolCalls) {
      if (tc.type === "function" && tc.function) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        // v1.6.0 第四刀: 超时检测 + 幂等重试一次 (tool/timeout 事件采集 P50/P95/P99 数据基础)
        const { result } = await callWithTimeoutRetry({
          name: tc.function.name,
          args,
          runTool,
          isIdempotent: isIdempotentTool(tc.function.name),
          budgetMs: toolTimeoutOf(tc.function.name),
          onEvent,
        });
        messages.push({ role: "tool", tool_call_id: tc.id, content: toToolContent(result, policy.resultBudget) });
        if (result.startsWith(TOOL_ERROR_PREFIX)) errors.push(result);
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
