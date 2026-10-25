// src/audit/verifier.js - Auditor: 独立验证 + 已验证账本 (P0① + P0②)
// 背景 (LongHorizon-Harness MEA / Self-Harness / Meta-Harness 共识):
//   自进化的头号反模式 = 模型自评成功就写持久状态。refine() 之前就是纯自评裸写经验库。
//   本模块提供确定性(非LLM)验证闸门 + 已验证账本: 只有验证通过的事实才允许写回持久状态。
//   Executor(模型) 提出结论, Auditor(本模块) 独立验收, 实库只在 Auditor 确认后落盘。
// 三个能力:
//   1. verifyLesson   — refine 的确定性闸门 (防幻觉经验 / 防空话 / 防概括不落地)
//   2. heldOutSplit   — 按时间切 train/held-out 子集, 供回归闸门用 (Self-Harness held-out 规则)
//   3. Auditor.gate   — 唯一"已验证写回"通道, 持久化 verified.json 账本, 可统计/审计
import path from "node:path";
import { ensureDir, readJson, writeJson } from "../utils/store.js";

// ---- 1. 经验闸门: LLM 提议的经验 → 确定性验收 ----
// 只做静态可测的检查, 不引入第二个 LLM 自评 (防讨好评分者)。
const ACTION_VERBS = [
  "避免","不能","不要","必须","应当","应该","先","再","检查","确认","用","加","设置",
  "尝试","换","重试","验证","确保","调用","跳过","清理","写入","读取",
  "等待","限制","指定","传入","返回","更新","删除","改为","加上","改成",
];
const ACTION_VERB_EN = /\b(avoid|ensure|verify|check|always|never|must|use|retry|dont|don't|config|pass|set|run|gunakan|before|after)\b/i;

// 可操作动词检测 (中文含集合词 || 英文动词)
export function isActionable(lesson) {
  const s = String(lesson || "");
  if (ACTION_VERB_EN.test(s)) return true;
  return ACTION_VERBS.some((v) => s.includes(v));
}

// 从经验里提取"像工具名"的标识符 (小驼峰/下划线, 短词) —— 用于幻觉接地检测
function toolIdents(s) {
  const ids = String(s || "").match(/[a-zA-Z_][a-zA-Z0-9_]{1,29}/g) || [];
  return [...new Set(ids.map((x) => x.toLowerCase()))];
}

// 接地弱判定: 若经验点名了某个"已知工具", 则该工具必须出现在失败轨迹里 (防幻觉工具)
export function groundedInFailedTraces({ lesson, failedTraces = [], knownTools = [] } = {}) {
  const known = new Set((Array.isArray(knownTools) ? knownTools : []).map((t) => String(t).toLowerCase()));
  if (!known.size) return { ok: true, checked: false }; // 无已知工具清单时跳过 (不误伤通用英文)
  const failed = new Set((Array.isArray(failedTraces) ? failedTraces : []).map((t) => String(t?.tool || "").toLowerCase()));
  const named = toolIdents(lesson).filter((id) => known.has(id)); // 经验里点名了哪些真实工具
  if (!named.length) return { ok: true, checked: false, named: [] }; // 没点名工具 → 不过度解读
  const grounded = named.filter((n) => failed.has(n));
  if (!grounded.length) {
    return { ok: false, checked: true, named, reason: `经验点名工具 ${named.join("/")} 但失败轨迹无背书, 疑似幻觉` };
  }
  return { ok: true, checked: true, named, grounded };
}

// 总闸门
export function verifyLesson(payload = {}) {
  const lesson = String(payload?.lesson || "").trim();
  if (!lesson) return { ok: false, reason: "经验为空" };
  if (lesson.length > 240) return { ok: false, reason: "经验过长 (>240字符), 非单句精炼教训" };
  if (!isActionable(lesson)) return { ok: false, reason: "经验无可操作动词 (应含 避免/必须/先/检查 等指导, 而非泛泛描述)" };
  const g = groundedInFailedTraces(payload);
  if (!g.ok) return { ok: false, reason: g.reason };
  return { ok: true, grounded: g };
}

// ---- 2. held-out 切分 (按轨迹记录顺序, 最新的作 held-out 子集) ----
// 对应 Self-Harness: 候选改动必须过 held-in + held-out 两个子集, held-out 无退化才合并。
export function heldOutSplit(traces = [], { ratio = 0.4, minTotal = 6 } = {}) {
  const arr = (Array.isArray(traces) ? traces : []).slice();
  if (arr.length < minTotal) return { train: arr, heldOut: [], skipped: true }; // 样本太少不强制切
  const n = Math.max(1, Math.floor(arr.length * ratio));
  const heldOut = arr.slice(-n);
  const train = arr.slice(0, arr.length - n);
  return { train, heldOut, skipped: false, ratio, n };
}

// ---- 3. Auditor: 唯一"已验证写回"通道 + 已验证账本 ----
// gate(kind, payload, verifier, onCommit):
//   verifier(payload) 必须确定性返回 {ok:true} 才能执行 onCommit(payload) 写实库,
//   并在 verified.json 账本追加 {ts, kind, summary} 供审计/回滚溯源。
export class Auditor {
  constructor({ ledgerPath, maxLedger = 500 } = {}) {
    this.path = ledgerPath;
    this.maxLedger = maxLedger;
    this.ledger = [];
    if (this.path) {
      ensureDir(path.dirname(this.path));
      this.ledger = readJson(this.path, []);
      if (!Array.isArray(this.ledger)) this.ledger = [];
    }
  }

  _summarize(payload) {
    const s = payload?.lesson || payload?.content || payload?.name || "";
    return String(s).slice(0, 80);
  }

  _record(kind, payload, verdict) {
    this.ledger.push({ ts: new Date().toISOString(), kind, summary: this._summarize(payload), verdict });
    if (this.ledger.length > this.maxLedger) this.ledger = this.ledger.slice(-this.maxLedger);
    if (this.path) writeJson(this.path, this.ledger);
  }

  // 仅在验证通过时才写回; 返回 { committed, reason?, verdict?, done? }
  async gate(kind, payload, verifier, onCommit) {
    const v = verifier(payload);
    if (!v || v.ok !== true) {
      this._record("reject_" + kind, payload, { ok: false, reason: v?.reason || "拒绝" });
      return { committed: false, reason: v?.reason || "未通过验证闸门", verdict: v };
    }
    const done = onCommit ? await onCommit(payload) : undefined;
    this._record(kind, payload, v);
    return { committed: true, verdict: v, done };
  }

  // 已过验证闸门后的记账 (不做二次验证; 供 refineSkill 成功后落账)
  record(kind, payload = {}) {
    this._record(kind, payload, { ok: true });
  }

  stats() {
    const byKind = {};
    for (const e of this.ledger) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    return { total: this.ledger.length, byKind };
  }
}
