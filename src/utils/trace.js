// src/utils/trace.js - 结构化可观测轨迹 (Harness 第四层)
// 记录每次工具调用的完整轨迹: 工具/参数/结果摘要/耗时/成败
// 写 JSONL 到 data/logs/traces/YYYY-MM-DD.jsonl, 供事后复盘"哪一步坏了"
// v1.0.8: args/result 落盘前 PII 脱敏 (凭证不写日志); read(day) 支持按指定日期读取
// P0 (2026-09-15): 事件源不变量 (model-visible = logged) ——
//   turn/step 边界事件落同一 JSONL + verifyReplay() 重放校验 (配对完整性/顺序性)。
//   对齐 dsh "会话日志是模型可见内容的唯一事实源" 思想, 用皮皮虾自有结构增量实现。
import fs from "node:fs";
import path from "node:path";
import { logsDir, logicalDay } from "./store.js";
import { shortId } from "./id.js";
import { scrubPII } from "./pii.js";

const MAX_TRACE_BODY = 2000;   // 单条结果保留上限, 防爆文件

// 事件类型常量 (turn/step 边界)
export const EVT = {
  TURN_START: "turn/start",
  TURN_END: "turn/end",
  STEP_START: "step/start",
  STEP_END: "step/end",
  TOOL: "tool/call",
};

export class Traces {
  constructor(dataDir) {
    this.dir = logsDir(dataDir); // 与 core/trace.js 同一目录 (logs/traces)
    this.sessionId = shortId("s_", 6);
    this.count = 0;
  }

  _file(day = logicalDay()) { return path.join(this.dir, `${day}.jsonl`); }

  // 记录一次工具调用轨迹
  record({ tool, args, result, ok, durationMs, error }) {
    const entry = this._entry({ evt: EVT.TOOL, tool, args, result, ok, durationMs, error });
    fs.appendFileSync(this._file(), JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  // ---- P0: turn/step 边界事件 (事件源事实) ----
  recordTurnStart({ sessionId, reason } = {}) {
    return this._append({ evt: EVT.TURN_START, tsIso: new Date().toISOString(), reason: reason || "user", sessionId: sessionId || this.sessionId });
  }
  recordTurnEnd({ ok = true, rounds = 0, reason } = {}) {
    return this._append({ evt: EVT.TURN_END, ok: !!ok, rounds, reason: reason || null });
  }
  recordStepStart({ round = 0, context } = {}) {
    // context 快照 = 该 step 模型看到的上下文投影摘要 (验证 model-visible = logged)
    const safe = context ? scrubPII(JSON.stringify(context)).cleaned : null;
    return this._append({ evt: EVT.STEP_START, round, context: safe ? this._truncate(safe) : null });
  }
  recordStepEnd({ round = 0, ok = true, tool = null, error } = {}) {
    return this._append({ evt: EVT.STEP_END, round, ok: !!ok, tool: tool || null, error: error || null });
  }

  _append(extra) {
    this.count += 1;
    const entry = { ...this._base(), ...extra };
    fs.appendFileSync(this._file(), JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  _base() {
    return { ts: new Date().toISOString(), sessionId: this.sessionId, seq: this.count };
  }

  _entry({ evt, tool, args, result, ok, durationMs, error }) {
    const safeArgs = scrubPII(JSON.stringify(args ?? {})).cleaned;
    const safeResult = scrubPII(String(result ?? "")).cleaned;
    return {
      ...this._base(),
      evt: evt || EVT.TOOL,
      tool,
      args: this._truncate(safeArgs),
      result: this._truncate(safeResult),
      ok: !!ok,
      durationMs: Math.round(durationMs || 0),
      error: error || null,
    };
  }

  _truncate(s) {
    const str = String(s ?? "");
    return str.length > MAX_TRACE_BODY ? str.slice(0, MAX_TRACE_BODY) + "…" : str;
  }

  // ---- P0: 事件源不变量断言 (model-visible = logged) ----
  // 重放校验: 1) 每行可解析  2) turn/step 配对完整 (start 必有 end, 嵌套合法)  3) step round 递增无重复
  // 返回 { ok, total, errors: [] }。任何不变量破坏 → ok=false + 具体错误行, 供自愈/测试定位。
  verifyReplay(day = logicalDay()) {
    const lines = this.readRaw(day);
    const errors = [];
    const turnStack = [];
    const stepRounds = new Set();
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      let e;
      try { e = JSON.parse(lines[i]); } catch (err) { errors.push({ line: i + 1, kind: "parse", detail: err.message }); continue; }
      total++;
      if (!e || !e.evt) { errors.push({ line: i + 1, kind: "no-evt" }); continue; }
      if (e.evt === EVT.TURN_START) turnStack.push(i);
      else if (e.evt === EVT.TURN_END) {
        if (!turnStack.length) errors.push({ line: i + 1, kind: "turn-end-orphan" });
        else turnStack.pop();
      } else if (e.evt === EVT.STEP_START) {
        const r = Number(e.round);
        if (stepRounds.has(r)) errors.push({ line: i + 1, kind: "step-round-duplicate", detail: `round=${r}` });
        stepRounds.add(r);
      }
    }
    if (turnStack.length) errors.push({ kind: "turn-unclosed", detail: `剩余 ${turnStack.length} 个未闭合 turn` });
    return { ok: errors.length === 0, total, errors };
  }

  // 读原始行 (verifyReplay 用, 不跳过坏行)
  readRaw(day = logicalDay()) {
    const file = this._file(day);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  }

  // 读取某天轨迹 (最近 N 条); day 缺省 = 今天
  read(day, limit = 100) {
    const file = this._file(day);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  // 统计: 失败率/平均耗时/慢工具
  stats(day) {
    const all = this.read(day, 10000);
    if (!all.length) return { count: 0, failed: 0, failRate: "0%", slowTools: [] };
    const failed = all.filter((t) => !t.ok);
    const byTool = {};
    for (const t of all) {
      (byTool[t.tool] = byTool[t.tool] || { calls: 0, fails: 0, totalMs: 0 });
      byTool[t.tool].calls++;
      if (!t.ok) byTool[t.tool].fails++;
      byTool[t.tool].totalMs += t.durationMs;
    }
    const slow = Object.entries(byTool)
      .map(([tool, v]) => ({ tool, ...v, avgMs: Math.round(v.totalMs / v.calls) }))
      .sort((a, b) => b.avgMs - a.avgMs).slice(0, 5);
    return {
      count: all.length,
      failed: failed.length,
      failRate: all.length ? (failed.length / all.length * 100).toFixed(1) + "%" : "0%",
      slowTools: slow,
    };
  }
}
