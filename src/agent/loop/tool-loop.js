// src/agent/loop/tool-loop.js - 工具循环执行驱动 (2026-11-03 从 policy.js 拆出)
// 文件头一直写着「策略与执行分离」: 阈值/状态机/结果裁剪在 tool-loop-policy.js,
// 这里只负责编排 (LLM 调用、流式回退、工具并发、后置校验、轮次耗尽收口)。
// 依赖仍然全部注入, 不持有 agent 引用; 对外口径不变, loop/policy.js 负责 re-export。
import { isToolErrorResult } from "../../core/errors.js";
import { warn } from "../../utils/logger.js";
import { runPostChecks, buildVerifyFeedback, formatGateFailure } from "../../verify/postcondition.js";
import {
  ToolLoopPolicy,
  EMPTY_REPLY,
  EXHAUSTED_STOP_TEXT,
  EXHAUSTED_FINALIZE_PROMPT,
  SELF_REVIEW_FINALIZE_PROMPT,
  SELF_REVIEW_STOP_TEXT,
  parseToolArguments,
  callWithTimeoutRetry,
  toolContentWithSpill,
  mapBounded,
} from "./tool-loop-policy.js";

// ---- 工具循环主驱动 (原 PPXAgent._llmWithTools) ----
// 依赖全部注入, 不持有 agent 引用:
//   seedMessages     初始消息数组 (system + history + user)
//   llm              LLM 客户端 (apiChat)
//   tools            OpenAI 格式工具声明数组, 或 () => 数组 (每轮重算; 按需曝光下
//                    tool_schema 可能在本轮把隐藏工具加入下一轮的函数数组)
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
  // 2026-11-01 (二期② thinking 通道): onReasoning(delta, {round}) 逐字回调推理模型的
  //   思考链增量 (reasoning_content); 思考全文随 onAssistantMsg 的 reasoning 字段聚合透出。
  //   缺省 = 思考链照旧不可见 (流式层不落正文, 防污染决策权在调用方)。
  onReasoning = null,
  signal = null,
  runTool,
  shrinkMessages,
  histTokenCap = () => 8192,
  // 回合级后置校验的注入点 (2026-10-05): { rootDir, capabilityOf, exec }。
  // 不传 = 不启用闸门 (纯逻辑测试/无工作区的调用方不受影响)。
  postCondition = null,
  // 链式召回 (2026-11-01 二期③): 超长工具结果全文归档存储 ({put(text,meta)->{id}})。
  // 注入后裁剪告示牌带 spill_id, 模型可用 context_read 工具续读; 不传 = 旧行为纯裁剪。
  spill = null,
}) {
  const policy = new ToolLoopPolicy(config.agent || config, { contextWindow: llm && llm.context_window || 0 });
  let messages = [...seedMessages];
  // 工具声明每轮取一次: 传函数时允许本轮工具调用改变下一轮的可见集合 (tool_schema 动态曝光)。
  const toolsNow = () => {
    if (typeof tools === "function") {
      try { return tools() || []; } catch { return []; }
    }
    return Array.isArray(tools) ? tools : [];
  };
  // 本回合同的工具调用轨迹 ({name, args, result}) —— 后置校验据此判断"本轮到底动过什么"
  const turnCalls = [];
  // 2026-11-14 (评测 P2-5): 硬拒绝达阈值后跳出循环的标记 —— 跳出后走强制收口而非轮次耗尽文案
  let hardDenyFinalize = false;
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
    // 进展事实随轮次事件回传 (2026-11-05): Router 侧据 steps/lastTool 更新父进程 assignment,
    //   看门狗才能区分"活着但空转"和"真的在推进" —— 只有 round 时看不到工具层进展。
    if (onStep) {
      const lastCall = turnCalls.length ? turnCalls[turnCalls.length - 1] : null;
      try {
        onStep({
          type: "step", round, maxRounds: policy.maxRounds,
          steps: turnCalls.length, lastTool: lastCall?.name || null, ts: Date.now(),
        });
      } catch { /* 进度观测失败不阻断工具循环 */ }
    }

    let resp;
    // 2026-11-01 (二期②): 思考链轮内聚合 (声明在循环级 —— 声明放进 try 块里,
    //   下游 onAssistantMsg 够不着; 溢出降档 continue 后也要归零重新聚合)
    let roundReasoning = "";
    let reasoningEmit = null;
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
      // 2026-11-03: 思考链通道不再只服务流式 —— 非流式 apiChat 也把 reasoning_content 带回,
      //   由本回调统一聚合 (此前非流式 provider 的思考链整段丢弃, worker 信封恒为 null)。
      reasoningEmit = onReasoning
        ? (t) => { if (!t) return; roundReasoning += t; try { onReasoning(t, { round }); } catch { /* 消费方异常不阻断流 */ } }
        : null;
      try {
        resp = streamCapable
          ? await llm.apiChatStream(messages, { tools: toolsNow(), onDelta: emit, onReasoning: reasoningEmit, signal })
          : await llm.apiChat(messages, {
            tools: toolsNow(),
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
          // 流式失败前可能已吐出部分思考链; 非流式兜底会从头给全文, 先归零防重复拼接
          roundReasoning = "";
          try {
            resp = await llm.apiChat(messages, {
              tools: toolsNow(),
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
    // 非流式路径: apiChat 带回的思考链补投给消费方 (流式路径已由 reasoning_content 增量覆盖)
    if (reasoningEmit && msg?.reasoning_content) reasoningEmit(String(msg.reasoning_content));
    messages.push(msg);
    if (onAssistantMsg) { try { onAssistantMsg({ round, content: msg.content || "", toolCalls: msg.tool_calls || [], reasoning: roundReasoning || null }); } catch { /* 采集异常不阻断主链 */ } }

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
        const parsed = parseToolArguments(tc.function.name || "?", tc.function.arguments);
        callable.push({ tc, args: parsed.args, argError: parsed.ok ? null : parsed.error });
      }
    }
    // v1.6.0 第四刀语义保留: 超时检测 + 幂等重试一次 (tool/timeout 事件采集 P50/P95/P99 数据基础)
    const execOne = async ({ tc, args, argError }) => {
      // 坏参数不执行工具: 直接回诊断, 让模型重写参数后重试 (幂等/安全都更优)
      if (argError) return { tc, result: argError, ok: false, ms: 0 };
      const r = await callWithTimeoutRetry({
        name: tc.function.name,
        args,
        runTool,
        isIdempotent: isIdempotentTool(tc.function.name),
        budgetMs: toolTimeoutOf(tc.function.name),
        onEvent,
      });
      return { tc, ...r };
    };
    const errors = [];
    const collect = (tc, result) => {
      // 2026-10-10 修复 (P1): 原用 `_id` 传工具调用 id —— 这是非标准字段, 严格 OpenAI 兼容
      //   后端在第二轮会因"tool 消息缺 tool_call_id / 无法与 assistant tool_calls.id 配对"回 400。
      //   现携带标准 `tool_call_id`; `_id` 保留供内部追踪 (不发送给后端的场景仍可用)。
      // 2026-11-01 (二期③链式召回): 超预算结果先全文归档 (spill), 告示牌带 spill_id ——
      //   模型可用 context_read 工具按 offset 续读全文, 裁剪不再是死路。
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        _id: tc.id,
        content: toolContentWithSpill(result, policy.resultBudget, {
          spill, tool: tc.function?.name || "", callId: tc.id || "",
        }),
      });
      if (isToolErrorResult(result)) errors.push(result);
      turnCalls.push({
        name: tc.function?.name || "",
        args: parseToolArguments(tc.function?.name || "?", tc.function?.arguments).args,
        result,
      });
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
    // 自省裁决 (语义闸门) 先于次数闸门 (评测-II P1-3): 硬拒绝类错误直接拦停, 不得盲目改写
    //   命令绕过。旧实现把裁决包在 shouldRetryErrors 里 —— 重试预算耗尽后次数闸门整段短路,
    //   硬拒绝连 self_review_stop / 强制收口都不再触发, 模型继续换工具绕行烧满轮次
    //   (生产实测 2026-11-08 s_mw8151np9quw: 10 次软错误打转, 24 轮耗尽收尾)。
    //   语义闸门是无状态纯正则, 先跑零成本; 次数闸门只约束"可修正错误"的重试次数。
    const verdict = policy.selfReviewError(errors);
    if (verdict && verdict.action === "stop") {
        ev("tool/self_review_stop", { round, reason: verdict.reason, retries: policy.errorRetries });
        // 2026-11-14 (评测 P2-5): 同回合第 2 次硬拒绝 → 强制收口。旧实现只注入方向盘消息后
        //   continue, 模型继续换工具绕行 (生产实测 write_file→run_command→move_file→list_dir
        //   四连试) —— 闸门拦得住, 行为面在空转烧轮次; 收口后诚实交代撞了哪道闸门。
        if (policy.shouldFinalizeHardDeny()) {
          hardDenyFinalize = true;
          break;
        }
        messages.push({
          role: "user",
          content: "自省裁决: " + verdict.reason + "\n失败详情:\n" + errors.join("\n") + "\n请停止重试, 直接基于已有信息给出结论, 或向用户说明原因。",
        });
        continue;
      }
      // 可修正类错误才受次数闸门约束 (硬拒绝已在上面短路): 预算耗尽则不再喂回错误,
      //   落到下方 recordTurn 方向盘 —— 与旧行为一致。
      if (policy.shouldRetryErrors(errors)) {
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
  // ---- 硬拒绝强制收口 (2026-11-14, 评测 P2-5) ----
  // 同回合连续撞闸门达阈值: 走与轮次耗尽同款的"补一次无工具收口", 事件与文案区分开
  //   (tool/self_review_finalize, 不冒用 exhausted_finalize) —— 失败回落 SELF_REVIEW_STOP_TEXT。
  if (hardDenyFinalize) {
    const okCalls = turnCalls.filter((c) => !isToolErrorResult(c.result)).length;
    const note = [
      "",
      "---",
      `⚠️ 本回合连续 ${policy.hardDenyStops} 次被安全闸门拒绝, 已停止执行 (${turnCalls.length} 次工具调用, 其中 ${okCalls} 次成功)。`,
      "如确需继续, 请调整 security 配置或改用允许范围内的方案后重试; 不要尝试绕过闸门。",
    ].join("\n");
    const text = await finalizeTurn({
      llm, messages, policy, turnCalls, isInterrupted, budgetBlocked, ev, onDelta,
      evName: "tool/self_review_finalize",
      evPayload: { stops: policy.hardDenyStops, calls: turnCalls.length },
      prompt: SELF_REVIEW_FINALIZE_PROMPT,
      note,
    });
    if (text) return text;
    return SELF_REVIEW_STOP_TEXT;
  }
  // ---- 轮次耗尽: 强制收口 (2026-10-30) ----
  // 旧行为: 循环跑满 maxRounds 就 return 一句"轮次过多, 已停止", 中间几轮的工作全丢。
  // 新行为: 若确实执行过工具 (有轨迹)、用户没叫停、预算没烧穿, 补一次**无工具**的调用
  //   让模型基于已有结果收口; 收口失败/空回复/无轨迹时仍回落到原文案 (绝不假装成功)。
  const finalizeNote = await finalizeTurn({
    llm, messages, policy, turnCalls, isInterrupted, budgetBlocked, ev, onDelta,
  });
  if (finalizeNote) return finalizeNote;
  return EXHAUSTED_STOP_TEXT;
}

// 强制收口: 返回「收口正文 + 诚实标注」或 null (= 调用方回落硬停止文案)。
// 边界: 无工具轨迹不收口 (没有可总结的东西, 多花一次调用纯亏); 中断/预算优先。
// 2026-11-14 (评测 P2-5): 从 exhaustedFinalizeText 泛化 —— exhausted 与硬拒绝两条路径共用
//   同一收口管道, 事件名/提示词/尾注可注入; exhausted 路径的默认参数保持原字节行为。
async function finalizeTurn({
  llm, messages, policy, turnCalls, isInterrupted, budgetBlocked, ev, onDelta,
  evName = "tool/exhausted_finalize",
  evPayload = null,
  prompt = EXHAUSTED_FINALIZE_PROMPT,
  note = null,
}) {
  if (!policy.exhaustedFinalize) return null;
  if (!turnCalls || !turnCalls.length) return null;                    // 没有实际动作, 不编总结
  try { if (isInterrupted && isInterrupted()) return null; } catch { return null; }
  if (budgetBlocked) {
    // 预算已烧穿时再补一次调用 = 明知没钱还点单, 直接放弃收口
    try { if (budgetBlocked()) return null; } catch { /* 闸门本身异常: 不当作已耗尽 */ }
  }
  if (!llm || typeof llm.apiChat !== "function") return null;
  ev(evName, evPayload || { rounds: policy.maxRounds, calls: turnCalls.length });
  const okCalls = turnCalls.filter((c) => !isToolErrorResult(c.result)).length;
  try {
    const resp = await llm.apiChat(
      [...messages, { role: "user", content: prompt }],
      { tools: [] }, // 关键: 不给工具 —— 否则模型会继续调用, 收口变成下一轮
    );
    const text = String(resp?.message?.content || "").trim();
    if (!text) return null;
    if (typeof onDelta === "function") {
      // 流式通道: 收口正文同样要给用户看到 (此前只在非流式返回里)
      try { onDelta(text, { finalize: true }); } catch { /* 推送失败不影响返回值 */ }
    }
    const tail = note || [
      "",
      "---",
      `⚠️ 工具轮次上限已用尽 (${policy.maxRounds} 轮 / ${turnCalls.length} 次工具调用, 其中 ${okCalls} 次成功)。` +
        "以上是基于已完成步骤的收口总结, 本轮未再执行任何新操作; 未完成的部分见上文第 2 条。",
    ].join("\n");
    return [text, tail].join("\n");
  } catch (e) {
    warn(`强制收口失败, 回落硬停止: ${String(e?.message || e).slice(0, 120)}`);
    return null;
  }
}
