// src/evidence/index.js - 证据边界与看板 (吸收 oh-my-hermes / OMH 思路, 纯 JS, 零依赖)
// 两层证据标记:
//   PREPARED - 注入上下文的"预备材料"(如检索结果/文档), 禁止由 agent 伪造
//   OBSERVED - 工具/环境真实产出的"观测结果", 准入时须校验来源
// 另含: handoff manifest 哈希清单 (交接不可篡改)、goal board 只读看板、conformance 一致性核查。
//
// 2026-10-05 goal board 持久化改造 (本轮补齐测试所需的公开面):
//   ① 缺 id 由 shortId("g_") 生成 (旧实现硬性 `if (!id) throw`, 而唯一调用点从不传 id)
//   ② 归一收敛到 normalizePriority/normalizeStatus: 缺省 → 默认档; 给了但不认识 → 抛错 (拒绝, 不降档)
//   ③ 持久化走 store.js: 锁内读-改-写 + 磁盘∪内存并集 + 损坏现场留档 (.corrupt-<ts>),
//      缺 id 的历史行按**内容哈希**确定性补号 (随机补号会把一条目标裂成两条, 与 memory/l2.js F8 同一不变量)
//   ④ promptBlock(): 空看板 "" (固定开销 0 token), 有板时条数/长度双闸, 块内零时间戳 (前缀缓存纪律)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite, ensureDir, withFileLock } from "../utils/store.js";

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

/* ========================================================================
 * 目标看板 (goal board)
 * ====================================================================== */

/** 优先级全集 (归一表与工具 schema 同源) */
export const GOAL_PRIORITIES = ["P0", "P1", "P2"];
/** 状态全集 */
export const GOAL_STATUSES = ["pending", "in_progress", "blocked", "done"];
/** 默认容量: 满了显式报错, 不静默淘汰任何一条目标 */
export const GOAL_MAX_GOALS = 50;
/** 注入块最多列几条 (其余交给 goal_board list) */
export const GOAL_PROMPT_MAX = 10;
/** 注入块单条标题截断长度 */
export const GOAL_PROMPT_TITLE_MAX = 40;

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };
// 同优先级内的次序: 在办 > 待办 > 受阻 > 完成
const STATUS_RANK = { in_progress: 0, pending: 1, blocked: 2, done: 3 };

/**
 * 优先级归一 (唯一真源)。
 * 缺省 → 默认档 P2; 给了但不认识 → **抛错** (旧实现静默降档, 把 "p0" 排到队尾而毫无信号)。
 */
export function normalizePriority(v) {
  if (v === undefined || v === null || String(v).trim() === "") return "P2";
  const s = String(v).trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(PRIORITY_RANK, s)) return s;
  throw new Error(`未知优先级: ${v} (只接受 ${GOAL_PRIORITIES.join(" / ")})`);
}

/** 状态归一 (唯一真源)。缺省 → pending; 未知 → 抛错。 */
export function normalizeStatus(v) {
  if (v === undefined || v === null || String(v).trim() === "") return "pending";
  const s = String(v).trim().toLowerCase();
  if (GOAL_STATUSES.includes(s)) return s;
  throw new Error(`未知状态: ${v} (只接受 ${GOAL_STATUSES.join(" / ")})`);
}

// 宽松归一: 只用于**盘上已有数据** (历史/手写行) —— 不认识就回落默认档并记 issue, 绝不抛错。
// 与入参校验的严格路径分开: 用户给错要拒绝, 但历史数据不该让整块看板打不开。
function lenientPriority(v) {
  try { return normalizePriority(v); } catch { return "P2"; }
}
function lenientStatus(v) {
  try { return normalizeStatus(v); } catch { return "pending"; }
}

const normTitle = (t) => String(t ?? "").trim();
// 标题去重键: 空白/大小写差异算同一条 (计划台账里同一句话出现两次只会让模型再决策一遍)
const titleKey = (t) => normTitle(t).toLowerCase().replace(/\s+/g, " ");

/**
 * 内容哈希补号: g_h + 7 位十六进制。
 * 必须确定性 —— 随机号会让两个进程给同一条历史目标补出两个号, "按 id 并集"就把一条裂成两条,
 * 再叠加覆盖写就是又一次静默丢数据 (与 memory/l2.js F8 同一不变量)。
 */
export function deriveGoalId(goal = {}) {
  const payload = [titleKey(goal.title), String(goal.priority ?? ""), String(goal.status ?? "")].join("\u0000");
  return "g_h" + crypto.createHash("sha256").update(payload).digest("hex").slice(0, 7);
}

// 新目标的短 id (与 shortId 家族一致的前缀)
function shortId(prefix = "g_") {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
}

/**
 * 一行目标 → 规范形态。缺 id 用内容哈希补; 坏档位/状态按宽松归一, 并把修正记进 issues。
 * 注意顺序: **先归一 priority/status, 再算哈希** —— 否则哈希会跟着坏值漂移。
 */
