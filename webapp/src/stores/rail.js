// webapp/src/stores/rail.js - 侧栏数据: 会话列表 / 任务面板 / 空间
// 自旧 app.js 的会话/任务/空间三节移植。会话操作的字段名是跨端契约 (后端读 data.key)。

import { reactive } from "vue";
import { showToast } from "./toast.js";
import { confirmAsk, promptAsk } from "./ui.js";
import {
  loadSessionsApi, searchSessionsApi, pinSessionApi, titleSessionApi,
  archiveSessionApi, deleteSessionApi, tasksApi, workspaceTreeApi,
} from "../api/endpoints.js";

export const rail = reactive({
  sessions: [],
  sessLoaded: false,
  tasks: [],
  tasksLoaded: false,
  spaces: [],
  activeSpace: null,
  wsSub: "",            // 工作区子目录 (相对路径; 空 = 整个工作区)
  searchHits: null,     // 全文检索结果 (null = 正常列表; 数组 = 搜索结果模式)
  searchQuery: "",
});

/* ---------- 会话 ---------- */
export async function loadSessions() {
  try {
    const j = await loadSessionsApi();
    rail.sessions = (j && j.sessions) || [];
    rail.sessLoaded = true;
  } catch {
    // 有旧列表就留着 (会话事实变化慢, 旧列表比空列表有用); 首次失败由 UI 给重试
  }
}

export async function searchSessions(q) {
  const query = String(q || "").trim();
  if (!query) return null;
  const j = await searchSessionsApi(query);
  showToast("匹配 " + ((j && j.hits) || []).length + " 个会话" + ((j && j.hits || []).length ? "" : " · 换个关键词试试"));
  return (j && j.hits) || [];
}

export async function togglePin(key, pinned) {
  try {
    await pinSessionApi(key, !!pinned);
    await loadSessions();
  } catch (e) {
    showToast("置顶失败: " + ((e && e.message) || "未知错误"), true);
  }
}

export async function renameSession(key, cur) {
  try {
    const t = await promptAsk("输入新标题 (清空 = 恢复自动标题)。", { title: "重命名会话", value: cur || "", placeholder: "会话标题" });
    if (t == null) return;
    const j = await titleSessionApi(key, String(t).trim());
    if (!j || !j.ok) throw new Error("后端未确认重命名");
    await loadSessions();
  } catch (e) {
    showToast("重命名失败: " + ((e && e.message) || "未知错误"), true);
  }
}

export async function archiveSession(key, archived) {
  try {
    await archiveSessionApi(key, !!archived);
    await loadSessions();
  } catch (e) {
    showToast(((e && e.message) || "归档失败"), true);
  }
}

export async function removeSession(key) {
  const ok = await confirmAsk("删除后该会话的事件日志会从列表移除, 但不会影响其他会话。", {
    title: "删除会话?", okText: "删除", danger: true,
  });
  if (!ok) return false;
  try {
    // 字段名必须与后端一致 (后端 /sessions/delete 读 data.key)
    await deleteSessionApi(key);
    return true;
  } catch (e) {
    showToast((e && e.message) || "删除失败", true);
    return false;
  }
}

/* ---------- 任务 ---------- */
export const TASK_LABEL = { todo: "待办", running: "进行", done: "完成", failed: "失败" };

export async function loadTasks() {
  try {
    const j = await tasksApi();
    rail.tasks = (j && j.tasks) || [];
    rail.tasksLoaded = true;
  } catch {
    if (!rail.tasksLoaded) rail.tasksLoaded = false;
  }
}

/* ---------- 空间 (按项目聚合会话; localStorage 持久化) ---------- */
// 空间 = { name, root(相对路径, 空 = 皮皮虾根目录), sessionKey(绑定的会话) }
function bootRoot() {
  const b = window.__PPX_BOOTSTRAP__;
  return (b && b.root) || "";
}
export function rootName() {
  const r = bootRoot();
  return r ? (r.split(/[\\/]/).filter(Boolean).pop() || "皮皮虾") : "皮皮虾";
}
export function relOfRoot(root) {
  const r = String(root || "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (!r) return "";
  const base = bootRoot().replace(/[\\/]+$/, "");
  if (/^[a-zA-Z]:[\\/]/.test(r) || r.startsWith("/")) {
    if (base && r.toLowerCase().startsWith(base.toLowerCase() + "\\")) return r.slice(base.length + 1).replace(/\\/g, "/");
    if (base && r.toLowerCase().startsWith(base.toLowerCase() + "/")) return r.slice(base.length + 1);
    return r; // 工作区外的绝对路径: 后端越界拦截, 保留原样以显式失败
  }
  return r;
}

export function loadSpaces() {
  try {
    const list = JSON.parse(localStorage.getItem("ppx_spaces") || "[]");
    rail.spaces = Array.isArray(list) ? list : [];
  } catch { rail.spaces = []; }
}
function saveSpaces() {
  try { localStorage.setItem("ppx_spaces", JSON.stringify(rail.spaces)); } catch { /* 忽略 */ }
}

export function addSpace(name, root) {
  if (rail.spaces.find((x) => x.name === name)) {
    showToast("同名项目已存在", true);
    return false;
  }
  rail.spaces.unshift({ name, root: root || "", sessionKey: null });
  saveSpaces();
  showToast("项目已创建: " + name + (root ? " (" + root + ")" : " (皮皮虾根目录)"));
  return true;
}

export function bindSpaceSession(name, sessionKey) {
  const sp = rail.spaces.find((x) => x.name === name);
  if (!sp) return;
  sp.sessionKey = sessionKey;
  saveSpaces();
}

export async function removeSpace(name) {
  const ok = await confirmAsk("「" + name + "」只是从项目列表移除, 会话与目录都不会删除。", {
    title: "移除项目?", okText: "移除", danger: true,
  });
  if (!ok) return;
  rail.spaces = rail.spaces.filter((x) => x.name !== name);
  if (rail.activeSpace === name) rail.activeSpace = null;
  saveSpaces();
}

/* ---------- 工作区目录选择弹层用的目录列举 ---------- */
export async function listDirs(rel) {
  const j = await workspaceTreeApi(1, rel || "");
  const t = j && j.tree;
  const nodes = Array.isArray(t) ? t : ((t && t.children) || (j && j.items) || []);
  return (nodes || []).filter((n) => (n.type === "dir" || n.dir) && !String(n.name || "").startsWith("."));
}
