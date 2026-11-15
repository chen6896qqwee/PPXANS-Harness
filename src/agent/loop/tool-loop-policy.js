// src/agent/loop/tool-loop-policy.js - 工具循环策略原语 (纯逻辑, 不依赖 agent 实例)
// 2026-11-03 从 policy.js 拆出 (原单文件 682 行超 600 阈值):
//   本文件 = 阈值默认值 / ToolLoopPolicy 状态机 / 结果裁剪 / 溢出判定 / 超时重试 /
//            参数解析 / 有界并发;  执行编排 (runToolLoop) 在 loop/tool-loop.js。
// 重构第一刀 (2026-09-14): 从 src/agent/index.js PPXAgent._llmWithTools 抽离。
// 原则: 策略与执行分离 — agent 只负责"调 LLM、跑工具、传消息",
//       循环何时停、降档、重试、注入方向盘, 全由本模块决策。
//       依赖全部注入 (llm/tools/runTool/shrinkMessages/...), 无 agent 引用, 可独立测试。
// TOOL_ERROR_PREFIX 走 core/errors.js (纯常量, 零依赖) ——
//   原先从 ../tools/index.js 导入, 构成 core → tools 反向边 (与 tools → postcondition 成环)。
//   常量已下沉到 core(L1), 这里接上即可断环 (2026-10-10 arch-guard 检出 core → tools → core)。
import { TOOL_ERROR_PREFIX, isToolErrorResult } from "../../core/errors.js";
import { stableJson } from "../../utils/canonical.js";

// ---- 阈值默认值 (config.agent.* 可覆盖) ----
export const DEFAULT_MAX_TOOL_ROUNDS = 8;
export const DEFAULT_TOOL_RESULT_BUDGET = 4000; // L4 toolResultBudget: 工具结果超过此长度裁剪, 防撑爆上下文
// 2026-10-24 (R10): 空回复哨兵 —— provider 返回空 content 且无 tool_calls 时循环以此收尾。
//   agent._llmWithFallback 据此判定"该 provider 没给出答案", 还有备选就切换下一个,
//   而不是把"(无回复)"当最终答案交付。
export const EMPTY_REPLY = "[皮皮虾] (无回复)";
// 对外错误文案统一转译 (含 llmFailedHint) —— 与 agent/_shortReason 共用同一实现, 防口径漂移
import { llmFailedHint } from "../../utils/public-error.js";
import { noteCatch } from "../../utils/catch-log.js";
export const DEFAULT_MAX_TOOL_ERROR_RETRY = 2;
export const DEFAULT_OVERFLOW_SHRINK_MAX = 2;
// 回合级后置校验闸门 (2026-10-05): 收尾前 harness 自跑确定性检查, 不过则经 steering 通道把
// 失败喂回模型修正 —— 修正机会上限 2 次, 用尽则诚实上报 (不是无限重试, 也不是静默放行)。
export const DEFAULT_MAX_POSTCHECK_RETRY = 2;

// P0③ harness 融断: 探索连击 / 重复命令 阈值 (config.agent.explore_break_limit / repeat_flag_limit 可调)
export const DEFAULT_EXPLORE_BREAK = 5;   // 连续 5 轮只读/查询无产出 -> 融断 (2026-10-30: 3 轮太紧, 见构造器注释)
const DEFAULT_REPEAT_FLAG = 2;     // 同一工具+args 命中 2 次 -> 警告重复

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

// 硬拒绝强制收口 (2026-11-14, 评测 P2-5): 同一回合内第 2 次 hard-deny 裁决时, 不再注入
//   "方向盘消息"后继续循环 (生产实测: 写桌面被拒后连续换 4 种工具绕行, 每次换工具都绕过
//   repeat 检测 —— 闸门拦得住, 行为面在空转烧轮次)。补一次不带工具的收口调用, 诚实交代
//   被什么闸门拒绝、已完成什么、用户有哪些替代路径。关掉用 config.agent.hard_deny_finalize=false。
export const SELF_REVIEW_FINALIZE_PROMPT = [
  "安全闸门已多次拒绝本回合的操作, 现在开始不允许再调用任何工具, 也不要尝试绕过闸门。",
  "请只基于上面已经产生的工具结果, 直接给出最终收口:",
  "1) 被拒绝的具体是什么操作、撞的是哪道闸门 (引用失败详情原文);",
  "2) 在闸门允许的范围内, 已经完成了什么 (必须有工具结果支撑, 不要凭印象补);",
  "3) 用户有哪些可立即执行的替代路径 (例如: 手动操作 / 调整 security 配置 / 改用允许范围内的方案)。",
  "纪律: 不要把被拒绝的操作说成已完成, 不要建议绕过安全闸门, 不确定就写不确定。",
].join("\n");

