// webapp/src/stores/model-preset.js - "只填模型名 + Key" 就能接线
//
// 为什么需要 (2026-11-08):
//   新手不该被 base_url / protocol / context_window 这些字段挡住。实际数据显示,
//   首次使用里 80% 的情况就是 DeepSeek / OpenAI / 通义 / 智谱 / Kimi 这几家,
//   模型名的前缀已经能唯一确定接口地址。认不出来的名字才要求用户手填地址。
//
// 口径: 这里只做「猜」, 不做「验证」。真的能不能用由 providerTestApi 的探测结果决定,
//   猜错了必须如实告诉用户, 不能假装成功。

import { providerAddApi, providerTestApi, providerReorderApi, providersApi } from "../api/endpoints.js";

// 前缀 → 接口。顺序有意义: 更具体的前缀放前面。
const RULES = [
  { key: "deepseek", re: /^deepseek/i, name: "DeepSeek", base_url: "https://api.deepseek.com/v1", protocol: "openai-completions" },
  { key: "anthropic", re: /^claude/i, name: "Anthropic", base_url: "https://api.anthropic.com/v1", protocol: "anthropic-messages" },
  { key: "zhipu", re: /^(glm|chatglm)/i, name: "智谱", base_url: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai-completions" },
  { key: "dashscope", re: /^(qwen|qwq|qwen2|qwen3)/i, name: "通义千问", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "openai-completions" },
  { key: "moonshot", re: /^(moonshot|kimi)/i, name: "月之暗面", base_url: "https://api.moonshot.cn/v1", protocol: "openai-completions" },
  { key: "volces", re: /^(doubao|ep-)/i, name: "火山方舟", base_url: "https://ark.cn-beijing.volces.com/api/v3", protocol: "openai-completions" },
  { key: "lingyi", re: /^(yi-|yi$)/i, name: "零一万物", base_url: "https://api.lingyiwanwu.com/v1", protocol: "openai-completions" },
  { key: "openai", re: /^(gpt|o1|o3|o4|chatgpt|text-embedding)/i, name: "OpenAI", base_url: "https://api.openai.com/v1", protocol: "openai-completions" },
];

/** 按模型名猜厂商; 认不出来返回 null (调用方要求用户手填接口地址) */
export function guessPreset(model) {
  const m = String(model || "").trim();
  if (!m) return null;
  return RULES.find((r) => r.re.test(m)) || null;
}

function uniqId(base, exists) {
  if (!exists.includes(base)) return base;
  for (let i = 2; i < 100; i++) {
    const id = base + "-" + i;
    if (!exists.includes(id)) return id;
  }
  return base + "-" + Date.now().toString(36);
}

/**
 * 用「模型名 + Key」接一条 provider。
 * @returns {Promise<{ok:boolean, id?:string, healthy?:boolean, detail?:string, error?:string}>}
 *   不抛异常: 调用方 (引导页) 需要把失败原因原样展示给用户。
 */
export async function attachByModelName({ model, apiKey, baseUrl }) {
  const name = String(model || "").trim();
  const key = String(apiKey || "").trim();
  if (!name) return { ok: false, error: "先填模型名称" };

  const preset = guessPreset(name);
  const endpoint = String(baseUrl || "").trim() || (preset && preset.base_url) || "";
  if (!endpoint) {
    return { ok: false, error: "认不出这个模型属于哪家，请展开「接口地址」填一下" };
  }
  // 本地地址通常不需要 key, 其余必须给
  const isLocal = /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(endpoint);
  if (!key && !isLocal) return { ok: false, error: "还差一个 API Key" };

  let exists = [];
  try {
    const j = await providersApi();
    exists = ((j && j.providers) || []).map((p) => p.id);
    // 同名同模型的配置已经在了: 直接判定为已就绪, 不重复写
    const dup = ((j && j.providers) || []).find((p) => p.model === name && String(p.base_url || "").replace(/\/$/, "") === endpoint.replace(/\/$/, ""));
    if (dup) return { ok: true, id: dup.id, healthy: null, detail: "已存在同样的配置" };
  } catch { /* 列表读不到就按新增走 */ }

  const id = uniqId((preset && preset.key) || "custom", exists);
  const payload = {
    id,
    backend: "http",
    base_url: endpoint,
    protocol: (preset && preset.protocol) || "openai-completions",
    display_name: ((preset && preset.name) || "自定义") + " · " + name,
    model: name,
    models: [{ id: name, label: name, inputs: ["text"] }],
    enabled: true,
    api_key: key || "local-no-key",
  };

  try {
    await providerAddApi(payload);
    await providerReorderApi({ order: [id].concat(exists.filter((x) => x !== id)) }).catch(() => null);
    // 探测失败不算"没保存": 配置已经写盘了, 只是连不通 —— 两种结果都要如实回报
    const t = await providerTestApi(id).catch((e) => ({ healthy: false, detail: (e && e.message) || "探测请求失败" }));
    return {
      ok: true,
      id,
      healthy: !!(t && t.healthy),
      detail: (t && (t.detail || (t.healthy ? "连通" : "已保存，但没连通"))) || "已保存",
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "保存失败" };
  }
}
