// webapp/src/stores/panels.js - 工作区抽屉四个面板: 文件树 / 目标看板 / 审查报告 / 工单账本
// 自旧 app.js 抽屉三节 + 工单节移植。工单在 /events 总线有 ticket_* 事件时实时刷新,
// 面板打开时 5s 兜底轮询 (隐藏页暂停), 详情展开时暂停自动刷新。

import { reactive } from "vue";
import { showToast } from "./toast.js";
import { workspaceTreeApi, workspaceReadApi, goalBoardApi, reviewLatestApi, verifyRecordsApi, evolveStatusApi, ticketDetailApi, ticketOpApi } from "../api/endpoints.js";
import { rail } from "./rail.js";

export const TICKET_LABEL = { admitted: "排队", working: "执行中", waiting: "等待", done: "完成", failed: "失败", cancelled: "取消" };
export const TICKET_TONE = { admitted: "ts-todo", working: "ts-running", waiting: "ts-running", done: "ts-done", failed: "ts-failed", cancelled: "ts-todo" };
export const TICKET_FINAL = { done: 1, failed: 1, cancelled: 1 };

const EXT_KIND = {
  js: "js", mjs: "js", cjs: "js", jsx: "js",
  ts: "ts", tsx: "ts",
  json: "json", md: "md", markdown: "md",
  css: "style", scss: "style", less: "style", html: "style", htm: "style",
  py: "py", pyw: "py", sh: "shell", bat: "shell", cmd: "shell", ps1: "shell",
  yml: "yaml", yaml: "yaml", toml: "yaml", ini: "yaml", cfg: "yaml",
  png: "img", jpg: "img", jpeg: "img", gif: "img", svg: "img", webp: "img", ico: "img",
  zip: "bin", gz: "bin", tar: "bin", exe: "bin", dll: "bin", bin: "bin", lock: "bin",
  c: "c", h: "c", cpp: "c", hpp: "c", java: "jvm", go: "go", rs: "rs", rb: "rb",
};
export function extKind(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && EXT_KIND[m[1]]) || "txt";
}

export const panels = reactive({
  /* 文件树 */
  tree: [],
  wsRoot: "",
  treeLoaded: false,
  treeErr: null,
  treeFilter: "",
  /* 目标看板 */
  goals: [],
  goalLoaded: false,
  /* 审查 */
  review: null,
  verify: null,
  evolve: null,
  reviewLoaded: false,
  /* 工单 */
  tickets: [],
  ticketStats: null,
  ticketTotal: 0,
  ticketStatus: "",
  ticketsLoaded: false,
  ticketsDisabled: false,
  ticketHeadExtra: "",
});

export async function loadTree() {
  try {
    const j = await workspaceTreeApi(3, rail.wsSub || "");
    panels.treeLoaded = true;
    panels.treeErr = null;
    const root = (j && j.root) || panels.wsRoot || "";
    panels.wsRoot = root;
    const t = j && j.tree;
    // 后端返回的 tree 是【根节点对象】{name,path,type,children} —— 不是数组
    panels.tree = Array.isArray(t) ? t : ((t && t.children) || (j && j.items) || []);
  } catch (e) {
    if (!panels.treeLoaded) panels.treeErr = (e && e.message) || "工作区暂时读不到";
  }
}

export async function readFile(path) {
  const j = await workspaceReadApi(path);
  return (j && (j.content || j.text)) || "(空)";
}

export async function loadGoal() {
  try {
    const j = await goalBoardApi();
    panels.goals = (j && (j.goals || j.items)) || [];
    panels.goalLoaded = true;
  } catch {
    panels.goals = [];
    panels.goalLoaded = false;
  }
}

export async function loadReview() {
  try {
    const j = await reviewLatestApi();
    panels.review = j || { issues: [] };
  } catch {
    panels.review = { issues: [] };
  }
  try {
    panels.verify = await verifyRecordsApi();
  } catch { panels.verify = null; }
  try {
    panels.evolve = await evolveStatusApi();
  } catch { panels.evolve = null; }
  panels.reviewLoaded = true;
}

export async function loadTickets() {
  try {
    const url = "/api/tickets?limit=50" + (panels.ticketStatus ? "&status=" + encodeURIComponent(panels.ticketStatus) : "");
    const { get } = await import("../api/client.js");
    const j = await get(url, { quiet: true });
    panels.ticketsLoaded = true;
    if (!j || j.enabled === false) {
      panels.ticketsDisabled = true;
      panels.tickets = [];
      return;
    }
    panels.ticketsDisabled = false;
    panels.tickets = (j && j.tickets) || [];
    panels.ticketStats = (j && j.stats && j.stats.counts) || j.counts || {};
    panels.ticketTotal = (j && j.stats && j.stats.total) || panels.tickets.length;
    panels.ticketHeadExtra = "";
  } catch (e) {
    // 面板开着且已有一屏工单时, 一次 429 不该把它清空 —— 保留旧账, 只在抬头说明
    if (panels.ticketsLoaded) panels.ticketHeadExtra = " · 刷新失败, 稍后自动重试";
    else panels.ticketsErr = (e && e.message) || "任务记录暂时不可用";
  }
}

export async function loadTicketDetail(id) {
  const j = await ticketDetailApi(id);
  if (!j || !j.ok) throw new Error((j && j.error) || "读取失败");
  return j;
}

export async function ticketAct(op, id) {
  try {
    const j = await ticketOpApi(op, id);
    if (!j || !j.ok) throw new Error((j && (j.error || j.reason)) || "操作失败");
    showToast(op === "cancel" ? "已取消任务" : "已重跑任务 (结果回投原通道)");
    loadTickets();
  } catch (e) {
    showToast("任务操作失败: " + ((e && e.message) || "未知错误"), true);
  }
}

/* 工单面板 5s 兜底轮询: 只在抽屉打开且停在工单页时跑; /events 事件到达时也会触发 */
let _tkTimer = null;
export function scheduleTicketPoll(isActive) {
  if (_tkTimer) { clearTimeout(_tkTimer); _tkTimer = null; }
  if (!isActive || document.hidden) return;
  _tkTimer = setTimeout(() => {
    _tkTimer = null;
    if (!isActive || document.hidden) return;
    loadTickets();
    scheduleTicketPoll(isActive);
  }, 5000);
}
export function stopTicketPoll() {
  if (_tkTimer) { clearTimeout(_tkTimer); _tkTimer = null; }
}