// 硬拒绝收口失败时的回落文案 (收口 LLM 调用失败/空回复 → 仍诚实交代, 不假装成功)
export const SELF_REVIEW_STOP_TEXT = "[皮皮虾] 本回合多次被安全闸门拒绝, 已停止执行 (未完成的部分见上方失败详情)。如确需执行, 请调整 security 配置或改用允许范围内的方案后重试。";

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

// 链式召回版工具结果裁剪 (2026-11-01 v4.1 平台化): 超预算结果先全文归档 (spill,
// 由调用方注入 {put(text,meta)->{id}}, 见 src/tools/spill.js), 告示牌带 spill_id ——
// 模型可用 context_read 工具按 offset 续读全文, 裁剪不再是死路。
// 设计溯源 docs/PROVENANCE.md#dsh; 自研 spill-notice 语义: "omitted N bytes. Full result stored at: <locator>"。
// 归档是纯注入接口 (鸭子类型), 本文件不 import tools/ 层 —— core(L1)→tools(L3) 是
// arch-guard 禁止的越层边; spill 存储实例由 agent (_llmWithTools) 注入。
// 未注入 spill / 归档失败时回落纯裁剪 (旧行为, 不阻塞工具回填)。
export function toolContentWithSpill(result, budget = DEFAULT_TOOL_RESULT_BUDGET, { spill, tool = "", callId = "" } = {}) {
  const s = String(result ?? "");
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(s)) {
    return [{ type: "image_url", image_url: { url: s } }];
  }
  if (s.length <= budget) return s;
  let spillId = null;
  if (spill && typeof spill.put === "function") {
    try { spillId = spill.put(s, { tool, callId })?.id || null; } catch { /* 归档失败降级为纯裁剪 */ }
  }
  const head = s.slice(0, budget * 0.7);
  const tail = s.slice(-budget * 0.3);
  const notice = spillId
    ? `\n...[结果已裁剪: 共 ${s.length} 字符, 保留头尾 ${budget}; 全文已归档 spill_id=${spillId}, 可调用 context_read 工具按 offset 分页续读]...\n`
    : `\n...[结果已裁剪: 共 ${s.length} 字符, 保留头尾 ${budget}]...\n`;
  return head + notice + tail;
}

