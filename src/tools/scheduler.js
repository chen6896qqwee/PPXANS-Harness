// src/tools/scheduler.js - 定时任务 (每日 HH:MM / after:Ns / 5 段 cron)
// 2026-11-12 自 advanced.js 拆出: 调度是独立基础设施 (agent 装配、add_schedule 工具、
//   驱逐扫描都消费它), 与"进阶工具注册"没有共同状态。
import path from "node:path";
import { ensureDir, readJson, writeJson } from "../utils/store.js";
import { error as loggerError } from "../utils/logger.js";

// 2026-09-18 修复 (P1): 原构造函数只从 jobs.json 恢复 jobs 数组、从不 _schedule(),
//   且 add() 传入的 action 是运行时闭包, JSON.stringify 落盘时被静默丢弃 ——
//   进程重启后所有持久化任务没有任何定时器在跑, 触发了也因无 action 空转。
//   现: ① 构造时重排每日 (HH:MM) 任务; 陈旧的 once (after:Ns) 任务跨重启丢弃不补触发;
//       ② _fire 对无 action 的恢复任务走 onFire 回调 (由注册方按 job.name 还原行为)。
// v5.0 (P2.3): 新增 5 段 cron 支持 (分 时 日 月 周) —— 纯 JS 解析零依赖, 精确到分钟;
//   重启恢复: cron 型任务按表达式重排下一次触发 (错过的历史不补跑, 与每日任务同口径)。
const CRON_RANGE = { 0: [0, 59], 1: [0, 23], 2: [1, 31], 3: [1, 12], 4: [0, 7] };

// 单字段匹配: "*" / "N" / "N-M" / "*/step" / "N-M/step" / 逗号列表。周字段 7=周日 归一 0。
function cronFieldMatch(spec, value, field) {
  const [lo, hi] = CRON_RANGE[field];
  for (const part of String(spec).split(",")) {
    const p = part.trim();
    if (!p) continue;
    let range = p, step = 1;
    const slash = p.indexOf("/");
    if (slash >= 0) {
      range = p.slice(0, slash);
      step = parseInt(p.slice(slash + 1), 10);
      if (!(step >= 1)) return false;
    }
    let start = lo, end = hi;
    if (range !== "*" && range !== "?") {
      const dash = range.indexOf("-");
      if (dash >= 0) {
        start = parseInt(range.slice(0, dash), 10);
        end = parseInt(range.slice(dash + 1), 10);
      } else {
        start = end = parseInt(range, 10);
        if (Number.isNaN(start)) return false;
      }
    }
    if (![start, end].every((x) => Number.isFinite(x))) return false;
    if (field === 4) { // 周: 7 归一为 0 (周日), 0 与 7 等价
      if (start === 7) start = 0;
      if (end === 7) end = 0;
      if (start > end) return false;
    }
    if (start < lo || end > hi || start > end) return false;
    for (let v = start; v <= end; v += step) {
      if (v === value) return true;
    }
  }
  return false;
}

// 是否 5 段 cron 表达式 (区别于 "HH:MM" / "after:Ns")
export function isCronExpr(expr) {
  if (typeof expr !== "string") return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => p.length > 0 && /^[\d*,/\-?]+$/.test(p) && /[\d*]/.test(p));
}

// 计算 5 段 cron 的下一次触发时间 (精确到分钟, 从 from 之后找)。非法表达式返回 null。
export function cronNextRun(expr, from = new Date()) {
  if (!isCronExpr(expr)) return null;
  const parts = expr.trim().split(/\s+/);
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1); // 严格"之后"
  const limit = new Date(t.getTime() + 366 * 24 * 3600 * 1000);
  while (t <= limit) {
    // 月/日/周 先粗筛 (整月跳), 再逐分钟扫 —— 最坏一年 525600 次太慢, 月级粗筛后只剩 ~4万次
    if (!cronFieldMatch(parts[3], t.getMonth() + 1, 3)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    const domLimited = parts[2] !== "*" && parts[2] !== "?";
    const dowLimited = parts[4] !== "*" && parts[4] !== "?";
    if (domLimited && dowLimited) {
      // 标准 cron 语义: 日与周同时受限 = OR (任一命中即可)
      const domOk = cronFieldMatch(parts[2], t.getDate(), 2);
      const dowOk = cronFieldMatch(parts[4], t.getDay(), 4);
      if (!domOk && !dowOk) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
    } else {
      if (domLimited && !cronFieldMatch(parts[2], t.getDate(), 2)) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
      if (dowLimited && !cronFieldMatch(parts[4], t.getDay(), 4)) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
    }
    if (!cronFieldMatch(parts[1], t.getHours(), 1)) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (!cronFieldMatch(parts[0], t.getMinutes(), 0)) { t.setMinutes(t.getMinutes() + 1, 0, 0); continue; }
    return new Date(t);
  }
  return null;
}

