// src/core/policy.js - 工具循环执行策略 (纯逻辑, 不依赖 agent 实例)
// 重构第一刀 (2026-09-14): 从 src/agent/index.js PPXAgent._llmWithTools 抽离。
// 抽走: 探索熔断 / 重复命令检测 / 溢出降档 / 错误重试 / 轮次上限 / 工具结果裁剪。
// 原则: 策略与执行分离 — agent 只负责"调 LLM、跑工具、传消息",
//       循环何时停、降档、重试、注入方向盘, 全由本模块决策。
//       依赖全部注入 (llm/tools/runTool/shrinkMessages/...), 无 agent 引用, 可独立测试。
import { TOOL_ERROR_PREFIX } from "./errors.js";
// 回合后置条件闸门 (2026-10-05): 收尾前的确定性自检 + 可行动反馈, 实现在 src/core/postcondition.js
import {
  runPostChecks, buildVerifyFeedback, formatGateFailure, distillTurnResult,
  DEFAULT_MAX_CHECKS_PER_TURN, DEFAULT_MAX_VERIFY_SPAWNS, DEFAULT_TURN_VERIFY_BUDGET_MS,
} from "./postcondition.js";
import { warn, debug } from "../utils/logger.js";

// ---- 阈值默认值 (config.agent.* 可覆盖) ----
export const DEFAULT_MAX_TOOL_ROUNDS = 8;
export const DEFAULT_TOOL_RESULT_BUDGET = 4000; // L4 toolResultBudget: 工具结果超过此长度裁剪, 防撑爆上下文
export const DEFAULT_MAX_TOOL_ERROR_RETRY = 2;
export const DEFAULT_OVERFLOW_SHRINK_MAX = 2;
// 后置校验失败后的修正机会上限 (小, 且必须小): 拦一次→模型改→再拦→再改→再拦不动就诚实收尾。
// 没有这个 bound, 一个"永远不可能通过"的检查会把回合活锁到 maxRounds 烧光。
export const DEFAULT_MAX_POSTCHECK_RETRY = 2;

// P0③ harness 融断: 探索连击 / 重复命令 阈值 (config.agent.explore_break_limit / repeat_flag_limit 可调)
export const DEFAULT_EXPLORE_BREAK = 3;   // 连续 3 轮只有只读/查询无产出 -> 融断
export const DEFAULT_REPEAT_FLAG = 2;     // 同一工具+args 命中 2 次 -> 警告重复

// 探索类工具集 (read-only/发现; 不算"产出或修改")
export const EXPLORE_TOOLS = new Set([
  "read_file", "list_dir", "web_search", "fetch_page", "memory_search", "read_document",
  "get_time", "read_image", "ocr_image", "list_schedules", "list_capabilities", "replay_session",
]);

