// src/memory/compact-engine.js - 压缩引擎 (架构优化 ⑨, 2026-11-13)
//
// 问题 (审计结论): "把旧对话压成摘要"这件事在仓里有两份实现 ——
//   `agent/context.js._maybeCompact` 与 `agent/evidence.js._maybeCompact`,
//   各自 replay 会话、各自算 upToSeq、各自调 LLM、各自写 session 事件。差别只在
//   证据侧多了保真闸门、上下文侧多了 spill 归档 —— 于是"压不压、压到哪、压完能不能续读"
//   取决于哪个 mixin 的方法最后挂上 prototype。
//
// 做法 (借 DSH 的 compaction 接缝形状): 一个引擎 + 三种事件 + 一把锁。
//   - 事件: compaction/start → compaction/summary → compaction/end (失败/跳过也发 end,
//     带 status 与原因) —— 压缩从此可观测, 不再靠 warn 猜;
//   - 锁: 同一会话同时只允许一次压缩 (两个调用点并发触发时, 后到的直接退让, 不重复烧 LLM);
//   - 行为不变: 阈值/取半规则仍走 compactionSplit 单源, 保真闸门与 spill 归档按开关保留。
//
// 约束: 零依赖; 不 import agent (从入参拿能力), 免得 memory ← agent 反向依赖。
import { buildCompactionMessages, transcriptToText, compactionSplit } from "./compaction.js";
import { noteCatch } from "../utils/catch-log.js";

// agent 实例 → 正在压缩的会话集合
const locks = new WeakMap();

function lockSet(agent) {
  let s = locks.get(agent);
  if (!s) { s = new Set(); locks.set(agent, s); }
  return s;
}

export function isCompacting(agent, sessionKey = "default") {
  return lockSet(agent).has(String(sessionKey));
}

const emit = (agent, type, payload) => {
  try { agent?.tracer?.event?.(type, payload); } catch (e) { noteCatch(e); /* 观测失败不阻断压缩 */ }
};

// 会话里已压到哪 (以持久化的 compression 事件为准)
function lastCompactedSeq(events, markerType = "compaction/summary") {
  let upTo = 0;
  for (const e of events || []) if (e.type === markerType) upTo = e.data?.upToSeq || 0;
  return upTo;
}

/**
 * 压缩一次会话。返回 { ok, status, reason?, summary?, upToSeq?, covered?, archived?, ms }
 *   status: ok | skipped | busy | failed | refused
 * 调用方拿到 ok=false 不需要处理 —— 压缩失败一律退化为既有硬裁剪, 绝不阻断对话。
 */
