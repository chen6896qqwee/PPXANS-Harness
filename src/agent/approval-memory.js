// src/agent/approval-memory.js - 审批记忆 (缓存 key / 前缀放行 / 永久允许)
//
// 2026-11-12 自 approval.js 拆出: 这是「人类做过一次决定, 以后别再问」的那一半 ——
// 与执行循环 (approval.js) 分开的理由是失效条件不同: 缓存/前缀只活在本会话内存,
// 永久允许落盘到 data/approvals.json, 撤销只动这一个文件, 不碰用户 config。
import fs from "node:fs";
import path from "node:path";
import { noteCatch } from "../utils/catch-log.js";
import { atomicWrite } from "../utils/store.js";

export const approvalMemoryMethods = {
// B2: 审批缓存 key 计算 — 仅命令类工具参与 (非命令工具改参数不放行, 防止漏审对象被缓存)
// 2026-10-30 安全修复: 缓存 key 必须与「人类实际看到的命令」逐字节一致。
//   旧实现复用 normalizeCommand (去引号 + 合并空白), 把 `echo "rm -rf /"` 与 `echo rm -rf /`
//   归一成同一个 key —— 批准前者后, 后者直接命中缓存跳过审批, 属于语义级越权。
//   现在只 trim 首尾空白, 不碰内部引号/空白; 不同写法最多多问一次, 不会误放行。
//   命令在 run_command/code_act 中固定以工作区为 cwd 执行, 因此无需把 cwd 纳入 key。
// 返回 null = 不缓存该工具。
_approvalCacheKey(name, args) {
  if (!/run_command|shell|exec|bash|code_act/i.test(String(name))) return null;
  const cmd = args?.command ?? args?.cmd ?? args?.code ?? args?.script;
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  return `${name}:${cmd.trim()}`;
},

// 2026-11-03: 「前缀放行」—— 人类在审批卡上显式点「前缀放行」后, 同一首词的单条简单命令
//   本会话内不再重复 ask (findstr 换个搜索词就弹一次的痛点)。只认**单条简单命令**:
//   含管道 / && / ; / 命令替换 / 重定向的复合命令, 首词代表不了整条语义, 一律不参与
//   (返回 null → 仍按整条精确审批)。放行只入内存, 永不落盘。
_approvalPrefixToken(args) {
  const cmd = args?.command ?? args?.cmd ?? args?.code ?? args?.script;
  if (typeof cmd !== "string") return "";
  const s = cmd.trim();
  // 2026-11-06 (评估 P1-6): 补单个 & —— `npm & 恶意命令` 的首词仍是 npm, 旧正则只拦 &&
  //   放过了单 & (后台执行), 前缀放行会连带放行后台段。复合语义一律不参与前缀放行。
  if (!s || /(?:\|\||&&|&|;|\||`|\$\(|\n|>|<)/.test(s)) return "";
  const tok = s.split(/\s+/)[0] || "";
  return tok && tok.length <= 64 ? tok : "";
},

_approvalPrefixKey(name, args) {
  const tok = this._approvalPrefixToken(args);
  return tok ? `prefix:${name}:${tok}` : null;
},

// ---- 永久允许 (2026-11-03): 用户显式「记住」的命令落盘, 跨重启仍生效 ----
// 与 config 的 allow 规则分开存: config 是用户手写的静态策略, 这里是运行期的人类裁决,
// 撤销只动这一个文件, 不碰用户配置。只存命令类 key (与非命令工具无 key 一致)。
_approvalStoreFile() {
  return path.join(this.dataDir || ".", "approvals.json");
},

_loadPersistentApprovals() {
  const out = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(this._approvalStoreFile(), "utf8"));
    const rules = j && typeof j === "object" && j.rules && typeof j.rules === "object" ? j.rules : {};
    for (const [key, v] of Object.entries(rules)) {
      if (!key || key.length > 500 || !key.includes(":")) continue;
      out.set(key, { ts: Number(v?.ts) || 0, reason: String(v?.reason || "").slice(0, 300) });
    }
  } catch (e) {
    if (e?.code !== "ENOENT") noteCatch("src/agent/approval-memory.js#_loadPersistentApprovals", e);
  }
  return out;
},

_savePersistentApprovals() {
  const rules = {};
  for (const [key, v] of this._approvalStore) rules[key] = { ts: v.ts, reason: v.reason };
  try {
    atomicWrite(this._approvalStoreFile(), JSON.stringify({ version: 1, rules }, null, 2));
    return true;
  } catch (e) {
    noteCatch("src/agent/approval-memory.js#_savePersistentApprovals", e);
    return false;
  }
},

// 决策落地: always = 本会话内存缓存; persist = 内存 + 落盘; approve/deny = 不缓存
_applyApprovalDecision(key, decision, reason) {
  if (!key || this.config?.agent?.approval_cache === false) return;
  if (decision !== "always" && decision !== "persist") return;
  if (!this._approvalCache) this._approvalCache = new Map();
  this._approvalCache.set(key, reason || "always");
  if (decision !== "persist") return;
  if (!this._approvalStore) this._approvalStore = new Map();
  this._approvalStore.set(key, { ts: Date.now(), reason: String(reason || "").slice(0, 300) });
  this._savePersistentApprovals();
},

// 永久允许清单 (设置页展示, 可撤销)。tool/command 拆自 key, 方便人类辨认。
rememberedApprovals() {
  const out = [];
  for (const [key, v] of (this._approvalStore || new Map())) {
    const i = key.indexOf(":");
    out.push({ key, tool: i > 0 ? key.slice(0, i) : "", command: i > 0 ? key.slice(i + 1) : key, ts: v.ts || 0, reason: v.reason || "" });
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
},

forgetApproval(key) {
  const k = String(key || "");
  if (!k || !this._approvalStore?.has(k)) return false;
  this._approvalStore.delete(k);
  this._approvalCache?.delete(k);
  this._savePersistentApprovals();
  this.tracer.event("approval/forgotten", { key: k });
  return true;
},
};
