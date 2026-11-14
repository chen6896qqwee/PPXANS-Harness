// webapp/src/stores/chat/session.js - 会话切换与历史回放
import { chat, push, addAgentCard, addError, clearTimeline } from "./state.js";
import { confirmAsk } from "../ui.js";
import { rail, loadSessions, bindSpaceSession } from "../rail.js";
import { sessionHistoryApi } from "../../api/endpoints.js";
import { loadHist } from "./history.js";

export async function loadHistory(key) {
  try {
    const j = await sessionHistoryApi(key);
    const msgs = (j && j.messages) || [];
    chat.items = [];
    if (!msgs.length) return; // 无历史 → 回落到空态首屏
    for (const m of msgs) {
      if (!m || typeof m.content !== "string" || !m.content) continue;
      if (m.role === "user") push({ kind: "user", text: m.content });
      else {
        const c = addAgentCard();
        c.streaming = false;
        c.text = m.content;
      }
    }
  } catch {
    addError("历史加载失败, 可能是会话不存在或服务未响应");
  }
}

export function switchSessionNow(key, title) {
  chat.sessionKey = key;
  chat.sessionTitle = title || key;
  try { localStorage.setItem("ppx_session", key); } catch { /* 忽略 */ }
  loadHist();
  clearTimeline();
  loadHistory(key);
  loadSessions();
}

export function switchSession(key, title) {
  if (key === chat.sessionKey) { loadHist(); loadSessions(); return; }
  if (chat.streaming) {
    confirmAsk("正在生成中 — 切换后本回合的实时画面会停止更新, 结果完成后仍会入库 (重进该会话或刷新可见)。要切换吗?", {
      title: "正在生成中", okText: "切换",
    }).then((ok) => { if (ok) switchSessionNow(key, title); });
    return;
  }
  switchSessionNow(key, title);
}

export function newSession() {
  const go = () => {
    chat.sessionKey = "s_" + Date.now();
    chat.sessionTitle = "新会话";
    try { localStorage.setItem("ppx_session", chat.sessionKey); } catch { /* 忽略 */ }
    loadHist();
    clearTimeline();
    // 空间绑定: 从空间进入的新会话自动归属该空间, 同项目不再重复建散会话
    if (rail.activeSpace) bindSpaceSession(rail.activeSpace, chat.sessionKey);
    loadSessions();
  };
  if (chat.streaming) {
    confirmAsk("正在生成中 — 新对话后本回合的实时画面会停止更新, 结果完成后仍会入库。要新开吗?", {
      title: "正在生成中", okText: "新对话",
    }).then((ok) => { if (ok) go(); });
    return;
  }
  go();
}