export class Scheduler {
  constructor(dataDir, { onFire = null } = {}) {
    this.dir = path.join(dataDir, "scheduler");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "jobs.json");
    this.onFire = onFire;
    this.timers = new Map(); // 必须先于恢复重排初始化 (2026-09-18 回归测试抓出)
    const loaded = readJson(this.file, []);
    // 重启恢复: 重排每日 + 5 段 cron 任务; once (after:Ns) 任务视为陈旧丢弃 (语义 = "N秒后一次", 跨重启已失义)
    this.jobs = [];
    for (const job of loaded) {
      if (job && job.enabled === false) { this.jobs.push(job); continue; }
      const isDaily = typeof job?.cron === "string" && /^\d{2}:\d{2}$/.test(job.cron);
      const isCron = isCronExpr(job?.cron);
      if (isDaily || isCron) {
        if (isCron && job.type !== "cron") { job.type = "cron"; } // 跨版本兼容: 旧账本可能标成别的
        this.jobs.push(job);
        this._schedule(job);
      }
    }
    if (this.jobs.length !== loaded.length) writeJson(this.file, this.jobs);
  }

  add({ name, cron, action, type = "once" }) {
    const job = {
      id: "j_" + Math.random().toString(36).slice(2, 8),
      name, cron, action, type, enabled: true, createdAt: new Date().toISOString(),
    };
    this.jobs.push(job);
    writeJson(this.file, this.jobs);
    this._schedule(job);
    return job;
  }

  _schedule(job) {
    if (this.timers.has(job.id)) clearTimeout(this.timers.get(job.id));
    // 简化 cron: 支持 "HH:MM" (每日) / "after:Ns" (N秒后) / 5 段 cron (v5.0, 精确到分钟)
    let delayMs = null;
    if (typeof job.cron === "string" && isCronExpr(job.cron)) {
      const next = cronNextRun(job.cron, new Date());
      delayMs = next ? next - new Date() : null;
    } else if (typeof job.cron === "string" && job.cron.startsWith("after:")) {
      delayMs = parseInt(job.cron.split(":")[1], 10) * 1000;
    } else if (typeof job.cron === "string" && /^\d{2}:\d{2}$/.test(job.cron)) {
      const [h, m] = job.cron.split(":").map(Number);
      const now = new Date();
      const target = new Date(now); target.setHours(h, m, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      delayMs = target - now;
    } else if (typeof job.cron === "number") {
      delayMs = job.cron * 1000;
    }
    if (delayMs === null) return;
    const timer = setTimeout(() => this._fire(job), Math.max(1000, delayMs));
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(job.id, timer);
  }

  async _fire(job) {
    if (job.type === "once") { this.remove(job.id); }
    else { this._schedule(job); } // 每日/cron 任务重新排
    try {
      if (typeof job.action === "function") await job.action();
      else if (this.onFire) await this.onFire(job); // 重启恢复的任务: action 闭包已丢, 走注册方回调
    } catch (e) { loggerError("定时任务失败:", e); }
  }

  remove(id) {
    if (this.timers.has(id)) { clearTimeout(this.timers.get(id)); this.timers.delete(id); }
    this.jobs = this.jobs.filter((j) => j.id !== id);
    writeJson(this.file, this.jobs);
  }

  list() { return this.jobs.map(({ id, name, cron, enabled }) => ({ id, name, cron, enabled })); }

  // 清理所有定时器 (进程关停时调用, 防 daily/repeating 任务把事件循环挂住不退出)
  shutdown() {
    for (const [_id, t] of this.timers) { try { clearTimeout(t); } catch {} }
    this.timers.clear();
  }
}
