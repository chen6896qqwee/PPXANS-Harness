// src/agent/questions.js - 回合内提问 (ask_user_question)
//
// 2026-11-02 吸收 DeepSeek-Bot 的 ask_user_question; 2026-11-12 自 approval.js 拆出。
// 与审批的区别在失败方向: 审批无人应答 = 拒绝 (安全侧); 提问无人应答 = 交还模型
// (按最合理假设继续)。提问本身不改变系统状态, 卡死整轮才是更大的损失。
import { currentTrace } from "../core/trace.js";

export const questionMethods = {
hasQuestionSurface() {
  return typeof this._onQuestionEvent === "function" || this.hasHumanChannel();
},

_emitQuestion(ev) {
  if (typeof this._onQuestionEvent === "function") { try { this._onQuestionEvent(ev); } catch {} }
},

// 返回 { answers } 或 null (取消/超时)。题目结构对齐 BOT:
//   { id, question, header?, options:[{label,description?}], multiSelect? }
askQuestions(questions) {
  const list = (Array.isArray(questions) ? questions : []).slice(0, 5).map((q, i) => ({
    id: String(q?.id || `q${i + 1}`).slice(0, 40),
    question: String(q?.question || "").trim().slice(0, 1000),
    header: q?.header == null ? "" : String(q.header).trim().slice(0, 60),
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 12).map((o) => {
      const label = String((o && typeof o === "object" ? o.label : o) ?? "").trim().slice(0, 200);
      const out = { label };
      if (o && typeof o === "object" && o.description) out.description = String(o.description).slice(0, 400);
      return out;
    }).filter((o) => o.label),
    multiSelect: q?.multiSelect === true,
  })).filter((q) => q.question);
  if (!list.length || !this.hasQuestionSurface()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = `qs_${++this._questionSeq}_${Date.now().toString(36)}`;
    const req = { id, questions: list, ts: Date.now(), sessionKey: currentTrace()?.sessionKey || this._activeSessionKey || null };
    const timeoutMs = Number(this.config.agent?.question_timeout_ms) || 300000;
    const entry = { req, resolve, timer: null };
    entry.timer = setTimeout(() => {
      this._pendingQuestions.delete(id);
      this._emitQuestion({ type: "question.close", id, reason: "timeout" });
      this.tracer.event("question/resolved", { id, reason: "timeout" });
      resolve(null); // fail-open: 超时不把回合卡死
    }, timeoutMs);
    // 2026-11-13 修复: 同审批 —— 不 unref。提问是"有人在等答案", 超时必须能真的发生;
    //   退出路径由 shutdown() 调 cancelQuestions() 收口, 不靠让进程早退。
    this._pendingQuestions.set(id, entry);
    this.tracer.event("question/requested", { id, count: list.length });
    this.protocolBus?.eq?.push?.({ type: "QUESTION_REQUESTED", payload: req });
    this._emitQuestion({ type: "question", ...req });
    this.bus?.emit("question/requested", req, { source: "agent.question" });
  });
},

// 裁决入口 (HTTP POST /api/questions/:id): { answers: [{ id, selected[], custom? }] }
// 或 { cancel: true } (用户跳过/关闭, 工具按 fail-open 交还模型)。
resolveQuestion(id, payload) {
  const entry = this._pendingQuestions.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  this._pendingQuestions.delete(id);
  const cancelled = payload?.cancel === true;
  const answers = cancelled ? null : this._normalizeAnswers(entry.req, payload);
  this.tracer.event("question/resolved", { id, reason: cancelled ? "cancelled" : "answered" });
  this.protocolBus?.eq?.push?.({ type: "QUESTION_RESOLVED", payload: { id } });
  this._emitQuestion({ type: "question.close", id, reason: cancelled ? "cancelled" : "answered" });
  entry.resolve(cancelled ? null : { answers });
  return true;
},

// 中断/会话结束时收口: 不传 sessionKey = 全部。
cancelQuestions(sessionKey, reason = "cancelled") {
  for (const [id, entry] of this._pendingQuestions) {
    const key = entry.req?.sessionKey;
    if (sessionKey && key && key !== sessionKey) continue;
    clearTimeout(entry.timer);
    this._pendingQuestions.delete(id);
    this._emitQuestion({ type: "question.close", id, reason });
    this.tracer.event("question/resolved", { id, reason });
    entry.resolve(null);
  }
},

pendingQuestions() {
  return [...this._pendingQuestions.values()].map((e) => e.req);
},

_normalizeAnswers(req, payload) {
  const given = new Map();
  for (const a of (Array.isArray(payload?.answers) ? payload.answers : [])) {
    if (!a || typeof a !== "object") continue;
    const qid = String(a.id ?? "");
    if (!qid) continue;
    const selected = (Array.isArray(a.selected) ? a.selected : [])
      .map((s) => String(s).trim().slice(0, 200)).filter(Boolean).slice(0, 20);
    const custom = a.custom == null ? "" : String(a.custom).trim().slice(0, 4000);
    given.set(qid, custom ? { id: qid, selected, custom } : { id: qid, selected });
  }
  // 每题都给出条目 (未作答 = 空 selected), 供工具如实转述给模型
  return (req?.questions || []).map((q) => given.get(q.id) || { id: q.id, selected: [] });
},
};
