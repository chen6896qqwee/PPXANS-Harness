// webapp/src/stores/settings/quick.js - 一键接入本机模型: 扫描 / 选中 / 接入并测试
// 2026-11-13 从 stores/settings.js 拆出 (桶文件重新导出, 调用方不变)。

import { showToast } from "../toast.js";
import {
  providerAddApi, providerTestApi, providerReorderApi, providerDiscoverLocalApi,
} from "../../api/endpoints.js";
import { settings } from "./state.js";
import { loadModelPanel } from "./providers.js";

function findConfigured(s, m) {
  const base = String(s.base_url || "").replace(/\/+$/, "");
  return settings.providers.find((p) => String(p.base_url || "").replace(/\/+$/, "") === base && p.model === m.id) || null;
}

export function quickBits(s, m) {
  const bits = [];
  if (m.loaded) bits.push("已加载");
  if (m.context_window) bits.push(Math.round(m.context_window / 1024) + "K ctx");
  if (m.max_output) bits.push(m.max_output + " out");
  if (Array.isArray(m.inputs) && m.inputs.indexOf("image") >= 0) bits.push("视觉");
  if (findConfigured(s, m)) bits.push("已接入");
  return bits;
}
export function quickFindConfigured(s, m) { return findConfigured(s, m); }

export async function quickDiscover(key) {
  settings.quick.loading = true;
  if (key != null) settings.quick.key = key;
  settings.quick.error = "";
  try {
    const j = await providerDiscoverLocalApi(settings.quick.key);
    settings.quick.loading = false;
    settings.quick.servers = (j && j.servers) || [];
    settings.quick.needsKey = !!(j && j.needs_key);
    const q = settings.quick;
    if (!q.sel || !q.servers[q.sel.si] || !q.servers[q.sel.si].models[q.sel.mi]) {
      q.sel = null;
      for (let i = 0; i < q.servers.length; i++) {
        if (q.servers[i].status === "ok" && q.servers[i].models.length) { q.sel = { si: i, mi: 0 }; break; }
      }
    }
  } catch (e) {
    settings.quick.loading = false;
    settings.quick.error = e.message;
  }
}

export function quickOpen() {
  settings.quick.servers = [];
  settings.quick.sel = null;
  settings.quick.error = "";
  settings.quick.needsKey = false;
  settings.quick.key = "";
  settings.quick.open = true;
  quickDiscover("");
}

function uniqueProviderId(base) {
  const used = {};
  settings.providers.forEach((p) => { used[p.id] = true; });
  if (!used[base]) return base;
  let n = 2;
  while (used[base + "-" + n]) n += 1;
  return base + "-" + n;
}

export async function quickAttach() {
  const q = settings.quick;
  if (!q.sel) return;
  const s = q.servers[q.sel.si];
  const m = s && s.models[q.sel.mi];
  if (!s || !m) return;
  if (findConfigured(s, m)) { showToast("这个模型已经在列表里了"); return; }
  const id = uniqueProviderId("local-" + (s.kind || "model"));
  const row = {
    id: m.id, label: m.label || m.id,
    context_window: m.context_window || null,
    max_output: m.max_output || null,
    inputs: (m.inputs && m.inputs.length) ? m.inputs : ["text"],
  };
  const payload = {
    id,
    backend: "http",
    base_url: s.base_url,
    protocol: "openai-completions",
    display_name: (s.name + " · " + m.id).slice(0, 60),
    model: m.id,
    models: [row],
    enabled: true,
  };
  if (m.context_window) payload.context_window = m.context_window;
  payload.api_key = q.key || "local-no-key";
  q.attaching = true;
  try {
    await providerAddApi(payload);
    const order = [id].concat(settings.providers.map((p) => p.id).filter((x) => x !== id));
    await providerReorderApi({ order }).catch(() => null);
    const t = await providerTestApi(id).catch((e) => ({ healthy: false, detail: e.message }));
    showToast("已接入 " + m.id + (t && t.healthy ? " · 探测通过" : " · 已保存但探测未通过"), !(t && t.healthy));
    q.open = false;
    loadModelPanel();
  } catch (e) {
    showToast((e && e.message) || "接入失败", true);
  } finally {
    q.attaching = false;
  }
}