// ---- 超时检测与重试 (v1.6.0 第四刀: 首个功能增量, 非等价重构) ----
// 语义: 工具层 (seam.js runWithPolicy) 已用 AbortController 真中断底层执行 (资源超时),
//       这里负责策略层: 超时结果识别 + 幂等工具重试一次 + tool.timeout 事件采集。
// 边界 (最小版本): 不搞退避/熔断/自适应预算 — 留到有真实超时数据后 (第五刀) 再设计。
// 返回: { result, elapsedMs, timedOut, retried }
export function isTimeoutResult(r) {
  if (!isToolErrorResult(r)) return false;
  const s = String(r);
  // 2026-11-14 (评测 P2-2): 审批等待超时的结果文本是 TOOL_ERROR_PREFIX + "[permission] 工具 X
  //   审批被拒绝或超时" (approval.js:87 拼接), 含"超时"二字 —— 旧实现把它误判为执行超时,
  //   tool/timeout 事件里 elapsedMs(含审批等待, 生产实测 120003ms) 与 budgetMs(执行预算 30000ms)
  //   口径撞车。审批等待的终态由 approval/resolved(decision:timeout) + tool/perm-rejected 采集,
  //   这里排除 [permission] 面, 执行超时 (seam/builtin-exec 的 "[工具错误] X: 超时") 不受影响。
  if (s.includes("[permission]") || s.includes("审批")) return false;
  return s.includes("超时");
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
  constructor(cfg = {}, { contextWindow = 0 } = {}) {
    const c = cfg || {};
    this.maxRounds = Number(c.max_tool_rounds) || DEFAULT_MAX_TOOL_ROUNDS;
    // v5.0 真 token 预算 (P2.2): tool_result_budget 配 0 = 随 provider 真实窗口自适应
    //   (>=64K 窗口 → 8000 字符, >=32K → 6000, 其余保守默认)。显式配置的数值优先。
    const rawBudget = Number(c.tool_result_budget);
    const win = Number(contextWindow) || 0;
    this.resultBudget = rawBudget > 0
      ? rawBudget
      : (win >= 64000 ? 8000 : win >= 32000 ? 6000 : DEFAULT_TOOL_RESULT_BUDGET);
    this.maxErrorRetry = Number(c.max_tool_error_retry) || DEFAULT_MAX_TOOL_ERROR_RETRY;
    this.exploreBreak = Number(c.explore_break_limit) || DEFAULT_EXPLORE_BREAK;
    this.repeatFlag = Number(c.repeat_flag_limit) || DEFAULT_REPEAT_FLAG;
    this.overflowShrinkMax = DEFAULT_OVERFLOW_SHRINK_MAX;
    // 回合级后置校验闸门 (2026-10-05): 默认开 —— 不藏在配置后面的默认关里。
    this.postCheck = c.postcondition_gate !== false;
    // 硬拒绝强制收口 (2026-11-14, 评测 P2-5): 同回合第 N 次 hard-deny 裁决 → 终止循环并收口。
    //   默认 2: 第一次拒绝给一次改路径的机会, 第二次说明在撞同一道闸门, 空转没有产出。
    this.hardDenyFinalize = c.hard_deny_finalize !== false;
    this.hardDenyFinalizeMax = Math.max(1, Number(c.hard_deny_finalize_rounds) || 2);
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
    this.hardDenyStops = 0; // 2026-11-14 (评测 P2-5): 本回合硬拒绝拦停次数
  }

  // 硬拒绝计数 (调用即计数): 返回 true = 本回合已连续撞闸门达阈值, 应终止工具循环并强制收口。
  shouldFinalizeHardDeny() {
    this.hardDenyStops++;
    return this.hardDenyFinalize && this.hardDenyStops >= this.hardDenyFinalizeMax;
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
      try { a = JSON.parse(tc.function.arguments || "{}"); } catch (e) { noteCatch(e); }
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
    // 2026-11-14 (评测 P2-5): 补 [permission] 前缀 / 路径越界 / "被拒绝" 后缀 —— 生产实测
    //   路径越界文案 ("[permission] 工具 X 被拒绝: 路径越界拒绝") 不含"权限"二字, 旧正则
    //   全部漏判, 四连绕行期间一次 self_review_stop 都没触发过。
    if (/命中后不要重试|改造命令绕过|硬黑名单|审批被拒绝|审批拒绝|权限.*拒|\[permission\]|路径越界|被拒绝|deny|DENY|拦截/i.test(text)) {
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

// ---- 工具参数解析 (2026-11-02) ----
// 旧实现 `try { JSON.parse(...) } catch {}` 把坏 JSON 静默变成 {} 再执行:
//   轻则工具报"缺参数"绕一圈, 重则调用了一个"全默认值"的工具 (例如删/改到错误目标)。
// 现在坏参数不执行, 直接把可行动的诊断作为工具结果喂回模型 (带收到的原文片段 + 取 schema 的入口)。
export function parseToolArguments(name, raw) {
  const text = raw == null ? "" : String(raw);
  if (!text.trim()) return { ok: true, args: {} };
  let v;
  try { v = JSON.parse(text); } catch (e) {
    const preview = text.length > 160 ? text.slice(0, 160) + "…" : text;
    return {
      ok: false,
      args: {},
      error: `${TOOL_ERROR_PREFIX} ${name}: arguments 不是合法 JSON (${String(e?.message || e).slice(0, 80)}); 收到: ${preview}`
        + `. 请重新生成完整 JSON 对象 (字符串内的引号/换行必须转义); 不确定参数结构先调 tool_schema("${name}")。`,
    };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return {
      ok: false,
      args: {},
      error: `${TOOL_ERROR_PREFIX} ${name}: arguments 必须是 JSON 对象, 实际是 ${Array.isArray(v) ? "数组" : typeof v}。`
        + ` 不确定参数结构先调 tool_schema("${name}")。`,
    };
  }
  return { ok: true, args: v };
}

