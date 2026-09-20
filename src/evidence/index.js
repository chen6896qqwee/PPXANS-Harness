// src/evidence/index.js - 证据边界与看板 (吸收 oh-my-hermes / OMH 思路, 纯 JS, 零依赖)
// 两层证据标记:
//   PREPARED - 注入上下文的"预备材料"(如检索结果/文档), 禁止由 agent 伪造
//   OBSERVED - 工具/环境真实产出的"观测结果", 准入时须校验来源
// 另含: handoff manifest 哈希清单 (交接不可篡改)、goal board 只读看板、conformance 一致性核查。

import crypto from "node:crypto";

// 证据类型常量
export const Evidence = Object.freeze({
  PREPARED: "prepared",
  OBSERVED: "observed",
});

const EVIDENCE_TYPES = new Set([Evidence.PREPARED, Evidence.OBSERVED]);

// 浅拷贝对象 (不改动调用方传入的原始引用), 便于 freeze 后安全返回
function shallowClone(data) {
  if (data === null || typeof data !== "object") return data;
  if (Array.isArray(data)) return [...data];
  if (data instanceof Date) return new Date(data.getTime());
  return { ...data };
}

// 标记为 PREPARED, 附带不可变标记并冻结
export function markPrepared(data, { source } = {}) {
  if (!source) throw new Error("markPrepared 需要 source 标识来源");
  const obj = shallowClone(data);
  Object.defineProperty(obj, "__evidence", { value: Evidence.PREPARED, enumerable: true, writable: false, configurable: false });
  Object.defineProperty(obj, "__source", { value: String(source), enumerable: true, writable: false, configurable: false });
  Object.defineProperty(obj, "__ts", { value: new Date().toISOString(), enumerable: true, writable: false, configurable: false });
  return Object.freeze(obj);
}

// 标记为 OBSERVED, 附带不可变标记并冻结
export function markObserved(data, { tool } = {}) {
  if (!tool) throw new Error("markObserved 需要 tool 标识产出工具");
  const obj = shallowClone(data);
  Object.defineProperty(obj, "__evidence", { value: Evidence.OBSERVED, enumerable: true, writable: false, configurable: false });
  Object.defineProperty(obj, "__tool", { value: String(tool), enumerable: true, writable: false, configurable: false });
  Object.defineProperty(obj, "__ts", { value: new Date().toISOString(), enumerable: true, writable: false, configurable: false });
  return Object.freeze(obj);
}

// 校验证据标记存在且类型合法
export function validateEvidence(obj) {
  if (!obj || typeof obj !== "object") {
    return { valid: false, type: null, reason: "非对象" };
  }
  const t = obj.__evidence;
  if (!EVIDENCE_TYPES.has(t)) {
    return { valid: false, type: null, reason: "缺少合法的 __evidence 标记" };
  }
  if (t === Evidence.PREPARED && !obj.__source) {
    return { valid: false, type: t, reason: "prepared 证据缺少 __source" };
  }
  if (t === Evidence.OBSERVED && !obj.__tool) {
    return { valid: false, type: t, reason: "observed 证据缺少 __tool" };
  }
  if (typeof obj.__ts !== "string") {
    return { valid: false, type: t, reason: "缺少 __ts 时间戳" };
  }
  return { valid: true, type: t, reason: "ok" };
}

// sha256 十六进制 (取前 16 位作为紧凑指纹)
function shortHash(input) {
  const h = crypto.createHash("sha256").update(typeof input === "string" ? input : JSON.stringify(input)).digest("hex");
  return h.slice(0, 16);
}

// 创建交接清单 (handoff manifest): 每个条目独立哈希 + 整体摘要, 保证交接不可篡改
export function createHandoffManifest(items = []) {
  const entries = items.map((it) => {
    const data = it && typeof it === "object" && "__evidence" in it ? it : it; // 兼容直接传证据对象或 {data}
    const payload = data && typeof data === "object" && "data" in data ? data.data : data;
    const type = (it && it.type) || (data && data.__evidence) || "unknown";
    const source = (it && it.source) || (data && (data.__source || data.__tool)) || "unknown";
    return {
      hash: shortHash(payload),
      type,
      source,
    };
  });
  const digestInput = entries.map((e) => `${e.hash}:${e.type}:${e.source}`).join("|");
  return {
    version: 1,
    created_at: new Date().toISOString(),
    entries,
    digest: shortHash(digestInput),
  };
}

// 目标看板 (只读状态看板, 用于多 agent 协作时统一目标可见性)
export function createGoalBoard() {
  const goals = new Map(); // id -> {id, title, priority, status}
  const VALID_STATUS = new Set(["pending", "in_progress", "blocked", "done"]);
  const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };

  const api = {
    addGoal({ id, title, priority = "P2", status = "pending" } = {}) {
      if (!id) throw new Error("addGoal 需要 id");
      if (!VALID_STATUS.has(status)) status = "pending";
      if (!PRIORITY_RANK.hasOwnProperty(priority)) priority = "P2";
      goals.set(id, { id, title: title || id, priority, status });
      return goals.get(id);
    },
    updateStatus(id, status) {
      const g = goals.get(id);
      if (!g) return null;
      if (!VALID_STATUS.has(status)) throw new Error(`非法状态: ${status}`);
      g.status = status;
      return g;
    },
    list() {
      return [...goals.values()].sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]));
    },
    get(id) { return goals.get(id) || null; },
    render() {
      const lines = ["# 目标看板 (Goal Board)", ""];
      const order = ["P0", "P1", "P2"];
      const icon = { pending: "○", in_progress: "◑", blocked: "⛔", done: "●" };
      for (const p of order) {
        const items = api.list().filter((g) => g.priority === p);
        if (items.length === 0) continue;
        lines.push(`## ${p}`);
        for (const g of items) {
          const st = icon[g.status] || "?";
          lines.push(`- [${st}] ${g.title} \`${g.id}\` (${g.status})`);
        }
        lines.push("");
      }
      return lines.join("\n").trim() + "\n";
    },
  };
  return api;
}

// conformance 一致性核查: 用相同算法重算 items 哈希, 与 manifest.entries 比对
export function conformanceCheck(manifest, items = []) {
  const expected = manifest && manifest.entries ? manifest.entries : [];
  const recomputed = createHandoffManifest(items).entries;
  const mismatches = [];
  const n = Math.max(expected.length, recomputed.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const r = recomputed[i];
    if (!e || !r || e.hash !== r.hash || e.type !== r.type) {
      mismatches.push({ index: i, expected: e ? e.hash : null, actual: r ? r.hash : null });
    }
  }
  return { ok: mismatches.length === 0, mismatches, expected, actual: recomputed };
}
