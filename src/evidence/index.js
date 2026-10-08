// src/evidence/index.js - 证据边界与看板 (吸收 oh-my-hermes / OMH 思路, 纯 JS, 零依赖)
// 两层证据标记:
//   PREPARED - 注入上下文的"预备材料"(如检索结果/文档), 禁止由 agent 伪造
//   OBSERVED - 工具/环境真实产出的"观测结果", 准入时须校验来源
// 另含: handoff manifest 哈希清单 (交接不可篡改)、goal board 计划台账 (持久化)、conformance 一致性核查。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJsonGuarded, writeJson, withFileLock } from "../utils/store.js";
import { shortId } from "../utils/id.js";
import { warn } from "../utils/logger.js";

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

// ============================ 目标看板 (goal board) ============================
// 多步任务的计划台账: 目标 + 优先级 + 状态, 跨进程持久化, 并可注入 system prompt。
// 2026-10-05 重写, 修掉四个缺口 (旧版每一次真实调用都抛错, 看板从未被写进去过):
//   ① id: 旧 addGoal 硬性要求调用方传 id, 而唯一调用点 src/tools/v3.js 从不传 →
//      每次都抛 "addGoal 需要 id"。现在 id 由本模块生成 (复用 src/utils/id.js 的 shortId,
//      全仓唯一实现); 调用方显式传 id 仍可, 语义为按 id 幂等 upsert。
//   ② 优先级大小写: 工具面是小写 p0/p1/p2, PRIORITY_RANK 键是大写 —— 旧实现
//      `if (!PRIORITY_RANK.hasOwnProperty(priority)) priority = "P2"` 把 "p0" 静默降成最低档
//      ("p2" 恰好撞对, 把 bug 盖住了)。现在归一只发生在 normalizePriority/normalizeStatus
//      这一道边界: 缺省 → 默认档; 给了但不认识 → **抛错** (台账的排序就是它的语义,
//      静默错序会让模型"按错误的计划"执行且毫无异常信号, 比一次明确失败难查)。
//   ③ 持久化: <dataDir>/evidence/goals.json, 走 src/utils/store.js 既有机制
//      (readJsonGuarded + 损坏现场 .corrupt-<ts> 留档 + withFileLock 锁内"读-改-写" +
//      磁盘∪内存并集), 与 FactStore / L2 SceneStore / AssetHub 同一口径。
//      ⚠ 并集按 id 取, 所以**缺 id 的行必须按内容哈希确定性补号** (src/memory/l2.js F8
//      同一条不变量): 用随机号补号, 两个进程会各补各的, "按 id 并集"把一条目标裂成两条,
//      再叠加一次覆盖写 = 又一次静默丢数据 (2026-10-04 真实用户记忆丢失 bug 的同一类)。
//   ④ 注入: promptBlock() 给出**有界且零时间戳**的文本; 空看板返回 "" → 该块被
//      agent/prompts.js 的 .filter(Boolean) 整条丢掉 → system 固定开销恰为 0 token
//      (前缀缓存纪律: scripts/ctx-profile.js --check 的 4500 tok 闸门)。
//      块内不含 created/updated —— 那两个字段只为落盘治理存在, 一旦进 prompt 就会
//      每回合改字节、天天作废缓存 (2026-10-05 cache-audit 同类回归)。

export const GOAL_PRIORITIES = Object.freeze(["P0", "P1", "P2"]);
export const GOAL_STATUSES = Object.freeze(["pending", "in_progress", "blocked", "done"]);
export const DEFAULT_GOAL_PRIORITY = "P2";
export const DEFAULT_GOAL_STATUS = "pending";
// 落盘相对路径 (与 dataDir 拼接); 单文件纯数组, 读取方 (Web UI / 测试) 无感
export const GOALS_FILE_SUBPATH = Object.freeze(["evidence", "goals.json"]);
// 台账容量: 满了**显式报错**, 绝不静默淘汰任何一条目标 (悄悄抹掉计划 == 丢数据)
export const GOAL_MAX_GOALS = 50;
// 落盘标题上限 (防单条目标塞进整段文档, 也防台账被当成记事本撑爆)
export const GOAL_TITLE_MAX = 200;
// 注入 prompt 的双闸: 条数上限 + 单条标题长度上限 (最坏情况成本可预算, 见实测注释)
// 为什么是 10 条: 多步计划的常见规模就是几步到十步; 更长的台账由 goal_board list 按需取,
// 而不是每回合为"第 11 条以后"付 token。为什么标题截到 48 字: 目标是一行话, 不是文档段落
// (落盘上限另有 GOAL_TITLE_MAX=200, 那道是防注入块膨胀, 两道闸各管一件事)。
export const GOAL_PROMPT_MAX = 10;
export const GOAL_PROMPT_TITLE_MAX = 48;

const PRIORITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2 });
// 同优先级内再按状态排: 在办 > 待办 > 受阻 > 已完成 (把"下一步做什么"顶到台账最前,
// 也让超出 GOAL_PROMPT_MAX 的尾部自然落在已完成的目标上)
const STATUS_RANK = Object.freeze({ in_progress: 0, pending: 1, blocked: 2, done: 3 });
const VALID_STATUS = new Set(GOAL_STATUSES);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// mutate() 的"本轮无变更"哨兵 (见 createGoalBoard.mutate)
const NOCHANGE = Symbol("goal-board-nochange");

// 报错文案里回显用户给的值: 折叠空白 + 截断 (值本身可能是模型写的任意长文本)
function echoValue(v) {
  return String(v).replace(/\s+/g, " ").trim().slice(0, 24);
}

// 优先级归一 (**唯一边界**): undefined/"" → fallback; "p0"/" P0 " → "P0"; 其它 → 抛错
export function normalizePriority(value, { fallback = DEFAULT_GOAL_PRIORITY } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const up = String(value).trim().toUpperCase();
  if (!hasOwn(PRIORITY_RANK, up)) {
    throw new Error(`未知优先级 "${echoValue(value)}" (支持 ${GOAL_PRIORITIES.join(" / ")} 或 p0 / p1 / p2)`);
  }
  return up;
}

// 状态归一 (同一条边界纪律): 未知状态抛错。旧实现 add 时静默回落 pending、
// update 时抛错 —— 同一个值两条路径两种结果, 现统一为"给了就要认"。
export function normalizeStatus(value, { fallback = DEFAULT_GOAL_STATUS } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const low = String(value).trim().toLowerCase();
  if (!VALID_STATUS.has(low)) {
    throw new Error(`未知状态 "${echoValue(value)}" (支持 ${GOAL_STATUSES.join(" / ")})`);
  }
  return low;
}

