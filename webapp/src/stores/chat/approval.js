// webapp/src/stores/chat/approval.js - 审批卡 / 提问卡: 服务端全局事实, 不受会话归属限制
import { PHASE } from "./machine.js";
import { chat, push, setPhase, pendingApprovalItem } from "./state.js";
import { showToast } from "../toast.js";
import {
  approvalsPendingApi, approvalDecideApi, questionsPendingApi,
  questionAnswerApi, questionSkipApi,
} from "../../api/endpoints.js";

const APPROVAL_KIND = { bash: "Bash", edit: "Edit", plan: "Plan", tool: "Tool" };
function approvalVerdict(decision, prefix) {
  if (decision === "approve") return "✓ 已批准（仅本次）";
  if (decision === "always") return "✓ 已允许（本会话）";
  if (decision === "prefix") return "✓ 已允许（本会话 · " + (prefix || "?") + " …）";
  if (decision === "persist") return "✓ 已永久允许";
  if (decision === "timeout") return "✗ 已超时未批准";
  if (decision === "deny") return "✗ 已拒绝";
  return "✗ 已关闭";
}
export function addApproval(a) {
  if (!a || !a.id) return;
  if (chat.items.find((x) => x.kind === "approval" && x.aId === a.id)) return;
  const body = a.detail || a.summary || (a.args ? JSON.stringify(a.args, null, 2) : "") || "（该操作未附详情）";
  push({
    kind: "approval", aId: a.id, kindLabel: APPROVAL_KIND[a.kind] || (a.tool ? String(a.tool) : "Tool"),
    body, reason: a.reason || "", rememberable: a.rememberable === true, prefix: a.prefix || "",
    done: false, settling: false, verdict: "",
  });
  setPhase(PHASE.approval);
}
export function closeApproval(id, decision) {
  const it = chat.items.find((x) => x.kind === "approval" && x.aId === id);
  if (!it || it.done) return;
  it.done = true;
  it.settling = false;
  it.verdict = approvalVerdict(decision, it.prefix);
  if (!pendingApprovalItem.value) setPhase(chat.streaming ? PHASE.thinking : PHASE.idle);
}
export async function resolveApproval(id, decision) {
  const it = chat.items.find((x) => x.kind === "approval" && x.aId === id);
  if (!it || it.done || it.settling) return;
  it.settling = true;
  try {
    await approvalDecideApi(id, decision);
    closeApproval(id, decision);
    if (decision === "prefix") showToast("本会话内以「" + (it.prefix || "?") + "」开头的单条命令不再询问 (重启后失效)");
    if (decision === "persist") showToast("已永久允许该命令 — 可在 设置 → 通用设置 撤销");
    setPhase(PHASE.thinking);
  } catch (e) {
    // 404/已结束 = 这张卡早就在别处被裁决或已超时, 不是网络故障 —— 收口即可, 不再弹错。
    if (/404|已结束|已超时|gone/i.test(String((e && e.message) || ""))) {
      closeApproval(id, "gone");
      return;
    }
    it.settling = false;
    showToast((e && e.message) || "操作失败", true);
  }
}
export async function pollApprovals() {
  try {
    const j = await approvalsPendingApi();
    const list = (j && j.approvals) || [];
    const alive = {};
    list.forEach((a) => {
      alive[a.id] = true;
      addApproval(a);
    });
    // 反查已收口但还留在界面上的僵尸卡 (刚出现 <5s 的卡可能只是快照滞后, 先不下结论)
    const now = Date.now();
    for (const it of chat.items) {
      if (it.kind !== "approval" || it.done || it.settling) continue;
      if (alive[it.aId] || now - (it.bornAt || 0) < 5000) continue;
      it.done = true;
      it.verdict = "✗ 已失效 (已在别处裁决或已超时)";
    }
  } catch { /* 端点不存在 → 静默降级 */ }
}

/* ---------- 提问 (ask_user) ---------- */
export function addQuestion(q) {
  if (!q || !q.id) return null;
  if (chat.items.find((x) => x.kind === "question" && x.qId === q.id)) return null;
  const qs = Array.isArray(q.questions) ? q.questions : [];
  if (!qs.length) return null;
  const it = push({
    kind: "question", qId: q.id, qs, done: false, settling: false,
    answers: qs.map((item, i) => ({ qid: item.id || ("q" + (i + 1)), selected: [], custom: "" })),
  });
  setPhase(PHASE.answer);
  return it;
}
function settleQuestion(item, verdict) {
  if (!item || item.done) return;
  item.done = true;
  item.settling = false;
  item.verdict = verdict;
  setPhase(PHASE.thinking);
}
export async function submitQuestion(item) {
  if (!item || item.done || item.settling) return;
  item.settling = true;
  const answers = item.answers.map((a) => ({
    id: a.qid,
    selected: a.selected.slice(),
    custom: (a.custom || "").trim() || undefined,
  }));
  try {
    await questionAnswerApi(item.qId, { answers });
    settleQuestion(item, "✓ 已回答");
  } catch (e) {
    item.settling = false;
    showToast((e && e.message) || "提交失败", true);
  }
}
export async function skipQuestion(item) {
  if (!item || item.done || item.settling) return;
  item.settling = true;
  try {
    await questionSkipApi(item.qId);
    settleQuestion(item, "已跳过 · 模型按最合理假设继续");
  } catch (e) {
    item.settling = false;
    showToast((e && e.message) || "操作失败", true);
  }
}
export function closeQuestion(id, reason) {
  const it = chat.items.find((x) => x.kind === "question" && x.qId === id);
  if (!it || it.done) return;
  const text = reason === "timeout" ? "等待超时 · 已交还模型继续"
    : reason === "interrupted" ? "本轮已中断"
    : "已关闭";
  settleQuestion(it, text);
}
export async function pollQuestions() {
  try {
    const j = await questionsPendingApi();
    ((j && j.questions) || []).forEach((q) => addQuestion(q));
  } catch { /* 端点不存在 → 静默降级 */ }
}
