// webapp/src/stores/settings/providers.js - 提供商列表: 拉取 / 测试 / 默认排序 / 启停 / 删除
// 2026-11-13 从 stores/settings.js 拆出 (桶文件重新导出, 调用方不变)。

import { showToast } from "../toast.js";
import {
  providersApi, providersPresetsApi, providersUsageApi,
  providerPatchApi, providerDeleteApi, providerTestApi, providerReorderApi, routingApi,
} from "../../api/endpoints.js";
import { settings } from "./state.js";

export async function loadModelPanel() {
  const results = await Promise.all([
    providersApi().catch(() => null),
    settings.presets.length ? Promise.resolve({ presets: settings.presets, protocols: settings.protocols }) : providersPresetsApi().catch(() => null),
    routingApi().catch(() => null),
    providersUsageApi().catch(() => null),
  ]);
  const j = results[0];
  if (!j) {
    settings.providers = [];
    settings.loadError = "模型服务不可用 · 请确认内核已启动且 REST /api/* 可访问";
    return;
  }
  settings.loadError = null;
  if (results[1] && results[1].presets) {
    settings.presets = results[1].presets || [];
    settings.protocols = results[1].protocols || {};
  }
  settings.providers = j.providers || [];
  if (results[2]) settings.routing = results[2].routing || null;
  settings.usageBy = {};
  ((results[3] && results[3].usage) || []).forEach((u) => { settings.usageBy[u.id] = u; });
  settings.loaded = true;
  // 模型变更 → 对话域徽标刷新 (旧实现走 DOM 事件)
  const { chat } = await import("../chat.js");
  chat.providers = settings.providers;
  chat.providersLoaded = true;
}

export async function testProvider(p) {
  try {
    const j = await providerTestApi(p.id);
    return { ok: !!(j && j.healthy), text: (j && j.healthy ? "✓ " : "✗ ") + ((j && j.detail) || "") };
  } catch (e) {
    return { ok: false, text: "✗ " + e.message };
  }
}

export async function setDefault(id) {
  const order = settings.providers.map((p) => p.id).filter((x) => x !== id);
  order.unshift(id);
  try {
    await providerReorderApi({ order });
    showToast("已设为默认模型");
    loadModelPanel();
  } catch (e) {
    showToast((e && e.message) || "操作失败", true);
  }
}

export async function toggleProvider(id, enabled) {
  try {
    await providerPatchApi(id, { enabled });
    showToast(enabled ? "已启用 " + id : "已停用 " + id + " (配置保留)");
    loadModelPanel();
  } catch (e) {
    showToast((e && e.message) || "操作失败", true);
  }
}

export async function removeProvider(p) {
  const { confirmAsk } = await import("../ui.js");
  const ok = await confirmAsk("配置文件会先留一份 .bak 备份, 之后可重新添加。", {
    title: "删除模型服务「" + p.id + "」?", okText: "删除", danger: true,
  });
  if (!ok) return;
  try {
    await providerDeleteApi(p.id);
    showToast("已删除 " + p.id);
    loadModelPanel();
  } catch (e) {
    showToast((e && e.message) || "删除失败", true);
  }
}
