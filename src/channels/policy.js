// src/channels/policy.js - Trigger 两级事件过滤 (2026-10-31 Super-agent 一期地基)
//
// 对照 DeepSeek《Super-agent 设计探索》§3.1: 接入真实群聊/代码平台后, 事件流呈
// "高噪音、低触发率" —— 对每条事件都调大模型从头判断, 延迟与成本都不可承受。
// 借鉴 Fast Path / Slow Path:
//   第一级 admitTrigger (程序层, 纯函数, 零成本): 渠道/群组/发送者黑白名单,
//     first-match-wins (与 permissions 规则链同风格); mode="all" 时行为与无过滤完全一致。
//   第二级 admitSemantic (语义层, 可选): 程序层放行的候选事件交 LLM 按提示词策略判断;
//     fail-open —— LLM 不可用/超时/异常一律放行 (拦错用户消息比多处理一条噪音代价更高)。
//
// 配置 (config/ppx.json → agent.trigger_policy, 防御式读取, 无配置 = 行为不变):
//   {
//     mode: "all" | "whitelist" | "off",
//     semantic: false,                  // 是否启用语义层
//     semantic_prompt: "…",             // 语义层附加策略 (自然语言, 随时热调)
//     deny_groups: [], allow_groups: [],   // 群组黑/白名单 (deny 优先)
//     deny_senders: [], allow_senders: [], // 发送者黑/白名单
//     session_mapping: "chat" | "shared"   // 见 trigger.js sessionKeyForTrigger
//   }
import { sessionKeyForTrigger } from "./trigger.js";

// 防御式归一: 任何脏配置都收敛成安全默认 (mode="all" = 不过滤)
export function normalizePolicy(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  const mode = ["all", "whitelist", "off"].includes(p.mode) ? p.mode : "all";
  return {
    mode,
    semantic: p.semantic === true,
    semantic_prompt: typeof p.semantic_prompt === "string" ? p.semantic_prompt : "",
    deny_groups: arr(p.deny_groups),
    allow_groups: arr(p.allow_groups),
    deny_senders: arr(p.deny_senders),
    allow_senders: arr(p.allow_senders),
    session_mapping: p.session_mapping === "shared" ? "shared" : "chat",
  };
}

// 第一级: 程序层准入 (纯函数, 同步, 零成本)
export function admitTrigger(trigger, rawPolicy) {
  const p = normalizePolicy(rawPolicy);
  const t = trigger || {};
  if (p.mode === "off") return { ok: false, reason: "mode=off" };
  // 黑名单先于白名单: deny 恒胜 (误拉黑可显式发现, 放行黑名单是事故)
  if (t.group && p.deny_groups.includes(t.group)) return { ok: false, reason: "deny_groups 命中" };
  if (t.from && p.deny_senders.includes(t.from)) return { ok: false, reason: "deny_senders 命中" };
  if (p.mode === "whitelist") {
    const gOk = !!(t.group && p.allow_groups.includes(t.group));
    const sOk = !!(t.from && p.allow_senders.includes(t.from));
    if (!gOk && !sOk) return { ok: false, reason: "whitelist 未命中" };
  }
  return { ok: true, reason: "pass" };
}

// 第二级: 语义层准入 (可选, LLM 判断, fail-open)
export async function admitSemantic(trigger, agent) {
  const p = normalizePolicy(agent?.config?.agent?.trigger_policy);
  if (!p.semantic) return { ok: true, reason: "semantic=off" };
  const llm = agent?.auxLLM || agent?.llm;
  if (!llm || typeof llm.chat !== "function") return { ok: true, reason: "无 LLM, fail-open" };
  try {
    const sys = [
      "你是消息过滤器, 判断一条发给助手的消息是否需要助手处理。",
      "只回答一个词: YES (需要处理) 或 NO (噪音/无需处理), 不要解释。",
      p.semantic_prompt ? `策略: ${p.semantic_prompt}` : "",
    ].filter(Boolean).join("\n");
    const src = [trigger?.source, trigger?.group ? "群聊" : "私聊", trigger?.from].filter(Boolean).join(" ");
    const r = await llm.chat(
      [
        { role: "system", content: sys },
        { role: "user", content: `来源: ${src}\n消息: ${String(trigger?.text || "").slice(0, 500)}` },
      ],
      { timeoutMs: 8000, retryMax: 0 },
    );
    const reply = String(r?.content || r || "").trim().toUpperCase();
    const ok = !reply.startsWith("NO");
    return { ok, reason: ok ? "semantic: YES" : "semantic: NO" };
  } catch (e) {
    return { ok: true, reason: `semantic fail-open: ${e.message}` };
  }
}

/**
 * 组合门: 程序层 → 语义层 → 会话键, 全程 tracer 留痕。
 * 返回 { ok, sessionKey } —— sessionKey 为 null 表示回退 shared 旧行为 (调用方不传)。
 * feishu/wechat/base 三处入站共用, 过滤语义只写一份。
 */
export async function admitThroughPolicy(trigger, agent) {
  const cfg = agent?.config?.agent?.trigger_policy || {};
  const g1 = admitTrigger(trigger, cfg);
  try {
    agent?.tracer?.event?.(g1.ok ? "trigger/admitted" : "trigger/filtered",
      { id: trigger?.id, source: trigger?.source, stage: "program", reason: g1.reason });
  } catch { /* 观测失败不阻断 */ }
  if (!g1.ok) return { ok: false, sessionKey: null };
  const g2 = await admitSemantic(trigger, agent);
  try {
    agent?.tracer?.event?.(g2.ok ? "trigger/admitted" : "trigger/filtered",
      { id: trigger?.id, source: trigger?.source, stage: "semantic", reason: g2.reason });
  } catch { /* 观测失败不阻断 */ }
  if (!g2.ok) return { ok: false, sessionKey: null };
  // 归一后再传: sessionKeyForTrigger 期望驼峰 sessionMapping, config 键是下划线 session_mapping
  const np = normalizePolicy(cfg);
  return { ok: true, sessionKey: sessionKeyForTrigger(trigger, { sessionMapping: np.session_mapping }) };
}
