// src/memory/retrieval.js - 单一记忆检索契约 (架构优化 ③, 2026-11-13)
//
// 问题 (审计结论): 记忆有 33 个文件、五层 + 事实库 + 经验库 + 场景 + 画像, 每个都能被单独调用。
//   谁先回答谁就决定上下文里放什么 —— 召回质量取决于调用点的实现顺序, 而不是证据强度。
//   更麻烦的是"为什么召回了这条"没有答案, 调不动也解释不了。
//
// 契约 (本文件): 所有来源都降级为 Provider, 只有一种融合口径:
//   retrieveMemory(query, {providers}) -> { items: [...], sources: [...], degraded }
//   每条结果带 evidence: [{source, rank, score}], 融合用 RRF (复用 fact-store-retrieval 的
//   同一实现, 不另写一套), 逐条置信度按各源自身分数归一化 —— 弱命中不会因名次靠前压过强命中。
//
// 约束: 零依赖; 任一 Provider 抛错只让该源降级 (sources[].ok=false), 不拖垮整次召回;
//   没有 Provider 可用时返回空结果而不是抛异常 (检索失败 ≠ 会话失败)。
import { rrfFuse } from "./fact-store-retrieval.js";
import { noteCatch } from "../utils/catch-log.js";

// Provider 名 → 权重。默认按"证据强度"排序: 事实库最可信, 经验次之, 场景是分类线索,
// 画像只做背景补充 (它对任何查询都命中, 等权时会挤掉真事实)。
export const DEFAULT_SOURCE_WEIGHTS = {
  facts: 1,
  experience: 0.8,
  scenes: 0.6,
  persona: 0.4,
};

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// ---- 内置 Provider (防御式探测: 方法不存在就跳过, 不假设调用方装配完整) ----
export function buildProviders({ facts = null, experience = null, scenes = null, personaStore = null } = {}) {
  const list = [];
  if (facts && typeof facts.query === "function") {
    list.push({
      name: "facts",
      async query(q, { perSource }) {
        const rows = facts.query(q, { limit: perSource }) || [];
        return rows.map((f) => ({
          id: `facts:${f.id}`,
          text: clip(f.content, 400),
          score: Number(f.effectiveScore ?? f.score ?? 0),
          kind: f.type || "fact",
          meta: { layer: f.layer ?? null, source: f.source ?? null },
        }));
      },
    });
  }
  if (experience && typeof experience.recall === "function") {
    list.push({
      name: "experience",
      async query(q, { perSource }) {
        const rows = experience.recall(q) || [];
        return rows.slice(0, perSource).map((l) => ({
          id: `experience:${l.id}`,
          text: clip(l.lesson, 400),
          score: Number(l.score ?? 0),
          kind: "lesson",
          meta: { task: clip(l.task, 120), uses: l.uses ?? 0 },
        }));
      },
    });
  }
  if (scenes && typeof scenes.findMatch === "function") {
    list.push({
      name: "scenes",
      async query(q, { perSource }) {
        const hit = scenes.findMatch(q);
        const rows = Array.isArray(hit) ? hit : hit ? [hit] : [];
        return rows.slice(0, perSource).map((s) => ({
          id: `scenes:${s.id || s.name}`,
          text: clip(`${s.name || ""}: ${s.description || ""}`, 300),
          score: Number(s.score ?? 1),
          kind: "scene",
          meta: {},
        }));
      },
    });
  }
  if (personaStore && typeof personaStore.userPersona === "function") {
    list.push({
      name: "persona",
      async query() {
        const p = personaStore.userPersona();
        if (!p) return [];
        const text = typeof p === "string" ? p : Array.isArray(p.lines) ? p.lines.join("; ") : JSON.stringify(p);
        if (!text || text === "{}" || text === "[]") return [];
        return [{ id: "persona:user", text: clip(text, 400), score: 1, kind: "persona", meta: {} }];
      },
    });
  }
  return list;
}

// 逐条置信度: 各源分数量纲不同 (BM25 vs 命中计数 vs 常量), 先按本源最大值归一化。
//   只影响"同一源内部强弱", 跨源比较仍交给 RRF 名次 —— 不假装不同源的分数可比。
export function normalizedConfidence(items) {
  if (!items || !items.length) return () => 1;
  const max = Math.max(...items.map((i) => Number(i.score) || 0), 0);
  if (!(max > 0)) return () => 1;
  return (item) => Math.max(0, Math.min(1, (Number(item.score) || 0) / max));
}