export async function compactSession(agent, {
  sessionKey = "default",
  budget,
  reason = "auto",
  fidelity = true,
  archive = true,
  markerType = "compaction/summary",
  timeoutMs = 10000,
  retryMax = 0,
  hooks = true,
} = {}) {
  const k = String(sessionKey || "default");
  const t0 = Date.now();
  if (!agent?.llm || typeof agent.llm.chat !== "function") return { ok: false, status: "failed", reason: "no-llm" };
  const held = lockSet(agent);
  if (held.has(k)) return { ok: false, status: "busy", reason: "already-compacting", ms: 0 };
  held.add(k);

  const finish = (payload) => {
    held.delete(k);
    emit(agent, "compaction/end", { sessionKey: k, reason, ms: Date.now() - t0, ...payload });
    return { ms: Date.now() - t0, ...payload };
  };

  emit(agent, "compaction/start", { sessionKey: k, reason, budget: Number(budget) || null });

  try {
    const events = agent.sessionStore.replay(k) || [];
    const upToSeq = lastCompactedSeq(events, markerType);
    const tail = events.filter((e) => e.seq > upToSeq && (e.type === "user/message" || e.type === "assistant/message"));
    const splitInfo = compactionSplit(tail, budget);
    if (!splitInfo) return finish({ ok: false, status: "skipped", reason: "below-threshold" });
    const { old, lastSeq } = splitInfo;
    const transcript = transcriptToText(old.map((e) => ({
      role: e.type === "user/message" ? "user" : "assistant",
      content: e.data?.content,
    })));

    if (hooks) {
      try { await agent.hooks?.emit?.("PreCompact", { sessionKey: k, upToSeq: lastSeq }); } catch (e) { noteCatch(e); /* 指针失败不阻断压缩 */ }
    }

    let summary = null;
    try {
      const r = await agent.llm.chat(buildCompactionMessages(transcript), { timeoutMs, retryMax });
      summary = r?.content || null;
    } catch (e) {
      const why = String(e?.message || e).slice(0, 200);
      try { agent.bus?.emit?.("agent/compact-failed", { sessionKey: k, reason: "llm-error", error: why }, { source: "compact-engine" }); } catch (err) { noteCatch(err); }
      return finish({ ok: false, status: "failed", reason: "llm-error", error: why });
    }
    if (!summary) {
      try { agent.bus?.emit?.("agent/compact-failed", { sessionKey: k, reason: "empty-summary" }, { source: "compact-engine" }); } catch (e) { noteCatch(e); }
      return finish({ ok: false, status: "failed", reason: "empty-summary" });
    }

    // 保真闸门: 摘要丢了字面标识符就拒绝压 —— 宁可不压, 不静默丢证据
    if (fidelity && typeof agent._extractPins === "function") {
      const covered = events.filter((e) => e.seq <= lastSeq && e.type !== markerType);
      const pins = agent._extractPins(covered) || [];
      const missing = pins.filter((p) => !String(summary).includes(p));
      if (missing.length) {
        emit(agent, "compaction/summary", { sessionKey: k, refused: true, missing: missing.length, pins: pins.length });
        return finish({ ok: false, status: "refused", reason: "fidelity-refused", missing: missing.map((p) => `pins-verbatim: ${p}`) });
      }
    }

    // 被压原文归档 (可续读), 指针写进摘要事件
    let persisted = summary;
    let archived = null;
    if (archive) {
      try {
        const spill = typeof agent._spillStore === "function" ? agent._spillStore() : null;
        if (spill && typeof spill.putWithId === "function" && transcript.length >= 1500) {
          const id = `cp-${hashText(transcript)}`;
          const arch = spill.putWithId(id, transcript, { tool: "compaction", sessionKey: k });
          if (arch) {
            archived = id;
            persisted = `${summary}\n\n[被压缩原文 ${old.length} 轮 / ${transcript.length} 字符已归档: spill_id=${id}, context_read 可按 id 续读]`;
          }
        }
      } catch (e) { noteCatch(e); /* 归档失败不阻断压缩 */ }
    }

    agent.sessionStore.append(k, markerType, { summary: persisted, upToSeq: lastSeq, method: "llm", fidelity: !!fidelity });
    emit(agent, "compaction/summary", {
      sessionKey: k,
      upToSeq: lastSeq,
      covered: old.length,
      chars: transcript.length,
      archived,
      summaryChars: String(summary).length,
    });

    if (hooks) {
      try { await agent.hooks?.emit?.("PostCompact", { sessionKey: k, upToSeq: lastSeq, method: "llm" }); } catch (e) { noteCatch(e); /* 钩子失败不阻断 */ }
    }

    return finish({ ok: true, status: "ok", summary, upToSeq: lastSeq, covered: old.length, archived });
  } catch (e) {
    // 引擎自身的意外错误 (replay 坏了/spill 抛了): 留痕再降级, 不把异常甩给对话主线
    noteCatch(e);
    return finish({ ok: false, status: "failed", reason: "engine-error", error: String(e?.message || e).slice(0, 200) });
  }
}

// 内容哈希 (FNV-1a, 与 agent/context.js 里的 spill id 同算法, 保证同一段原文同一个 id)
export function hashText(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