// FNV-1a 32bit → base36 (零依赖, 与 memory/l2.js F8 同一补号算法)
function fnv1a36(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

// "同一条目标"的稳定内容指纹原文: 补号哈希与"是否同一条"的判定**共用这一份 key**
// (要比原文而非截断哈希 —— 32bit 可撞; 且合流后行会长大, 现算哈希不再等于当初的号)
function goalKeyOf(g) {
  return JSON.stringify({
    title: String((g && g.title) || ""),
    priority: String((g && g.priority) || ""),
    status: String((g && g.status) || ""),
  });
}

// 缺 id 行的确定性补号基数 (g_h 前缀与 shortId("g_") 同族, 不会撞既有 id 形态)
export function deriveGoalId(goal) {
  return "g_h" + fnv1a36(goalKeyOf(goal));
}

// 标题归一 (去重判定用): 折叠空白 + 小写 —— 模型两次写"修复登录 "/" 修复登录" 不该成两条
function titleMatchKey(title) {
  return String(title || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeTitle(title, max) {
  return String(title ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

// 一条记录归一 (落盘/载入都过这道, 所以磁盘上的形态永远是规范形态; 补号也因此跨进程一致)
// mode="load" 时**不抛错**而回落默认档: 一行手写坏值不该让整个看板装配失败,
// 且坏值会被 note() 记下来, 由 goal_board 的 list 结果原样吐回调用方 (静默修 ≠ 静默丢)。
function canonicalGoal(raw, { max = GOAL_TITLE_MAX, note = null } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const title = normalizeTitle(raw.title, max);
  if (!title) return null;
  let priority, status;
  try {
    priority = normalizePriority(raw.priority);
  } catch (e) {
    priority = DEFAULT_GOAL_PRIORITY;
    if (note) note(`目标 #${String(raw.id || "无 id")} 的优先级非规范 (${e.message}), 已按 ${priority} 载入`);
  }
  try {
    status = normalizeStatus(raw.status);
  } catch (e) {
    status = DEFAULT_GOAL_STATUS;
    if (note) note(`目标 #${String(raw.id || "无 id")} 的状态非规范 (${e.message}), 已按 ${status} 载入`);
  }
  const out = {
    id: String(raw.id || ""),            // 缺 id 交给 mergeGoals 按内容哈希补 (不在此随机生成)
    title,
    priority,
    status,
    created: typeof raw.created === "string" ? raw.created : "",
    updated: typeof raw.updated === "string" ? raw.updated : "",
  };
  return out;
}

// 同一 id 的两个版本 (磁盘 vs 内存) 合并成一条: updated 较新的字段形态胜出,
// 平局 (同毫秒/都没有时间戳) 让后入的内存态赢 —— 与 AssetHub/SceneStore 同口径。
// created 取更早的一份 (补号迁移不丢创建时间)。
function mergeOneGoal(a, b) {
  const ua = String(a.updated || ""), ub = String(b.updated || "");
  const win = ub > ua ? b : (ua > ub ? a : b);
  const created = [a.created, b.created].filter(Boolean).sort()[0] || win.created || "";
  return { ...win, id: win.id || a.id || b.id, created, updated: ua > ub ? ua : ub };
}

// 磁盘态 ∪ 内存态 (按 id 并集; 缺 id 行确定性补号)。语义与 SceneStore.mergeScenes 一致:
// 同内容 ⟹ 同一基数号 ⟹ 认出是同一条目标直接并进来; 只有同号而内容确不相同
// (32bit 真撞车, 或某行显式 id 恰好等于别人的补号基数) 才用 _2/_3 后缀消歧。
export function mergeGoals(disk, mem) {
  const byId = new Map();
  const keyById = new Map(); // 补号行 id -> 当初的内容指纹原文 (判定"同一条"用)
  const put = (g) => {
    if (!g) return;
    let e = g;
    if (!e.id) {
      const key = goalKeyOf(e);
      const base = deriveGoalId(e);
      let id = base, n = 2;
      const sameGoal = (occId) => keyById.has(occId)
        ? keyById.get(occId) === key
        : goalKeyOf(byId.get(occId)) === key;
      while (byId.has(id) && !sameGoal(id)) id = base + "_" + n++;
      keyById.set(id, key);
      e = { ...e, id };
    }
    const cur = byId.get(e.id);
    byId.set(e.id, cur ? mergeOneGoal(cur, e) : { ...e });
  };
  for (const g of Array.isArray(disk) ? disk : []) put(g);
  for (const g of Array.isArray(mem) ? mem : []) put(g);  // 内存后入 = 本进程变更优先
  return [...byId.values()];
}

// 看板排序 (全序, 与进程/插入顺序无关): 优先级 → 状态 → 标题字节序 → id。
// 注入块由这份次序切片, 所以同一份数据在任何进程、任何时刻渲染出同一串字节。
function compareGoals(a, b) {
  const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (p !== 0) return p;
  const s = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (s !== 0) return s;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// 创建目标看板。
//   opts.dataDir  —— 给定则台账落盘 <dataDir>/evidence/goals.json (evidencePlugin 走这条)
//   opts.file     —— 直接指定文件路径 (测试用)
//   两者都不给   —— 纯内存看板 (向后兼容: 旧调用 createGoalBoard() 的行为与测试不变)
export function createGoalBoard(opts = {}) {
  const maxGoals = Number(opts.maxGoals) > 0 ? Number(opts.maxGoals) : GOAL_MAX_GOALS;
  const titleMax = Number(opts.titleMax) > 0 ? Number(opts.titleMax) : GOAL_TITLE_MAX;
  const promptMax = Number(opts.promptMax) >= 0 ? Number(opts.promptMax) : GOAL_PROMPT_MAX;
  const promptTitleMax = Number(opts.promptTitleMax) > 0 ? Number(opts.promptTitleMax) : GOAL_PROMPT_TITLE_MAX;
  const storeFile = opts.file
    ? String(opts.file)
    : (opts.dataDir ? path.join(String(opts.dataDir), ...GOALS_FILE_SUBPATH) : null);

  let goals = new Map();          // id -> 规范记录
  const issues = [];              // 载入时被修好的非规范行 (空 = 一切正常)
  const issueSeen = new Set();    // 同一句话只记一次 (每回合对表都会重新归一同一批行)
  const noteIssue = (msg) => {
    if (issueSeen.has(msg) || issues.length >= 20) return;   // 去重 + 硬上限 (坏行再多也不无限堆)
    issueSeen.add(msg);
    issues.push(msg);
  };
  let corruptPending = false;     // 磁盘态损坏 → 覆盖前先留档 .corrupt-<ts>
  let stamp = null;               // 已知磁盘形态 {mtimeNs,size} → 没人写过就不重读

  const toMap = (rows) => {
    const m = new Map();
    for (const g of rows) m.set(g.id, g);
    return m;
  };

  // 纯写盘 (调用方必须已持锁)。临界区全同步 —— withFileLock 的 fn 一旦 await 就提前释放锁。
  function writeLocked() {
    if (!storeFile) return;
    if (corruptPending) {
      try {
        fs.renameSync(storeFile, `${storeFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, "")}`);
      } catch (e) { warn(`[evidence/goal] 损坏文件留档失败 (照常写盘): ${e && e.message ? e.message : e}`); }
      corruptPending = false;
    }
    // 按看板全序落盘: 同一份数据在任何进程写出字节相同的文件 (diff 可读, 也便于并集复核)
    writeJson(storeFile, [...goals.values()].sort(compareGoals));
    stamp = null;   // 自己的写也要在下一次读时重新对表
  }

  // 锁内重读 + 并集 (调用方必须已持锁): 基于过期内存做增删再整体写盘会覆盖别人的目标
  function reloadLocked() {
    if (!storeFile) return;
    const g = readJsonGuarded(storeFile, []);
    if (g.parseFailed) {
      // 半截/损坏: 绝不把"空态"并进来再写盘 (那等于抹掉别人已落盘的目标)。
      // 保留内存态 + 打损坏标记, 覆盖之前先留档, 现场可人工恢复。
      corruptPending = true;
      warn("[evidence/goal] goals.json 解析失败 (文件原地保留), 本轮以内存态为准, 不做并集");
      return;
    }
    goals = toMap(mergeGoals((Array.isArray(g.data) ? g.data : [])
      .map((r) => canonicalGoal(r, { max: titleMax, note: noteIssue })).filter(Boolean), [...goals.values()]));
  }

  // 只读对表 (无锁): mtimeNs+size 未变 → 一次 stat 就返回, 不做每回合的全量读盘
  function syncFromDisk() {
    if (!storeFile) return;
    let st = null;
    try { st = fs.statSync(storeFile, { bigint: true }); } catch { st = null; }
    if (!st) return;                       // 还没有文件: 内存态即事实源 (首写会创建)
    if (stamp && stamp.mtimeNs === String(st.mtimeNs) && stamp.size === String(st.size)) return;
    const g = readJsonGuarded(storeFile, []);
    if (g.parseFailed) {
      corruptPending = true;
      warn("[evidence/goal] goals.json 解析失败 (文件原地保留), 本轮沿用内存态, 不做并集");
      stamp = { mtimeNs: String(st.mtimeNs), size: String(st.size) };  // 同一形态不重复刷日志
      return;
    }
    stamp = { mtimeNs: String(st.mtimeNs), size: String(st.size) };
    goals = toMap(mergeGoals((Array.isArray(g.data) ? g.data : [])
      .map((r) => canonicalGoal(r, { max: titleMax, note: noteIssue })).filter(Boolean), [...goals.values()]));
  }

  // 写路径统一入口: 无 dataDir 时退化为纯内存 (旧行为), 有则锁内 读-改-写。
  // fn 返回 NOCHANGE = 本次什么都没改 (例如 id 根本不存在) → 不写盘, 免得白刷一次全量原子写。
  function mutate(fn) {
    if (!storeFile) {
      const r = fn();
      return r === NOCHANGE ? null : r;
    }
    return withFileLock(storeFile, () => {
      reloadLocked();
      const r = fn();
      if (r !== NOCHANGE) writeLocked();
      return r === NOCHANGE ? null : r;
    });
  }

  const clone = (g) => (g ? { ...g } : null);

  function findDuplicateTitle(title) {
    const key = titleMatchKey(title);
    if (!key) return null;
    for (const g of goals.values()) if (titleMatchKey(g.title) === key) return g;
    return null;
  }

  // 一次性迁移 (与 l2 F8 同口径): 盘上缺 id 的行在装配时确定性补号并落盘,
  // 不等"下一次写"才修; 常态 (全部有 id) 零写盘。
  if (storeFile) {
    ensureDir(path.dirname(storeFile));
    const guarded = readJsonGuarded(storeFile, []);
    if (guarded.parseFailed) corruptPending = true;   // 首写前留档, 不覆盖损坏现场
    const rows = (Array.isArray(guarded.data) ? guarded.data : [])
      .map((r) => canonicalGoal(r, { max: titleMax, note: noteIssue })).filter(Boolean);
    const missingId = rows.some((r) => !r.id);
    goals = toMap(mergeGoals(rows, []));
    if (missingId) {
      // 锁内以磁盘最新态为单一输入 (此刻内存态就是刚读出来的那批行, 自己并自己会把
      // 同一条目标写成 base/base_2 两行 —— l2 已踩过, 见 memory/l2.js F8 修正注释)
      try {
        withFileLock(storeFile, () => {
          const fresh = readJsonGuarded(storeFile, []);
          if (fresh.parseFailed) corruptPending = true;
          const diskRows = (Array.isArray(fresh.data) ? fresh.data : [])
            .map((r) => canonicalGoal(r, { max: titleMax, note: noteIssue })).filter(Boolean);
          goals = toMap(mergeGoals(diskRows, []));
          writeLocked();
        });
      } catch (e) {
        warn(`[evidence/goal] 缺 id 目标的一次性补号未能落盘 (内存态已修, 下次写入再尝试): ${e && e.message ? e.message : e}`);
      }
    }
  }

  const api = {
    // 新增 (或按显式 id 幂等更新) 一条目标。id 缺失时由 shortId("g_") 生成 ——
    // 旧实现在这里抛 "addGoal 需要 id", 而调用点从不传 id, 于是看板从来没被写过。
    addGoal({ id, title, priority, status } = {}) {
      const t = normalizeTitle(title, titleMax);
      if (!t) throw new Error("addGoal 需要 title");
      const pr = normalizePriority(priority);   // 未知值在此抛错 (唯一归一边界)
      const st = normalizeStatus(status);
      return mutate(() => {
        if (id) {
          const key = String(id);
          const cur = goals.get(key);
          if (cur) {  // 显式 id = upsert: 保留 created, 刷新 updated
            const next = { ...cur, title: t, priority: pr, status: st, updated: new Date().toISOString() };
            goals.set(key, next);
            return clone(next);
          }
        }
        // 同标题不重复成两条: 计划台账里同一句话出现两次, 只会让模型再决策一遍
        const dup = findDuplicateTitle(t);
        if (dup) return clone(dup);
        if (goals.size >= maxGoals) {
          throw new Error(`目标看板已满 (${maxGoals} 条): 先用 action=update 把已完成的目标置 done 并精简, 再新增`);
        }
        const now = new Date().toISOString();
        const goal = { id: id ? String(id) : shortId("g_"), title: t, priority: pr, status: st, created: now, updated: now };
        goals.set(goal.id, goal);
        return clone(goal);
      });
    },

    // 按 id 更新字段 (title/priority/status 任一; 未给的不动)
    updateGoal(id, patch = {}) {
      if (!id) throw new Error("updateGoal 需要 id");
      const p = patch || {};
      // 归一先行 (锁外就能判定非法值): 报错文案里的值是调用方自己给的, 不静默降档
      const title = p.title === undefined ? null : normalizeTitle(p.title, titleMax);
      if (p.title !== undefined && !title) throw new Error("updateGoal 的 title 不能为空");
      const priority = p.priority === undefined ? null : normalizePriority(p.priority);
      const status = p.status === undefined ? null : normalizeStatus(p.status);
      if (!title && !priority && !status) throw new Error("updateGoal 需要 title / priority / status 至少一项");
      const key = String(id);
      return mutate(() => {
        // 存在性判定必须在锁内 (并集之后): 目标可能是另一个进程刚加的
        const cur = goals.get(key);
        if (!cur) return NOCHANGE;
        const next = { ...cur, updated: new Date().toISOString() };
        if (title) next.title = title;
        if (priority) next.priority = priority;
        if (status) next.status = status;
        goals.set(next.id, next);
        return clone(next);
      });
    },

    // 兼容旧签名: 只改状态 (未知状态同样抛错)
    updateStatus(id, status) {
      syncFromDisk();
      if (!goals.has(String(id ?? ""))) return null;
      return api.updateGoal(id, { status });
    },

    findGoalByTitle(title) {
      syncFromDisk();
      return clone(findDuplicateTitle(title));
    },

    list() {
      syncFromDisk();
      return [...goals.values()].sort(compareGoals).map(clone);
    },

    get(id) {
      syncFromDisk();
      return clone(goals.get(String(id ?? "")));
    },

    count() {
      syncFromDisk();
      return goals.size;
    },

    // 载入时被修好的非规范行 (空数组 = 一切正常)。goal_board 的 list 结果带回给调用方,
    // 免得坏值被"静默规范化"后再也没人看得见。
    loadIssues(limit = 5) {
      return issues.slice(0, Math.max(0, Number(limit) || 0));
    },

    file() { return storeFile; },

    render() {
      const items = api.list();
      const lines = ["# 目标看板 (Goal Board)", ""];
      if (!items.length) return lines.join("\n").trim() + "\n";
      const icon = { pending: "○", in_progress: "◑", blocked: "⛔", done: "●" };
      for (const p of GOAL_PRIORITIES) {
        const bucket = items.filter((g) => g.priority === p);
        if (bucket.length === 0) continue;
        lines.push(`## ${p}`);
        for (const g of bucket) lines.push(`- [${icon[g.status] || "?"}] ${g.title} \`${g.id}\` (${g.status})`);
        lines.push("");
      }
      return lines.join("\n").trim() + "\n";
    },

    // system prompt 注入块 (见 agent/prompts.js _goalBoardPrompt):
    //   空看板 → "" (被 .filter(Boolean) 丢掉, 固定开销 0 token)
    //   条数上限 promptMax + 标题上限 promptTitleMax, **不含任何时间戳** ——
    //   同一份看板每回合渲染出同一串字节; 看板没变时该块也不再是分叉点。
    promptBlock(o = {}) {
      const cap = Number(o.maxItems) >= 0 ? Number(o.maxItems) : promptMax;
      const tCap = Number(o.titleCap) > 0 ? Number(o.titleCap) : promptTitleMax;
      const all = api.list();
      if (!all.length) return "";
      const shown = all.slice(0, cap);
      const lines = [
        "【目标看板】goal_board 计划台账 (已持久化, 重启不丢)。按下列次序推进, 做完一条就 update 置 done;"
        + " 已列出的步骤不要重新规划, 也不要重复添加同标题目标。"
        + "调用形状: {\"action\":\"update\",\"id\":\"下面的 #号\",\"status\":\"done\"}",
      ];
      for (const g of shown) {
        let t = g.title;
        if (t.length > tCap) t = t.slice(0, tCap) + "…";
        lines.push(`- ${g.priority} ${g.status} ${t} #${g.id}`);
      }
      const more = all.length - shown.length;
      if (more > 0) lines.push(`(另有 ${more} 条未列出: goal_board action=list 查看)`);
      return lines.join("\n");
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