// 纯函数融合核心 (便于单测与面板复用): sourceLists = [{name, items, weight}]
//   返回 [{...item, fusedScore, evidence:[{source, rank, score}]}] 按融合分降序。
export function fuseSources(sourceLists, { k = 60, limit = 8 } = {}) {
  const usable = (sourceLists || []).filter((s) => s && Array.isArray(s.items) && s.items.length);
  if (!usable.length) return [];
  const lists = usable.map((s) => s.items);
  const weights = usable.map((s) => (s.weight == null ? 1 : Number(s.weight)));
  const confidence = usable.map((s) => normalizedConfidence(s.items));
  const fused = rrfFuse(lists, { k, weights, confidence });

  const evidence = new Map();
  usable.forEach((s, si) => {
    s.items.forEach((item, rank) => {
      if (!evidence.has(item.id)) evidence.set(item.id, []);
      evidence.get(item.id).push({ source: s.name, rank, score: Number(item.score) || 0, weight: weights[si] });
    });
  });

  // rrfFuse 只回对象不回分数; 这里按同一公式复算 (同一 k, 不引入第二套定义)
  const fusedScore = new Map();
  usable.forEach((s, si) => {
    const w = weights[si];
    const conf = confidence[si];
    s.items.forEach((item, rank) => {
      fusedScore.set(item.id, (fusedScore.get(item.id) || 0) + (w * conf(item)) / (k + rank + 1));
    });
  });

  return fused.slice(0, limit).map((item) => ({
    id: item.id,
    text: item.text,
    kind: item.kind,
    meta: item.meta || {},
    fusedScore: Number((fusedScore.get(item.id) || 0).toFixed(6)),
    evidence: (evidence.get(item.id) || []).sort((a, b) => a.rank - b.rank),
  }));
}

// 统一入口: 并发查所有源 → 融合 → 带来源健康度返回。
export async function retrieveMemory(query, {
  providers = [],
  limit = 8,
  perSource = 12,
  weights = DEFAULT_SOURCE_WEIGHTS,
  minFused = 0,
} = {}) {
  const q = String(query ?? "").trim();
  const sources = [];
  if (!q || !providers.length) {
    return { query: q, items: [], sources, degraded: !providers.length };
  }
  const settled = await Promise.all(providers.map(async (p) => {
    const t0 = Date.now();
    try {
      const items = (await p.query(q, { perSource })) || [];
      return { name: p.name, ok: true, ms: Date.now() - t0, items: items.filter((i) => i && i.id && i.text) };
    } catch (e) {
      // 单源故障降级而非吞掉: 记录留痕 + 在 sources[] 里如实回报, 调用方能看到"哪一路瞎了"
      noteCatch(e);
      return { name: p.name, ok: false, ms: Date.now() - t0, items: [], error: e?.message || String(e) };
    }
  }));
  for (const s of settled) {
    sources.push({ name: s.name, ok: s.ok, ms: s.ms, count: s.items.length, ...(s.error ? { error: s.error } : {}) });
  }
  const lists = settled
    .filter((s) => s.ok)
    .map((s) => ({ name: s.name, items: s.items, weight: weights?.[s.name] ?? 1 }));
  const items = fuseSources(lists, { limit }).filter((i) => i.fusedScore >= minFused);
  return { query: q, items, sources, degraded: sources.some((s) => !s.ok) };
}

// 给上下文的渲染形态: 每条带来源标注, 让模型能区分"事实/经验/场景/画像",
//   而不是拿到一段无出处的拼贴。超预算按条截断 (不切半句), 并如实标注丢弃条数。
export function formatForPrompt(result, { maxChars = 1200 } = {}) {
  const items = result?.items || [];
  if (!items.length) return "";
  const label = { facts: "事实", experience: "经验", scenes: "场景", persona: "画像" };
  const lines = [];
  let used = 0;
  let dropped = 0;
  for (const it of items) {
    const from = [...new Set((it.evidence || []).map((e) => label[e.source] || e.source))].join("/");
    const line = `- [${from || "记忆"}] ${it.text}`;
    if (used + line.length + 1 > maxChars) { dropped += 1; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return "";
  return dropped ? `${lines.join("\n")}\n(另有 ${dropped} 条未注入: 超出记忆预算)` : lines.join("\n");
}
