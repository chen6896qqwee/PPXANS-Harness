// webapp/src/stores/settings/state.js - 设置弹窗的共享状态与纯查询
// 2026-11-13: 从 stores/settings.js (410 行) 拆出, 原文件改为 export * 桶文件,
//   组件与 composable 的 import 路径不变。本模块不发起请求。

import { reactive } from "vue";

export const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/;

export const settings = reactive({
  panel: "models",         // general | models
  providers: [],
  presets: [],
  protocols: {},
  usageBy: {},
  loaded: false,
  routing: null,
  /* 编辑弹窗态 */
  editor: null,            // 见 openEditor
  /* 一键接入本地模型 */
  quick: { open: false, loading: false, servers: [], needsKey: false, key: "", error: "", sel: null },
});

export function presetOf(id) {
  return settings.presets.find((p) => p.id === id) || null;
}
export function presetModelIds(p) {
  return (p.models || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
}
export function protoLabel(p) {
  const id = (p && p.protocol) || "openai-completions";
  return (settings.protocols && settings.protocols[id]) || id;
}
function modelLabel(m) { return (m && (m.label || m.id)) || "—"; }
export function primaryModel(p) {
  const list = Array.isArray(p.models) ? p.models : [];
  if (list.length) return modelLabel(list[0]);
  return p.model || "未指定模型";
}