// 单段别名配置读取的归一 (0 是合法值, 不能用 `||` 兜; 非有限数/负数才回落默认)
function localNum(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// 本轮任务的原始用户诉求 (多模态 content 取文本段拼接)。
// 必须从 seedMessages 取: 循环中途注入的方向盘/校验反馈同样是 role=user,
// "最后一条 user"到收尾时早已是 harness 自己的话, 拿它判"用户是否要求改文件"必错。
function seedUserText(seedMessages) {
  const list = Array.isArray(seedMessages) ? seedMessages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((c) => (c && c.type === "text" ? String(c.text || "") : "")).join(" ");
    }
  }
  return "";
}

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
  const ev = (type, payload) => { if (onEvent) { try { onEvent(type, payload); } catch (e) { debug(`[core/policy] 已忽略异常: ${e && e.message ? e.message : e}`); } } };
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
// 阈值读取一律走 localNum(c.xxx) 这种"别名后的单段读取", 与既有 c.explore_break_limit 同款
// (test/config-consistency.test.js 的反向守卫只静态扫 `config.x.y` 两段以上字面量)。
export class ToolLoopPolicy {
  constructor(cfg = {}) {
    const c = cfg || {};
    this.maxRounds = Number(c.max_tool_rounds) || DEFAULT_MAX_TOOL_ROUNDS;
    this.resultBudget = Number(c.tool_result_budget) || DEFAULT_TOOL_RESULT_BUDGET;
    this.maxErrorRetry = Number(c.max_tool_error_retry) || DEFAULT_MAX_TOOL_ERROR_RETRY;
    this.exploreBreak = Number(c.explore_break_limit) || DEFAULT_EXPLORE_BREAK;
    this.repeatFlag = Number(c.repeat_flag_limit) || DEFAULT_REPEAT_FLAG;
    this.overflowShrinkMax = DEFAULT_OVERFLOW_SHRINK_MAX;
    // 同轮独立工具调用并发执行 (2026-10-01 优化): 默认开, agent.parallel_tool_calls=false 回退串行
    this.parallelToolCalls = c.parallel_tool_calls !== false;
    // ---- 回合后置条件闸门 (2026-10-05, 真跑基准"宣称完成而字节不支持"复盘) ----
    // 默认开且窄: 只在本轮确有写类调用成功落盘、且对其碰过的文件跑出来的确定性检查确实不过时
    // 才拒绝收尾。关掉它只有一条显式路径 (agent.postcondition_gate=false), 不提供"默认关+
    // 文档里藏着"的退路 —— 上一轮那种"装了旋钮没接线"的教训不再重复。
    this.postCheck = c.postcondition_gate !== false;
    this.maxPostCheckRetry = localNum(c.postcondition_retries, DEFAULT_MAX_POSTCHECK_RETRY);
    this.postCheckMaxChecks = localNum(c.postcondition_max_checks, DEFAULT_MAX_CHECKS_PER_TURN);
    this.postCheckMaxSpawns = localNum(c.postcondition_max_spawns, DEFAULT_MAX_VERIFY_SPAWNS);
    this.postCheckBudgetMs = localNum(c.postcondition_budget_ms, DEFAULT_TURN_VERIFY_BUDGET_MS);
    // 运行时状态 (每轮循环实例持有, 重启归零)
    this.errorRetries = 0;
    this.exploreStreak = 0;
    this.seenSig = new Map();
    this.overflowShrinks = 0;
    this.postCheckRetries = 0;
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
      try { a = JSON.parse(tc.function.arguments || "{}"); } catch (e) { debug(`[core/policy] 已忽略异常: ${e && e.message ? e.message : e}`); }
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

  // ---- 回合后置校验: 是否还给一次修正机会 ----
  // 与 shouldRetryErrors 同款"次数闸门", 但对象不同: 那条管工具**调用报错**, 这条管
  // "调用都成功了、回复却与磁盘字节不符" (MAST 归因里的 task-verification 缺口)。
  // bound 小 (默认 2) 是硬要求: 检查可能永远不可能通过 (模型压根没打算写文件),
  // 没有 bound 就会和 maxRounds 一起把回合活锁成纯烧 token。
  shouldRetryPostCheck() {
    if (this.postCheckRetries >= this.maxPostCheckRetry) return false;
    this.postCheckRetries++;
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
//   postCondition    { rootDir, capabilityOf?, exec? } | null, 回合后置条件闸门依赖:
//                    rootDir 是工作区根 (没有它无从查盘 → 闸门整段失效),
//                    capabilityOf(name) 查工具能力声明 (判定只读/写类, 缺省用内置名单),
//                    exec 注入 `node --check` 执行器 (测试计数 spawn 用, 缺省真子进程)
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
  postCondition = null,
}) {
  const policy = new ToolLoopPolicy(config.agent || config);
  let messages = [...seedMessages];
  const ev = (type, payload) => { if (onEvent) { try { onEvent(type, payload); } catch (e) { debug(`[core/policy] 已忽略异常: ${e && e.message ? e.message : e}`); } } };
  // ---- 回合后置条件闸门的本轮状态 (2026-10-05) ----
  // 插在这里而不是 chat()/chatStream() 的理由: 全仓只有 runToolLoop 这一处同时看得见
  //   (a) 本轮跑过哪些工具 (turnCalls)、(b) 每次调用的 args 与 result、(c) 模型刚生成的终稿。
  //   chat() 只拿到返回的字符串; _runTool 只有单次调用, 看不见"回合"这个整体。
  // 无 rootDir (老调用方/纯逻辑测试) → gate=null → 整段行为与此前逐字节一致。
  const gate = policy.postCheck && postCondition && postCondition.rootDir ? postCondition : null;
  const turnCalls = [];                    // [{name,args,result}] 按发生顺序, 闸门唯一的文件清单来源
  const taskUserText = seedUserText(seedMessages); // 原始诉求 (steering 也注入 role=user, 故只能按 seed 取)

  for (let round = 0; round < policy.maxRounds; round++) {
    if (isInterrupted()) return "[皮皮虾] 任务已被中断 (operator cancelled).";
    if (onStep) { try { onStep({ type: "step", round, maxRounds: policy.maxRounds, ts: Date.now() }); } catch (e) { debug(`[core/policy] 已忽略异常: ${e && e.message ? e.message : e}`); } }

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
      const draft = msg.content || "[皮皮虾] (无回复)";
      // ---- 回合后置条件闸门 (2026-10-05, 真跑基准"宣称完成而字节不支持"复盘) ----
      // 模型不再发工具调用 = 它认为本轮可以说完了。就在把这句话交给用户之前, harness 自己
      // 跑一遍确定性检查 (src/core/postcondition.js): 本轮写过的文件此刻在盘上到底成不成立、
      // 以及"有没有只在回复里声称改好却一个写工具都没调"。
      // 失败不堵墙: 走既有 steering 通道 (role=user 追加一条可行动反馈) 让模型修, 修好再收尾。
      // 失败的那条 assistant 草稿原样留在 messages 里 —— 历史 append-only, 绝不抹改。
      if (gate && !isInterrupted()) {
        let verdict = null;
        try {
          verdict = await runPostChecks({
            rootDir: gate.rootDir,
            capabilityOf: gate.capabilityOf,
            exec: gate.exec,
            calls: turnCalls,
            finalMessage: draft,
            userMessage: taskUserText,
            maxChecks: policy.postCheckMaxChecks,
            maxSpawns: policy.postCheckMaxSpawns,
            budgetMs: policy.postCheckBudgetMs,
          });
        } catch (e) {
          // 闸门自身故障绝不拦轮 (可观测的 fail-open): 校验器坏了不能演变成"对话不可用"
          debug(`[core/policy] 后置校验异常, 本轮跳过: ${e && e.message ? e.message : e}`);
          ev("tool/postcheck_error", { round, message: String((e && e.message) || e).slice(0, 160) });
        }
        if (verdict) {
          ev("tool/postcheck", {
            round, ran: verdict.ran, spawns: verdict.spawns, skipped: verdict.skipped,
            checked: verdict.checked, failures: verdict.failures.length, ms: verdict.ms,
          });
          if (verdict.failures.length) {
            if (policy.shouldRetryPostCheck()) {
              ev("tool/postcheck_retry", {
                round, attempt: policy.postCheckRetries, max: policy.maxPostCheckRetry,
                checks: verdict.failures.map((f) => f.id),
              });
              messages.push({
                role: "user",
                content: buildVerifyFeedback({
                  failures: verdict.failures, notes: verdict.notes,
                  attempt: policy.postCheckRetries, max: policy.maxPostCheckRetry,
                }),
              });
              continue;
            }
            // 修正机会用尽 → 诚实上报, 绝不给一条干净的 "done" (项目规则: 没有工具可以宣称
            // 自己证明不了的成功; 反过来, 回合也不许替模型把未证明的完成洗白)
            ev("tool/postcheck_exhausted", {
              round, attempts: policy.postCheckRetries, checks: verdict.failures.map((f) => f.id),
            });
            warn(`后置校验未通过 × ${verdict.failures.length} 项, 修正机会 ${policy.postCheckRetries}/${policy.maxPostCheckRetry} 用尽: `
              + verdict.failures.map((f) => f.message).join(" | ").slice(0, 220));
            return formatGateFailure({
              failures: verdict.failures, notes: verdict.notes,
              attempts: policy.postCheckRetries, draft,
            });
          }
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
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) { debug(`[core/policy] 已忽略异常: ${e && e.message ? e.message : e}`); }
        callable.push({ tc, args });
      }
    }
    // v3.2.3 (P2#13): tool_calls 存在但全部无法解析 (type!=function / function 缺失) 时,
    // callable 为空 → 本轮不产生任何 tool 消息 → 下一轮请求因 assistant.tool_calls 无对应
    // tool 响应直接 400, 8 轮循环全烧在 400 上零产出。补占位 tool 消息 (tool_call_id 对齐,
    // 内容为可判读错误) 让模型收到纠错机会, 不再产生空转轮次。
    if (callable.length === 0) {
      for (const tc of toolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          _id: tc.id,
          content: toToolContent(TOOL_ERROR_PREFIX + "工具调用格式无效 (缺少 function 字段), 请以正确的 function 调用格式重试或直接回答用户。", policy.resultBudget),
        });
      }
      continue;
    }
    // v1.6.0 第四刀语义保留: 超时检测 + 幂等重试一次 (tool/timeout 事件采集 P50/P95/P99 数据基础)
    const execOne = ({ tc, args }) => callWithTimeoutRetry({
      name: tc.function.name,
      args,
      runTool,
      isIdempotent: isIdempotentTool(tc.function.name),
      budgetMs: toolTimeoutOf(tc.function.name),
      onEvent,
    }).then((r) => {
      // 后置条件闸门要的是"本轮到底跑了哪些调用"的事实 (args + 回执里的 bytes/syntax/file)。
      // 结果原文可长达几百 KB, 入队前蒸馏成摘要 (20 并发下不撑爆堆); 闸门关闭 (gate=null) 时整段不发生。
      if (gate) turnCalls.push({ name: tc.function.name, args, result: distillTurnResult(r.result) });
      return { tc, ...r };
    });
    const errors = [];
    const collect = (tc, result) => {
      // 2026-10-03 修复 (P1): 原 tool 消息只有非标 `_id`, 缺 OpenAI 规范要求的 tool_call_id
      // → 严格校验后端 (OpenAI 官方 / vLLM) 第二轮必 400。补上标准字段; `_id` 保留兼容内部消费方
      messages.push({ role: "tool", tool_call_id: tc.id, _id: tc.id, content: toToolContent(result, policy.resultBudget) });
      if (result.startsWith(TOOL_ERROR_PREFIX)) errors.push(result);
    };
    if (policy.parallelToolCalls) {
      const settled = await Promise.all(callable.map(execOne));
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
  return "[皮皮虾] 工具调用轮次过多, 已停止。";
}
