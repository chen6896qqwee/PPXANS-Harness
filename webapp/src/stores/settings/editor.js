// webapp/src/stores/settings/editor.js - 二级编辑器: 打开 / 目录拉取 / 保存
// 2026-11-13 从 stores/settings.js 拆出 (桶文件重新导出, 调用方不变)。

import { showToast } from "../toast.js";
import { providerAddApi, providerPatchApi, providerFetchModelsApi } from "../../api/endpoints.js";
import { settings, presetOf, ID_RE } from "./state.js";
import { loadModelPanel } from "./providers.js";

/* ---------- 编辑弹窗 ---------- */
// 入参兼容: 字符串/半结构化 → 结构化 (与后端 normalizeModels 同规则的前端影子)
export function normalizeCatalogIn(catalog) {
  const out = [];
  const seen = {};
  (catalog || []).forEach((raw) => {
    const m = typeof raw === "string" ? { id: raw } : raw;
    if (!m || !m.id) return;
    if (seen[m.id]) return;
    seen[m.id] = true;
    const inputs = Array.isArray(m.inputs) ? m.inputs.slice() : ["text"];
    if ((m.image === true || m.vision === true) && inputs.indexOf("image") < 0) inputs.push("image");
    out.push({
      id: String(m.id),
      label: typeof m.label === "string" ? m.label : "",
      context_window: Number(m.context_window) > 0 ? Number(m.context_window) : null,
      max_output: Number(m.max_output) > 0 ? Number(m.max_output) : null,
      inputs,
    });
  });
  return out;
}

export function openEditor(p) {
  const presetMatch = p ? presetOf(p.id) : null;
  settings.editor = {
    editingId: p ? p.id : null,
    clearKey: false,
    catDirty: false,
    presetBaseTouched: false,
    tab: (!p || presetMatch) ? "preset" : "custom",
    presetId: presetMatch ? presetMatch.id : (settings.presets.length ? settings.presets[0].id : ""),
    id: p ? p.id : (presetMatch ? presetMatch.id : (settings.presets.length ? settings.presets[0].id : "")),
    displayName: p ? (p.display_name || "") : "",
    baseP: p ? (p.base_url || "") : (settings.presets.length ? (settings.presets[0].base_url || "") : ""),
    base: p ? (p.base_url || "") : "",
    protocol: p ? (p.protocol || "openai-completions") : "openai-completions",
    key: "",
    keyC: "",
    timeout: p && p.timeout_ms ? String(p.timeout_ms) : "",
    catalog: normalizeCatalogIn(p ? p.models : ((presetMatch || settings.presets[0] || {}).models || [])),
    msg: "",
    msgKind: "",
    catHint: p ? "目录外 ID 仍可直接发送; 保存后按目录展示能力标注。" : "正在使用内置目录模型；目录外 ID 仍可直接发送。",
  };
}

export function closeEditor() {
  settings.editor = null;
}

function catalogPayload(catalog) {
  const rows = [];
  const seen = {};
  for (const m of catalog) {
    if (!m.id) continue;
    if (seen[m.id]) continue;
    seen[m.id] = true;
    rows.push({
      id: m.id,
      label: m.label || "",
      context_window: m.context_window || null,
      max_output: m.max_output || null,
      inputs: (m.inputs && m.inputs.length) ? m.inputs : ["text"],
    });
  }
  return rows;
}

