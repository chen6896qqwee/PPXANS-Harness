// src/utils/trace.js - 结构化可观测轨迹 (Harness 第四层)
// 记录每次工具调用的完整轨迹: 工具/参数/结果摘要/耗时/成败
// 写 JSONL 到 data/logs/traces/YYYY-MM-DD.jsonl, 供事后复盘"哪一步坏了"
// v1.0.8: args/result 落盘前 PII 脱敏 (凭证不写日志); read(day) 支持按指定日期读取
// P0 (2026-09-15): 事件源不变量 (model-visible = logged) ——
//   turn/step 边界事件落同一 JSONL + verifyReplay() 重放校验 (配对完整性/顺序性)。
//   对齐设计溯源 docs/PROVENANCE.md#dsh "会话日志是模型可见内容的唯一事实源" 思想, 用皮皮虾自有结构增量实现。
import fs from "node:fs";
import path from "node:path";
import { logsDir, logicalDay } from "./store.js";
import { shortId } from "./id.js";
import { scrubPII } from "./pii.js";
import { noteCatch } from "./catch-log.js";
import {
  normalizeEvalStrata,
  sampleEvalTask,
  DEFAULT_EVAL_SAMPLE_RATE,
} from "./eval-sampling.js";

const MAX_TRACE_BODY = 2000;   // 单条结果保留上限, 防爆文件
const EVAL_EVENTS = new Set(["eval/tool", "eval/turn", "eval/request"]);
const SAFETY_FLAGS = new Set(["denied_by_design", "security", "injection-suspect", "permission"]);

// 事件类型常量 (turn/step 边界)
export const EVT = {
  TURN_START: "turn/start",
  TURN_END: "turn/end",
  STEP_START: "step/start",
  STEP_END: "step/end",
  TOOL: "tool/call",
  EVAL_TOOL: "eval/tool",
  EVAL_TURN: "eval/turn",
  EVAL_REQUEST: "eval/request",
};

function unknown(value) {
  return value == null || value === "" ? "unknown" : String(value);
}

function isSafetyEvalEvent(payload, opts) {
  if (opts?.safety === true || payload?.safety === true || payload?.security === true) return true;
  if (payload?.category === "denied_by_design") return true;
  return Array.isArray(payload?.flags) && payload.flags.some((flag) => SAFETY_FLAGS.has(String(flag)));
}

export class Traces {
  constructor(dataDir, traceContext = null) {
    this.dir = logsDir(dataDir); // 与 core/trace.js 同一目录 (logs/traces)
    this.sessionId = shortId("s_", 6);
    this.count = 0;
    this.traceContext = traceContext;
  }

  _file(day = logicalDay()) { return path.join(this.dir, `${day}.jsonl`); }

  // 记录一次工具调用轨迹
  record({ tool, args, result, ok, durationMs, error, flags }) {
    const entry = this._entry({ evt: EVT.TOOL, tool, args, result, ok, durationMs, error, flags });
    fs.appendFileSync(this._file(), JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  // 生产评测事件与普通 tool/call 共存于同一 JSONL, 但只有本方法受任务级采样影响。
  // 支持 recordEval("eval/tool", payload, opts) 与 recordEval({evt, ...payload}, opts) 两种形态。
  // 采样/脱敏都在元信息补齐之后执行, taskId/traceId/strata/sampleWeight 不会因 PII 清洗遗漏。
  recordEval(evt, payload = {}, opts = {}) {
    let type = evt;
    let data = payload;
    let options = opts;
    if (evt && typeof evt === "object") {
      data = evt;
      options = payload && typeof payload === "object" ? payload : {};
      type = evt.evt;
    }
    if (!EVAL_EVENTS.has(type)) return null;
    const source = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    const store = this.traceContext?.() || null;
    const taskId = unknown(source.taskId ?? store?.taskId ?? store?.traceId);
    const traceId = unknown(source.traceId ?? store?.traceId);
    const strata = normalizeEvalStrata(source.strata ?? store?.strata);
    const safety = isSafetyEvalEvent(source, options);
    const sampling = safety
      ? { sampled: true, sampleWeight: 1, sampleReason: "safety" }
      : sampleEvalTask(taskId, strata, options.sampleRate ?? store?.evalSampleRate ?? DEFAULT_EVAL_SAMPLE_RATE);
    if (!sampling.sampled) return null;

    let safe;
    try { safe = JSON.parse(scrubPII(JSON.stringify(source)).cleaned); }
    catch (e) { noteCatch(e); safe = { _raw: "(unserializable)" }; }
    // 元信息最后覆盖, 既防 payload 伪造采样权重, 也防脱敏器改写关联字段。
    const entry = {
      ...this._base(),
      ...safe,
      evt: type,
      taskId,
      traceId,
      sessionKey: unknown(source.sessionKey ?? store?.sessionKey),
      strata,
      sampled: true,
      sampleWeight: sampling.sampleWeight,
      sampleReason: sampling.sampleReason,
    };
    if (entry.args !== undefined) {
      const args = typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args);
      entry.args = this._truncate(args);
    }
    if (typeof entry.result === "string") entry.result = this._truncate(entry.result);
    if (typeof entry.error === "string") entry.error = this._truncate(entry.error);
    this.count += 1;
    entry.seq = this.count;
    try { fs.appendFileSync(this._file(), JSON.stringify(entry) + "\n", "utf8"); }
    catch (e) { noteCatch(e); /* 评测留样失败不阻断业务调用 */ }
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

  _entry({ evt, tool, args, result, ok, durationMs, error, flags }) {
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
      ...(Array.isArray(flags) && flags.length ? { flags } : {}),
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
      if (e && EVAL_EVENTS.has(e.evt)) continue; // 评测留样不参与旧 total/turn/step 重放口径
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

  // 统计: 失败率/平均耗时/慢工具。**只统计工具调用** —— P0 起同一份 JSONL 还混有
  //   turn/step 边界事件, 它们没有 ok/durationMs; 旧实现把它们算成失败调用, 面板会凭空
  //   多出失败率和一条 tool=undefined 的慢工具。turns = 当天的 turn/start 条数
  //   (没有边界事件的老文件给 null: 面板显示"未知", 不报一个假的 0)。
  stats(day) {
    const all = this.read(day, 10000);
    const tools = all.filter((t) => !t.evt || t.evt === EVT.TOOL);
    const hasTurnEvents = all.some((t) => t.evt === EVT.TURN_START || t.evt === EVT.TURN_END);
    const turns = hasTurnEvents ? all.filter((t) => t.evt === EVT.TURN_START).length : null;
    if (!tools.length) return { count: 0, failed: 0, failRate: "0%", slowTools: [], turns };
    const failed = tools.filter((t) => !t.ok);
    const byTool = {};
    for (const t of tools) {
      const name = t.tool || "(unknown)";
      (byTool[name] = byTool[name] || { calls: 0, fails: 0, totalMs: 0 });
      byTool[name].calls++;
      if (!t.ok) byTool[name].fails++;
      byTool[name].totalMs += Number(t.durationMs) || 0;
    }
    const slow = Object.entries(byTool)
      .map(([tool, v]) => ({ tool, ...v, avgMs: Math.round(v.totalMs / v.calls) }))
      .sort((a, b) => b.avgMs - a.avgMs).slice(0, 5);
    return {
      count: tools.length,
      failed: failed.length,
      failRate: tools.length ? (failed.length / tools.length * 100).toFixed(1) + "%" : "0%",
      slowTools: slow,
      turns,
    };
  }
}
