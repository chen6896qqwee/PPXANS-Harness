// webapp/src/stores/chat/tools.js - 工具卡: 一次工具调用在时间线上的生命周期
import { chat, push } from "./state.js";

export function toolKindOf(name) {
  const n = String(name || "").toLowerCase();
  if (/^(read|read_file|view|cat)$/.test(n)) return "read";
  if (/^(grep|rg|ripgrep|search_files)$/.test(n)) return "search";
  if (/^(glob|ls|list|find|list_files|list_directory)$/.test(n)) return "files";
  if (/^(bash|shell|sh|exec|run|terminal)$/.test(n)) return "shell";
  return "other";
}
const AGENT_COLORS = ["#f0653c", "#5b8def", "#3ecf8e", "#c78a2d", "#9b6dd6", "#3ba8a0", "#d05f8f", "#7a86c9"];
export function agentColor(name) {
  let h = 0;
  for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}
export function addToolCard(ev) {
  let sum = "";
  if (ev.args) {
    const a = ev.args;
    if (a.path || a.file || a.file_path) sum = a.path || a.file || a.file_path;
    else if (a.command || a.cmd) sum = a.command || a.cmd;
    else if (a.query || a.q) sum = a.query || a.q;
    else if (a.url) sum = a.url;
    else sum = JSON.stringify(ev.args).slice(0, 120);
  }
  push({
    kind: "tool", tool: ev.tool, tsum: sum, agent: ev.agent || "",
    tId: ev.id || null, args: ev.args || {},
    status: "run", durationMs: null, result: "", ok: true,
    argsOpen: false, resultOpen: false,
  });
}
export function finishToolCard(ev) {
  const key = ev.id || ev.tool;
  let it = null;
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const x = chat.items[i];
    if (x.kind === "tool" && (x.tId === key || (!x.tId && x.tool === ev.tool && x.status === "run"))) { it = x; break; }
  }
  if (!it) return;
  it.tId = it.tId || key;
  const ok = ev.ok !== false;
  it.status = ok ? "ok" : "fail";
  it.durationMs = ev.durationMs != null ? ev.durationMs : null;
  it.result = String(ev.result == null ? "" : ev.result);
  it.ok = ok;
}
export function toggleAllTools(force) {
  const more = chat.items.filter((x) => x.kind === "tool" && x.result);
  if (!more.length) return;
  const anyClosed = force !== undefined ? force : more.some((x) => !x.resultOpen);
  more.forEach((x) => { x.resultOpen = anyClosed; });
}
