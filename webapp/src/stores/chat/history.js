// webapp/src/stores/chat/history.js - 输入历史 (本机会话级, localStorage)
import { chat } from "./state.js";

function histKey() { return "ppx_hist_" + (chat.sessionKey || "default"); }
export function loadHist() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(histKey()) || "[]"); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  chat.hist = { list: arr.filter((x) => typeof x === "string" && x.trim()).slice(-100), idx: -1, draft: "" };
}
export function pushHist(text) {
  const t = String(text || "");
  if (!t.trim()) return;
  const list = chat.hist.list;
  if (list[list.length - 1] !== t) list.push(t);
  if (list.length > 100) list.splice(0, list.length - 100);
  try { localStorage.setItem(histKey(), JSON.stringify(list)); } catch { /* 忽略 */ }
  chat.hist.idx = -1;
  chat.hist.draft = "";
}
export function histStep(dir, apply) {
  const list = chat.hist.list;
  if (!list.length) return;
  if (dir < 0) {
    if (chat.hist.idx === -1) chat.hist.draft = chat.input;
    if (chat.hist.idx < list.length - 1) chat.hist.idx++;
    apply(list[list.length - 1 - chat.hist.idx]);
  } else {
    if (chat.hist.idx === -1) return;
    if (chat.hist.idx > 0) {
      chat.hist.idx--;
      apply(list[list.length - 1 - chat.hist.idx]);
    } else {
      chat.hist.idx = -1;
      apply(chat.hist.draft || "");
    }
  }
}
