// src/llm/presets.js - 主流模型厂商预设库 (2026-10-01, 对标主流 Agent 的开箱体验)
// 设计目标: 用户只需要选择厂商 + 输入 API Key 即可完成模型配置, base_url/环境变量名/常用模型零记忆负担。
// 全部走 OpenAI 兼容协议 (chat/completions), 与 LLMClient 直连底座一致 — 零依赖, 无 SDK。
//
// 用法:
//   listPresets()                      -> 全部预设 (供向导/文档/接口枚举)
//   getPreset(id)                      -> 单个预设
//   buildProvider(id, {apiKey, model}) -> 生成与 config.ppj.providers 完全一致的 provider 对象
//   applyProviderToConfig(rawConfig, provider) -> 合并到配置文件原始 JSON (providers 首位, 幂等)
//
// 分类: cloud = 需 API Key; local = 本地推理 (免 Key, 自动探活)

export const PROVIDER_PRESETS = [
  // ---- 云端: 国内 ----
  { id: "deepseek", label: "DeepSeek 深度求索", cloud: true, region: "cn",
    base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"], context_window: 65536,
    key_url: "https://platform.deepseek.com/api_keys" },
  { id: "zhipu", label: "智谱 GLM", cloud: true, region: "cn",
    base_url: "https://open.bigmodel.cn/api/paas/v4", api_key_env: "ZHIPU_API_KEY",
    models: ["glm-4.7", "glm-4.7-flash", "glm-4.5-air"], context_window: 131072,
    key_url: "https://open.bigmodel.cn/usercenter/apikeys" },
  { id: "dashscope", label: "阿里通义千问 DashScope", cloud: true, region: "cn",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key_env: "DASHSCOPE_API_KEY",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"], context_window: 131072,
    key_url: "https://bailian.console.aliyun.com/?apiKey=1" },
  { id: "moonshot", label: "月之暗面 Kimi", cloud: true, region: "cn",
    base_url: "https://api.moonshot.cn/v1", api_key_env: "MOONSHOT_API_KEY",
    models: ["kimi-k2-0711-preview", "moonshot-v1-128k"], context_window: 131072,
    key_url: "https://platform.moonshot.cn/console/api-keys" },
  { id: "volcengine", label: "火山方舟 豆包", cloud: true, region: "cn",
    base_url: "https://ark.cn-beijing.volces.com/api/v3", api_key_env: "VOLCENGINE_API_KEY",
    models: [], model_hint: "填接入点 ID (ep-xxx) 或模型名", context_window: 131072,
    key_url: "https://console.volcengine.com/ark" },
  // ---- 云端: 海外 ----
  { id: "openai", label: "OpenAI", cloud: true, region: "global",
    base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"], context_window: 128000,
    key_url: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic Claude (OpenAI 兼容层)", cloud: true, region: "global",
    base_url: "https://api.anthropic.com/v1/", api_key_env: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-4-5", "claude-opus-4-1"], context_window: 200000, beta: true,
    key_url: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", label: "Google Gemini (OpenAI 兼容层)", cloud: true, region: "global",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai/", api_key_env: "GEMINI_API_KEY",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"], context_window: 1048576,
    key_url: "https://aistudio.google.com/app/apikey" },
  { id: "openrouter", label: "OpenRouter (聚合 400+ 模型)", cloud: true, region: "global",
    base_url: "https://openrouter.ai/api/v1", api_key_env: "OPENROUTER_API_KEY",
    models: [], model_hint: "填 vendor/model, 如 anthropic/claude-sonnet-4.5", context_window: 128000,
    key_url: "https://openrouter.ai/settings/keys" },
  { id: "groq", label: "Groq (极速推理)", cloud: true, region: "global",
    base_url: "https://api.groq.com/openai/v1", api_key_env: "GROQ_API_KEY",
    models: ["llama-3.3-70b-versatile"], context_window: 131072,
    key_url: "https://console.groq.com/keys" },
  { id: "siliconflow", label: "硅基流动 SiliconFlow", cloud: true, region: "cn",
    base_url: "https://api.siliconflow.cn/v1", api_key_env: "SILICONFLOW_API_KEY",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-32B"], context_window: 65536,
    key_url: "https://cloud.siliconflow.cn/account/ak" },
  // ---- 本地: 免 Key ----
  { id: "lmstudio", label: "LM Studio (本地)", cloud: false, region: "local",
    base_url: "http://127.0.0.1:1234/v1", api_key_env: null,
    models: [], model_hint: "填 LM Studio 里已加载的模型名", context_window: 8192,
    key_url: null },
  { id: "ollama", label: "Ollama (本地)", cloud: false, region: "local",
    base_url: "http://127.0.0.1:11434/v1", api_key_env: null,
    models: [], model_hint: "填已 pull 的模型名, 如 qwen3:8b", context_window: 8192,
    key_url: null },
];

export function listPresets() {
  return PROVIDER_PRESETS;
}

export function getPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === String(id || "").toLowerCase()) || null;
}

// 由预设生成 provider 配置对象 (与 config/ppx.json providers[] 字段完全一致)
// apiKey 缺失时落到环境变量名 (LLMClient 运行时兜底读取)
export function buildProvider(id, { apiKey = "", model = "" } = {}) {
  const preset = getPreset(id);
  if (!preset) return null;
  const chosen = String(model || "").trim() || preset.models[0] || "";
  const provider = {
    id: preset.id,
    backend: "http",
    base_url: preset.base_url,
    model: chosen,
    context_window: preset.context_window,
  };
  if (preset.api_key_env) {
    provider.api_key_env = preset.api_key_env;
    if (apiKey) provider.api_key = apiKey;
  } else {
    // 2026-10-03 修复 (P1): 本地预设 (api_key_env: null) 原先不写任何 key 字段,
    // 而 LLMClient._request 对空 apiKey 直接 throw → 向导配出来的 provider 必挂。
    // 注入占位 key (LM Studio / Ollama 不校验), 与 ppx.json.example 手工模板行为对齐。
    provider.api_key = apiKey || "local";
  }
  return provider;
}

// 把 provider 合并进配置原始 JSON (文件内容): 同 id 幂等覆盖, 否则插到首位 (首位 = 默认 provider)
export function applyProviderToConfig(rawConfig, provider) {
  const out = rawConfig && typeof rawConfig === "object" ? { ...rawConfig } : {};
  const list = Array.isArray(out.providers) ? out.providers.filter(Boolean) : [];
  const idx = list.findIndex((p) => p && p.id === provider.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...provider };
  else list.unshift(provider);
  out.providers = list;
  return out;
}