function normalizeRow(row, issues = null) {
  const src = row && typeof row === "object" ? row : {};
  const out = { ...src };
  out.title = normTitle(out.title);

  if (out.priority === undefined || out.priority === null || String(out.priority).trim() === "") {
    out.priority = "P2"; // 缺省不记 issue (缺省本身就是正常形态)
  } else {
    const up = String(out.priority).trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(PRIORITY_RANK, up)) out.priority = up;
    else {
      if (issues) issues.push({ id: out.id ?? null, field: "priority", value: src.priority, action: "载入时归一到 P2" });
      out.priority = "P2";
    }
  }

  if (out.status === undefined || out.status === null || String(out.status).trim() === "") {
    out.status = "pending";
  } else {
    const lo = String(out.status).trim().toLowerCase();
    if (GOAL_STATUSES.includes(lo)) out.status = lo;
    else {
      if (issues) issues.push({ id: out.id ?? null, field: "status", value: src.status, action: "载入时归一到 pending" });
      out.status = "pending";
    }
  }

  if (!out.id) out.id = deriveGoalId(out);
  return out;
}

/**
 * 并集: 两侧按 id 取并 (缺 id 的一侧先补内容哈希号, 因此同内容不会裂成两条)。
 * 返回保持插入序; 排序是渲染层 (list) 的事。
 */
export function mergeGoals(a = [], b = []) {
  const byId = new Map();
  for (const row of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!row || typeof row !== "object") continue;
    const norm = normalizeRow(row);
    const cur = byId.get(norm.id);
    if (!cur) byId.set(norm.id, norm);
    else {
      // 同 id: 先到的版本优先, 只用后到的补空缺字段 (后到的可能是更旧的缓存)
      for (const k of Object.keys(norm)) {
        if (cur[k] === undefined || cur[k] === null || cur[k] === "") cur[k] = norm[k];
      }
    }
  }
  return [...byId.values()];
}

// 全序比较: 优先级 → 状态 → 标题字节序 → id 字节序。
// 末两项保证同一份数据在任何进程渲染出同一串字节 (否则前缀缓存分叉)。
function compareGoals(a, b) {
  const p = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  if (p) return p;
  const s = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
  if (s) return s;
  const t = Buffer.compare(Buffer.from(a.title, "utf8"), Buffer.from(b.title, "utf8"));
  if (t) return t;
  return Buffer.compare(Buffer.from(String(a.id), "utf8"), Buffer.from(String(b.id), "utf8"));
}

/**
 * 目标看板。
 * @param {object} [opts]
 * @param {string|null} [opts.dataDir] 持久化根目录 (给 null = 纯内存, 向后兼容旧调用)
 * @param {number} [opts.maxGoals]     容量上限 (默认 GOAL_MAX_GOALS)
 */