export async function fetchModels() {
  const ed = settings.editor;
  if (!ed) return;
  const base = (ed.tab === "preset" ? ed.baseP : ed.base).trim();
  const protocol = ed.tab === "preset" ? (presetOf(ed.presetId)?.protocol || "openai-completions") : ed.protocol;
  const key = (ed.tab === "preset" ? ed.key : ed.keyC).trim();
  if (!base && !ed.editingId) { ed.msg = "请先填写 API 地址再拉取模型目录"; ed.msgKind = "bad"; return; }
  const payload = { base_url: base, protocol };
  if (key) payload.api_key = key;
  if (ed.editingId) payload.id = ed.editingId;
  ed.fetching = true;
  try {
    const j = await providerFetchModelsApi(payload);
    if (j && j.ok) {
      const remote = j.models || [];
      const existing = {};
      ed.catalog.forEach((m) => { if (m.id) existing[m.id] = m; });
      const merged = [];
      remote.forEach((rm) => {
        if (existing[rm.id]) {
          // 已有目录项: 只补空字段, 不覆盖用户手填/手标的窗口与能力
          const e = existing[rm.id];
          if (!e.context_window && rm.context_window) e.context_window = rm.context_window;
          if (!e.max_output && rm.max_output) e.max_output = rm.max_output;
          if (rm.inputs && rm.inputs.indexOf("image") >= 0 && (!e.inputs || e.inputs.indexOf("image") < 0)) {
            e.inputs = ["text", "image"];
          }
          merged.push(e);
          delete existing[rm.id];
        } else {
          merged.push({
            id: rm.id, label: rm.label || "",
            context_window: rm.context_window || null,
            max_output: rm.max_output || null,
            inputs: (rm.inputs && rm.inputs.length) ? rm.inputs : ["text"],
          });
        }
      });
      for (const k of Object.keys(existing)) merged.push(existing[k]);
      ed.catalog = merged;
      ed.catDirty = false;
      ed.catHint = "已拉取 " + remote.length + " 个可用模型 (本地服务会带回窗口与输出上限, 已填的字段不覆盖)";
      ed.msg = "";
    } else {
      const c = (j && j.classified) || {};
      ed.msg = "拉取失败: " + ((j && j.error) || "未知错误") + (c.userHint ? " — " + c.userHint : "");
      ed.msgKind = "bad";
    }
  } catch (e) {
    ed.msg = "拉取失败: " + e.message;
    ed.msgKind = "bad";
  } finally {
    ed.fetching = false;
  }
}

export async function saveEditor() {
  const ed = settings.editor;
  if (!ed) return;
  const isEdit = ed.editingId != null;
  let id, base, protocol, displayName, key, keyEnv = null;
  if (ed.tab === "preset") {
    const preset = presetOf(ed.presetId);
    id = isEdit ? ed.editingId : String(ed.id || "").trim();
    base = String(ed.baseP || "").trim();
    protocol = (preset && preset.protocol) || "openai-completions";
    displayName = (preset && preset.label) || String(ed.displayName || "").trim();
    key = String(ed.key || "").trim();
    keyEnv = preset && preset.api_key_env ? preset.api_key_env : null;
    if (!id) { ed.msg = "缺少提供商 id"; ed.msgKind = "bad"; return; }
    if (!base) { ed.msg = "请填写接口地址 base_url"; ed.msgKind = "bad"; return; }
  } else {
    id = String(ed.id || "").trim();
    base = String(ed.base || "").trim();
    protocol = ed.protocol;
    displayName = String(ed.displayName || "").trim();
    key = String(ed.keyC || "").trim();
    if (!id) { ed.msg = "请填写 Provider ID"; ed.msgKind = "bad"; return; }
    if (!ID_RE.test(id)) { ed.msg = "Provider ID 需以字母开头, 仅含字母/数字/横线/下线 (2-30 字符)"; ed.msgKind = "bad"; return; }
    if (!base) { ed.msg = "请填写 API 地址"; ed.msgKind = "bad"; return; }
  }
  const catalog = catalogPayload(ed.catalog);
  const payload = {
    id,
    backend: "http",
    base_url: base,
    protocol,
    display_name: displayName || id,
    model: catalog.length ? catalog[0].id : (isEdit ? undefined : ""),
    models: catalog.length ? catalog : undefined,
    enabled: true,
  };
  if (isEdit && ed.editingId === id && !catalog.length) {
    delete payload.model;
    delete payload.models;
  }
  const ctx = catalog.length && catalog[0].context_window ? catalog[0].context_window : null;
  if (ctx) payload.context_window = ctx;
  const to = Number(ed.timeout);
  if (to) payload.timeout_ms = to;
  if (key) payload.api_key = key;
  else if (isEdit && ed.clearKey) payload.api_key = "";
  else if (!isEdit && keyEnv) payload.api_key_env = keyEnv;
  else if (!isEdit && ed.tab === "preset" && presetOf(ed.presetId) && presetOf(ed.presetId).cloud === false) {
    payload.api_key = "local-no-key";
  }
  ed.saving = true;
  try {
    if (isEdit) await providerPatchApi(ed.editingId, payload);
    else await providerAddApi(payload);
    showToast((isEdit ? "已保存 " : "已新增 ") + id);
    closeEditor();
    loadModelPanel();
  } catch (e) {
    ed.msg = e.message;
    ed.msgKind = "bad";
  } finally {
    ed.saving = false;
  }
}
