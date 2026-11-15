// src/utils/catch-log.js — 关键路径空 catch 的统一留痕点 (2026-11-03)
// 背景: scripts/silent-catch-guard.mjs --strict 要求账目/持久化/审计/记忆路径上的
//   catch 必须留痕。这些位置大多是"可降级继续"的分支 (磁盘暂不可写 / 格式损坏 /
//   清理失败), 直接 warn 会在长跑里刷屏; 但彻底吞掉会让故障无法复盘 —— 本项目出现
//   过 ReferenceError 被 catch{} 吃掉、成本护栏静默失效的事故。
// 做法: 每次进 catch 记一条 {scope,where,error,ts} 到有界环形缓冲 (默认上限 200 条),
//   PPX_CATCH_TRACE=1 时实时打 debug 日志; 同一位置累计 5 次升级为一条 warn (每处一次),
//   退出时由 shutdown 汇总。只存不读 = 静默存错, 读取端见 catchStats()。
import { debug, warn } from "./logger.js";

const MAX = 200;
const ESCALATE_AT = 5;
const GENERIC = new Set(["if", "for", "while", "do", "else", "try", "catch", "switch", "return", "warn", "debug", "info", "error", "log"]);
const ring = [];
const counts = new Map(); // label -> { count, lastTs, lastError }
const escalated = new Set();
let dropped = 0;
let total = 0;

// 调用点 (文件:行) —— 复盘时 scope 手填错了也能定位; 跳过 catch-log 自身与 Error 构造帧
function callerWhere() {
  for (const line of String(new Error().stack || "").split("\n")) {
    if (line.includes("catch-log.")) continue;
    const m = line.match(/\(?([^\s()]+):(\d+):\d+\)?$/);
    if (!m) continue;
    let file = m[1].replace(/^file:\/\//, "").replace(/\\/g, "/");
    const rel = file.match(/\/((?:src|bin|electron|scripts|test)\/.*)$/);
    if (rel) file = rel[1];
    try { file = decodeURIComponent(file); } catch { /* 保持原样 */ }
    return `${file}:${m[2]}`;
  }
  return "?";
}

export function noteCatch(scope, err) {
  // noteCatch(err) = 由栈自动定位 (新写法); noteCatch("file#fn", err) = 手填标签 (兼容)
  if (typeof scope !== "string") { err = scope; scope = ""; }
  const where = callerWhere();
  const tag = scope.includes("#") ? scope.slice(scope.lastIndexOf("#") + 1) : scope;
  const label = scope && !GENERIC.has(tag) ? scope : where;
  const rec = {
    scope: label,
    where,
    error: String((err && (err.message || err)) || "unknown"),
    ts: Date.now(),
  };
  total++;
  ring.push(rec);
  if (ring.length > MAX) { ring.shift(); dropped++; }
  const c = counts.get(label) || { count: 0, lastTs: 0, lastError: "" };
  c.count++; c.lastTs = rec.ts; c.lastError = rec.error;
  counts.set(label, c);
  if (process.env.PPX_CATCH_TRACE === "1") debug(`[catch] ${label} (${where}): ${rec.error}`);
  if (c.count === ESCALATE_AT) {
    escalated.add(label);
    warn(`[catch] 同一位置已累计 ${c.count} 次异常: ${label} (${where}) 最近: ${rec.error}`);
  }
}

// 复盘入口: 返回最近的关键路径异常 (最多 200 条, 按发生顺序)
export function recentCatches() {
  return ring.slice();
}

// 汇总读取端 (shutdown / /health): 总量、溢出丢弃数、按位置聚合 (错误文本只给最后一次)
export function catchStats() {
  const scopes = [...counts.entries()]
    .map(([scope, v]) => ({ scope, count: v.count, lastTs: v.lastTs, lastError: v.lastError }))
    .sort((a, b) => b.count - a.count || a.scope.localeCompare(b.scope));
  return { total, dropped, escalated: escalated.size, scopes };
}

// 一行摘要, 无异常时返回空串 (调用方零噪音)
export function catchSummaryLine() {
  if (!total) return "";
  const top = catchStats().scopes.slice(0, 3).map((s) => `${s.scope}×${s.count}`).join(", ");
  return `关键路径异常留痕 ${total} 条${dropped ? ` (环满丢弃 ${dropped})` : ""}; 高频: ${top}`;
}