export function createGoalBoard({ dataDir = null, maxGoals = GOAL_MAX_GOALS } = {}) {
  const file = dataDir ? path.join(dataDir, "evidence", "goals.json") : null;
  let rows = [];
  let issues = [];
  let corruptPending = false; // 读失败 → 首次写入前先原地留档, 不把坏现场静默覆盖成空
  let stamp = null;           // 磁盘闸门: `${mtimeMs}:${size}`

  const diskStamp = () => {
    try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return null; }
  };

  function readDisk() {
    if (!file || !fs.existsSync(file)) return { rows: [], corrupt: false };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("顶层不是数组");
      return { rows: parsed, corrupt: false };
    } catch {
      return { rows: [], corrupt: true }; // 半截 JSON: 读不出内容, 但现场保留在原位
    }
  }

  // 写盘: 先给损坏现场留档 (只留一次), 再按**全序**原子写。
  // 落盘次序必须与进程写入次序无关 (否则同一份数据在不同进程渲染出不同字节 → 前缀缓存分叉)。
  function writeRows(list) {
    if (!file) return;
    ensureDir(path.dirname(file));
    if (corruptPending && fs.existsSync(file)) {
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
      corruptPending = false;
    }
    const sorted = [...list].sort(compareGoals);
    atomicWrite(file, JSON.stringify(sorted, null, 2));
    stamp = diskStamp();
  }

  // 重载: 磁盘 → 内存。只在盘上需要修复 (缺 id / 坏档位) 时才回写, 稳态构造一个字节都不写。
  function loadFromDisk() {
    if (!file) return;
    const { rows: disk, corrupt } = readDisk();
    const found = [];
    const normalized = disk.map((r) => normalizeRow(r, found));
    const needsFix = !corrupt && normalized.some((n, i) => {
      const src = disk[i];
      return !src || !src.id || src.priority !== n.priority || src.status !== n.status
        || String(src.title ?? "") !== n.title;
    });
    rows = normalized;
    issues = found;
    corruptPending = corrupt;
    if (needsFix) writeRows(rows);
    stamp = diskStamp();
  }

  // 对表: 盘被别的进程改过就并进来 (跨进程可见)。读路径绝不写盘。
  function resync() {
    if (!file) return;
    const s = diskStamp();
    if (s === stamp) return;
    const { rows: disk, corrupt } = readDisk();
    if (corrupt) return;
    rows = mergeGoals(disk, rows);
    stamp = s;
  }

  // 在内存 rows 上落一条 (落盘模式下调用方必须已持锁)
  function upsert({ explicitId, title, priority, status }) {
    if (explicitId) {
      const hit = rows.find((g) => g.id === explicitId);
      if (hit) {
        if (title) hit.title = title;
        hit.priority = priority;
        hit.status = status;
        writeRows(rows);
        return hit;
      }
      const g = { id: explicitId, title: title || explicitId, priority, status, created: new Date().toISOString() };
      rows.push(g);
      writeRows(rows);
      return g;
    }
    // 同标题 → 认成既有目标, 不新增 (告诉调用方 already_present 由工具层比较)
    const key = titleKey(title);
    const same = rows.find((g) => titleKey(g.title) === key);
    if (same) return same;

    if (rows.length >= maxGoals) {
      throw new Error(`目标看板已满 (上限 ${maxGoals} 条), 请先完成或清理既有目标`);
    }
    const g = { id: shortId("g_"), title, priority, status, created: new Date().toISOString() };
    rows.push(g);
    writeRows(rows);
    return g;
  }

  const api = {
    /** 新增 (不传 id 自动生成; 同标题命中既有; 显式 id 为幂等 upsert)。非法档位/状态抛错且不落盘。 */
    addGoal(input = {}) {
      const title = normTitle(input.title);
      const explicitId = input.id ? String(input.id).trim() : "";
      if (!title && !explicitId) throw new Error("addGoal 需要 title 或 id");
      // 严格校验先行 —— 抛错必须在任何写盘动作之前 (被拒的 add 不留半成品)
      const priority = normalizePriority(input.priority);
      const status = normalizeStatus(input.status);

      if (!file) return upsert({ explicitId, title, priority, status });

      ensureDir(path.dirname(file));
      return withFileLock(file, () => {
        // 锁内重新对表: 陈旧内存整体写盘会抹掉别的进程刚落的 goal (丢更新)
        const { rows: disk } = readDisk();
        rows = mergeGoals(disk, rows);
        return upsert({ explicitId, title, priority, status });
      });
    },

    updateStatus(id, status) {
      const st = normalizeStatus(status);
      const g = rows.find((r) => r.id === id);
      if (!g) return null;
      g.status = st;
      writeRows(rows);
      return g;
    },

    updateGoal(id, patch = {}) {
      const g = rows.find((r) => r.id === id);
      if (!g) return null;
      if (patch.priority !== undefined) g.priority = normalizePriority(patch.priority);
      if (patch.status !== undefined) g.status = normalizeStatus(patch.status);
      if (patch.title !== undefined) g.title = normTitle(patch.title);
      writeRows(rows);
      return g;
    },

    /** 全序排列的只读快照 (读前对表, 保证跨进程可见) */
    list() {
      resync();
      return [...rows].sort(compareGoals);
    },

    get(id) { resync(); return rows.find((r) => r.id === id) || null; },
    count() { resync(); return rows.length; },
    /** 文件路径 (纯内存看板为 null) */
    file() { return file; },
    /** 载入期修正记录 (坏档位/坏状态), 供调用方明说而非静默 */
    loadIssues() { return [...issues]; },

    /** 渲染文本 (供 Web UI / 模型回看) */
    render() {
      const list = api.list();
      if (!list.length) return "";
      const lines = ["# 目标看板 (Goal Board)", ""];
      const icon = { pending: "○", in_progress: "◑", blocked: "⛔", done: "●" };
      for (const p of GOAL_PRIORITIES) {
        const items = list.filter((g) => g.priority === p);
        if (items.length === 0) continue;
        lines.push(`## ${p}`);
        for (const g of items) lines.push(`- [${icon[g.status] || "?"}] ${g.title} \`${g.id}\` (${g.status})`);
        lines.push("");
      }
      return lines.join("\n").trim() + "\n";
    },

    /**
     * 注入块: 空板返回 "" (固定开销恰 0 token)。
     * 条数/长度双闸; 块内零时间戳零日期 —— 同一份数据每回合同一串字节 (前缀缓存纪律)。
     */
    promptBlock() {
      const list = api.list();
      if (!list.length) return "";
      const shown = list.slice(0, GOAL_PROMPT_MAX);
      const lines = [`【目标看板】(${list.length} 条)`];
      for (const g of shown) {
        let t = g.title;
        if (t.length > GOAL_PROMPT_TITLE_MAX) t = t.slice(0, GOAL_PROMPT_TITLE_MAX) + "…";
        lines.push(`- ${g.priority} ${g.status} ${t} #${g.id}`);
      }
      const rest = list.length - shown.length;
      if (rest > 0) lines.push(`另有 ${rest} 条未列出 (goal_board list 看完整台账)`);
      return lines.join("\n");
    },
  };

  loadFromDisk();
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
