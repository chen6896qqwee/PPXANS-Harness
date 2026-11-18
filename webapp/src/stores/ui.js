// webapp/src/stores/ui.js - 外壳 UI 状态 (视图路由/抽屉/侧栏/弹层/确认弹窗服务)
// 确认/输入弹窗 (Promise 化) 自 public/ui.js 移植 —— 全站唯一入口, 不再每个调用点
// 抄一遍 "PPXUI 不在就退回原生 confirm" 的降级分支。

import { reactive } from "vue";
import { T } from "../i18n/lexicon.js";

// 路由表 (v5.1): 侧栏导航、能力页、快捷键提示都由这张表驱动 ——
// 以前是散落的字符串数组 + 各处手写入口, 加一个视图要改三处, 漏一处就"功能有了但找不到入口"。
// group: main = 侧栏一级导航; more = 收进「能力」页的第二层。
export const ROUTES = [
  { id: "chat", label: T.chat, icon: "bot", group: "main" },
  { id: "projects", label: T.projects, icon: "folder", group: "main" },
  { id: "tasks", label: T.tasks, icon: "list", group: "main" },
  { id: "caps", label: T.capabilities, icon: "spark", group: "main" },
  { id: "settings", label: T.assistantSettings, icon: "settings", group: "more" },
  { id: "body", label: T.runState, icon: "pulse", group: "more" },
  { id: "skills", label: "技能", icon: "book", group: "more" },
  { id: "plugins", label: "插件", icon: "plug", group: "more" },
  { id: "mcp", label: "MCP 服务器", icon: "cube", group: "more" },
  { id: "stats", label: "使用统计", icon: "bars", group: "more" },
];

const VIEWS = ROUTES.map((r) => r.id);
export const MAIN_ROUTES = ROUTES.filter((r) => r.group === "main");
export const MORE_ROUTES = ROUTES.filter((r) => r.group === "more");

export const ui = reactive({
  view: "chat",
  chatPane: "talk",      // 对话页双页签: talk | trace
  drawer: false,
  drawerTab: "files",
  sideCollapsed: false,
  fileView: null,        // { path, text } 文件预览
  dirModal: null,        // { mode: "space"|"dir", rel } | null
  settingsModal: null,   // "general" | "models" | "appearance" | null
  onboarding: false,     // onboarding replay
  readyBanner: true,     // 首屏「还没接模型」提示条 (readiness 判定后可能自动收起)
});

export function showView(v) {
  if (v === "home") v = "chat"; // 2026-11-03: 本体首页并入对话空态
  if (!VIEWS.includes(v)) v = "chat";
  ui.view = v;
  try { localStorage.setItem("ppx_view", v); } catch { /* 隐私模式忽略 */ }
}

export function setDrawer(on) {
  ui.drawer = !!on;
  try { localStorage.setItem("ppx_drawer", on ? "1" : "0"); } catch { /* 忽略 */ }
  if (on && ui.view !== "chat") showView("chat");
}
export function setDrawerTab(tab) {
  ui.drawerTab = tab;
  if (!ui.drawer) setDrawer(true);
}
export function setSide(collapsed) {
  ui.sideCollapsed = !!collapsed;
  try { localStorage.setItem("ppx_side", collapsed ? "1" : "0"); } catch { /* 忽略 */ }
}
export function openFileView(path, text) {
  ui.fileView = { path, text };
}
export function closeFileView() {
  ui.fileView = null;
}

/* ---------- 确认 / 输入弹窗 (Promise 服务) ---------- */
export const ask = reactive({
  open: false,
  kind: "confirm",        // confirm | prompt
  title: "确认",
  message: "",
  value: "",
  placeholder: "",
  okText: "确定",
  cancelText: "取消",
  danger: false,
  _resolve: null,
});

export function confirmAsk(message, opts = {}) {
  if (ask.open && ask._resolve) { ask._resolve(false); }
  ask.open = true;
  ask.kind = "confirm";
  ask.title = opts.title || "确认";
  ask.message = String(message == null ? "" : message);
  ask.value = "";
  ask.placeholder = "";
  ask.okText = opts.okText || "确定";
  ask.cancelText = opts.cancelText || "取消";
  ask.danger = !!opts.danger;
  return new Promise((resolve) => { ask._resolve = resolve; });
}

export function promptAsk(message, opts = {}) {
  if (ask.open && ask._resolve) { ask._resolve(null); }
  ask.open = true;
  ask.kind = "prompt";
  ask.title = opts.title || "输入";
  ask.message = String(message == null ? "" : message);
  ask.value = opts.value == null ? "" : String(opts.value);
  ask.placeholder = opts.placeholder || "";
  ask.okText = opts.okText || "确定";
  ask.cancelText = opts.cancelText || "取消";
  ask.danger = false;
  return new Promise((resolve) => { ask._resolve = resolve; });
}

export function settleAsk(value) {
  const r = ask._resolve;
  ask.open = false;
  ask._resolve = null;
  if (r) r(value);
}
