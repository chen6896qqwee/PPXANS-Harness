// src/evolve/speculative.js - 投机复现修复 (2026-11-01 v4.2 持久化, 设计稿 §4.1 "静默复现修复")
//
// 语义 (对齐设计稿): 任务失败后不打扰用户 —— 轮收口边界上, harness 在后台**静默**复现失败,
//   把"结构化故障证据"沉淀进故障病历 (FailureEpisodeStore) 与经验库 (Experience),
//   让下一次相似故障检索命中 (failure-episode.search) 时直接看到"是否瞬态/如何复现"。
//
// 两个模式 (config.agent.speculative_repair):
//   "replay" (默认): 幂等工具原样重跑一次 (零 LLM 成本) ——
//     重跑成功 = 瞬态故障 (病历 confidence 低 + lesson "重试即愈");
//     重跑仍败 = 稳定复现 (病历留两次错误对照, 供下轮诊断检索)。
//   "full": replay 之上追加一次 chatAsync 诊断回合 (花 token, 显式开启才用)。
//   false/"off": 关闭。
//
// 安全边界:
//   - 非幂等工具绝不重放 (与 callWithTimeoutRetry 同口径: 副作用不二次执行);
//   - 每轮最多复现 maxReplays 条 (默认 3, 防失败风暴时后台放大);
//   - 复现在后台跑, 不进用户回复、不阻塞主链; 重放走注入的 runTool (权限/审计照常生效)。
//
// 层级: 本模块 L2 (evolve), 依赖全部注入 (runTool/stores/notify), 不 import L3。
import { stableJson } from "../utils/canonical.js";
import { isToolErrorResult } from "../core/errors.js";

const DEFAULT_MAX_REPLAYS = 3;

export function normalizeMode(v) {
  if (v === "full") return "full";
  if (v === false || v === "off" || v === "false") return "off";
  return "replay"; // true/undefined/"replay"
}

export function createSpeculativeRepair({
  failures = null,          // FailureEpisodeStore ({record, search}) — 鸭子类型注入
  experience = null,        // Experience ({learn})
  runTool,                  // (name, args) => Promise<string> — 复现执行通道 (agent._runTool, 权限/审计照常)
  isIdempotent = () => true,
  diagnose = null,          // full 模式: (text) => Promise<any> — chatAsync 诊断回合注入
  onEvent = null,           // (type, payload) => void — tracer/EQ 埋点
  maxReplays = DEFAULT_MAX_REPLAYS,
} = {}) {
  if (typeof runTool !== "function") throw new Error("speculative: runTool 必须注入");
  const ev = (type, payload) => { if (typeof onEvent === "function") { try { onEvent(type, payload); } catch { /* 埋点异常不阻断 */ } } };

  // category 推断 (病历五类闭集): 从错误文本粗分类, 供 search 相似命中
  function categorize(errText) {
    const s = String(errText || "");
    if (/429|限流|rate.?limit|throttl/i.test(s)) return "throttle";
    if (/ECONN|ETIMEDOUT|ENOTFOUND|网络|超时|timeout|fetch failed/i.test(s)) return "network";
    if (/401|403|权限|鉴权|unauthorized|forbidden|审批/i.test(s)) return "auth";
    if (/参数|无效|invalid|校验|missing|required/i.test(s)) return "validation";
    return "unknown";
  }

  // 复现一条失败: 返回 {reproduced, ms, secondError|null}
  async function replayOne(call) {
    const t0 = Date.now();
    try {
      const r = await runTool(call.name, call.args);
      const failed = isToolErrorResult(r);
      return { reproduced: failed, ms: Date.now() - t0, secondError: failed ? String(r).slice(0, 500) : null, result: String(r == null ? "" : r).slice(0, 200) };
    } catch (e) {
      return { reproduced: true, ms: Date.now() - t0, secondError: String(e?.message || e).slice(0, 500), result: null };
    }
  }

  // 轮收口时调度: failedCalls = [{name, args, error}] (agent 收集), 后台静默执行
  function schedule(failedCalls) {
    const calls = (Array.isArray(failedCalls) ? failedCalls : [])
      .filter((c) => c && c.name && isIdempotent(c.name))
      .slice(0, Math.max(1, Number(maxReplays) || DEFAULT_MAX_REPLAYS));
    if (!calls.length) return 0;
    const skipped = (failedCalls || []).length - calls.length;
    ev("spec/scheduled", { count: calls.length, skipped });
    // 后台微任务执行 (不 await 调用方; 各条独立 try, 单条失败不影响其余)
    (async () => {
      for (const call of calls) {
        try {
          const r = await replayOne(call);
          ev("spec/replayed", { tool: call.name, reproduced: r.reproduced, ms: r.ms });
          // 病历 (FailureEpisodeStore 首个真实消费方): 结构化证据落账
          try {
            failures?.record?.({
              tool: call.name,
              error: String(call.error || "").slice(0, 500),
              category: categorize(call.error),
              rootCause: r.reproduced ? "稳定复现: 隔离重放同样失败 (非瞬态)" : "瞬态: 隔离重放成功 (首次失败疑似限流/抖动)",
              fix: r.reproduced ? null : "重试即愈 —— 下次同型失败可先原样重试一次再诊断",
              confidence: r.reproduced ? 0.8 : 0.5,
              traceRef: stableJson(call.args, 200),
            });
          } catch { /* 病历失败不阻断 */ }
          // 经验库: 可检索的教训 (Experience.learn 自带去重)
          try {
            experience?.learn?.({
              task: `工具 ${call.name} 失败静默复现`,
              outcome: r.reproduced ? "复现失败" : "复现通过",
              lesson: r.reproduced
                ? `工具 ${call.name} 稳定复现失败 (隔离重放同样报错): ${String(r.secondError || call.error || "").slice(0, 160)} —— 下次先查故障病历再重试`
                : `工具 ${call.name} 首次失败但隔离重放成功, 属瞬态故障 —— 下次同型失败先原样重试一次`,
              tags: ["speculative", "tool-failure", call.name],
            });
          } catch { /* 经验失败不阻断 */ }
          // full 模式: 稳定复现才值得花一次诊断回合
          if (r.reproduced && typeof diagnose === "function") {
            try {
              await diagnose(
                `静默诊断任务: 工具 ${call.name} 刚才执行失败, 隔离重放同样失败 (稳定复现)。\n`
                + `首次错误: ${String(call.error || "").slice(0, 300)}\n重放错误: ${String(r.secondError || "").slice(0, 300)}\n`
                + `参数指纹: ${stableJson(call.args, 200)}\n请只读诊断: 给出最可能的根因与下一步修复建议, 不要执行任何修改类工具。`
              );
              ev("spec/diagnosed", { tool: call.name });
            } catch (e) {
              ev("spec/diagnose_failed", { tool: call.name, error: String(e?.message || e).slice(0, 200) });
            }
          }
        } catch { /* 单条复现异常不阻断其余 */ }
      }
    })();
    return calls.length;
  }

  return { schedule, replayOne, categorize };
}
