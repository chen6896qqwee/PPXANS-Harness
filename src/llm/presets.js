// src/llm/presets.js - 主流模型厂商预设库 (2026-10-01, 对标主流 Agent 的开箱体验)
// 设计目标: 用户只需要选择厂商 + 输入 API Key 即可完成模型配置, base_url/环境变量名/常用模型零记忆负担。
// 全部走统一协议适配层 (src/llm/protocol.js), 与 LLMClient 直连底座一致 — 零依赖, 无 SDK。
//
// v4.2 (2026-11-01, 雷仔对齐): 预设升级为「协议 + 模型目录」双能力 ——
//   protocol: 该厂商的线上协议 (openai-completions 缺省 / openai-responses / anthropic-messages);
//   models:   结构化模型目录 [{id, label, context_window, max_output, inputs}] (含视觉标记),
//             取代裸字符串数组; presetModelIds() 供旧消费方拿 id 列表。
//   anthropic 预设改走原生 Messages 协议 (不再依赖 OpenAI 兼容层 beta), base_url 统一带 /v1。
//
// 用法:
//   listPresets()                      -> 全部预设 (供向导/文档/接口枚举)
//   getPreset(id)                      -> 单个预设
//   buildProvider(id, {apiKey, model}) -> 生成与 config.ppx.providers 完全一致的 provider 对象
//   applyProviderToConfig(rawConfig, provider) -> 合并到配置文件原始 JSON (providers 首位, 幂等)
//
// 分类: cloud = 需 API Key; local = 本地推理 (免 Key, 自动探活)

export const PROVIDER_PRESETS = [
  // ---- 云端: 国内 ----
  { id: "deepseek", label: "DeepSeek 深度求索", cloud: true, region: "cn", protocol: "openai-completions",
    base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat", context_window: 131072, max_output: 8192, inputs: ["text"] },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)", context_window: 131072, max_output: 65536, inputs: ["text"] },
    ],
    context_window: 131072,
    key_url: "https://platform.deepseek.com/api_keys" },
  { id: "zhipu", label: "智谱 GLM", cloud: true, region: "cn", protocol: "openai-completions",
    base_url: "https://open.bigmodel.cn/api/paas/v4", api_key_env: "ZHIPU_API_KEY",
    models: [
      { id: "glm-4.7", label: "GLM-4.7", context_window: 131072, max_output: 32768, inputs: ["text", "image"] },
      { id: "glm-4.7-flash", label: "GLM-4.7 Flash", context_window: 131072, max_output: 32768, inputs: ["text", "image"] },
      { id: "glm-4.5-air", label: "GLM-4.5 Air", context_window: 131072, max_output: 16384, inputs: ["text"] },
    ],
    context_window: 131072,
    key_url: "https://open.bigmodel.cn/usercenter/apikeys" },
  { id: "dashscope", label: "阿里通义千问 DashScope", cloud: true, region: "cn", protocol: "openai-completions",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key_env: "DASHSCOPE_API_KEY",
    models: [
      { id: "qwen-max", label: "Qwen Max", context_window: 131072, max_output: 16384, inputs: ["text"] },
      { id: "qwen-plus", label: "Qwen Plus", context_window: 131072, max_output: 16384, inputs: ["text"] },
      { id: "qwen-turbo", label: "Qwen Turbo", context_window: 131072, max_output: 8192, inputs: ["text"] },
    ],
    context_window: 131072,
    key_url: "https://bailian.console.aliyun.com/?apiKey=1" },
  { id: "moonshot", label: "月之暗面 Kimi", cloud: true, region: "cn", protocol: "openai-completions",
    base_url: "https://api.moonshot.cn/v1", api_key_env: "MOONSHOT_API_KEY",
    models: [
      { id: "kimi-k2-0711-preview", label: "Kimi K2 (preview)", context_window: 131072, max_output: 8192, inputs: ["text"] },
      { id: "moonshot-v1-128k", label: "Moonshot V1 128K", context_window: 131072, max_output: 8192, inputs: ["text"] },
    ],
    context_window: 131072,
    key_url: "https://platform.moonshot.cn/console/api-keys" },
  // ---- 云端: 海外 ----
  { id: "openai", label: "OpenAI", cloud: true, region: "global", protocol: "openai-completions",
    base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini", context_window: 128000, max_output: 16384, inputs: ["text", "image"] },
      { id: "gpt-4o", label: "GPT-4o", context_window: 128000, max_output: 16384, inputs: ["text", "image"] },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", context_window: 1047576, max_output: 32768, inputs: ["text", "image"] },
    ],
    context_window: 128000,
    key_url: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic Claude", cloud: true, region: "global", protocol: "anthropic-messages",
    base_url: "https://api.anthropic.com/v1", api_key_env: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", context_window: 200000, max_output: 64000, inputs: ["text", "image"] },
      { id: "claude-opus-4-1", label: "Claude Opus 4.1", context_window: 200000, max_output: 32000, inputs: ["text", "image"] },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", context_window: 200000, max_output: 64000, inputs: ["text", "image"] },
    ],
    context_window: 200000,
    key_url: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", label: "Google Gemini (OpenAI 兼容层)", cloud: true, region: "global", protocol: "openai-completions",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai/", api_key_env: "GEMINI_API_KEY",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", context_window: 1048576, max_output: 65536, inputs: ["text", "image"] },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", context_window: 1048576, max_output: 65536, inputs: ["text", "image"] },
    ],
    context_window: 1048576,
    key_url: "https://aistudio.google.com/app/apikey" },
  { id: "openrouter", label: "OpenRouter (聚合 400+ 模型)", cloud: true, region: "global", protocol: "openai-completions",
    base_url: "https://openrouter.ai/api/v1", api_key_env: "OPENROUTER_API_KEY",
    models: [], model_hint: "填 vendor/model, 如 anthropic/claude-sonnet-4.5", context_window: 128000,
    key_url: "https://openrouter.ai/settings/keys" },
  { id: "groq", label: "Groq (极速推理)", cloud: true, region: "global", protocol: "openai-completions",
    base_url: "https://api.groq.com/openai/v1", api_key_env: "GROQ_API_KEY",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", context_window: 131072, max_output: 32768, inputs: ["text"] },
    ],
    context_window: 131072,
    key_url: "https://console.groq.com/keys" },
  { id: "siliconflow", label: "硅基流动 SiliconFlow", cloud: true, region: "cn", protocol: "openai-completions",
    base_url: "https://api.siliconflow.cn/v1", api_key_env: "SILICONFLOW_API_KEY",
    models: [
      { id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3", context_window: 65536, max_output: 8192, inputs: ["text"] },
      { id: "Qwen/Qwen3-32B", label: "Qwen3 32B", context_window: 131072, max_output: 8192, inputs: ["text"] },
    ],
    context_window: 65536,
    key_url: "https://cloud.siliconflow.cn/account/ak" },
  // ---- 本地: 免 Key ----
  { id: "lmstudio", label: "LM Studio (本地)", cloud: false, region: "local", protocol: "openai-completions",
    base_url: "http://127.0.0.1:1234/v1", api_key_env: null,
    models: [], model_hint: "填 LM Studio 里已加载的模型名", context_window: 8192,
    key_url: null },
  { id: "ollama", label: "Ollama (本地)", cloud: false, region: "local", protocol: "openai-completions",
    base_url: "http://127.0.0.1:11434/v1", api_key_env: null,
    models: [], model_hint: "填已 pull 的模型名, 如 qwen3:8b", context_window: 8192,
    key_url: null },
];

// 协议展示名 (UI 下拉用; 与 src/llm/protocol.js 适配器一一对应)
export const PROTOCOL_LABELS = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

export function listPresets() {
  return PROVIDER_PRESETS;
}

export function getPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === String(id || "").toLowerCase()) || null;
}

// 旧消费方 (datalist/文档) 拿模型 id 字符串列表的兜底助手
export function presetModelIds(preset) {
  if (!preset) return [];
  return (preset.models || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
}

// 由预设生成 provider 配置对象 (与 config/ppx.json providers[] 字段完全一致)
// apiKey 缺失时落到环境变量名 (LLMClient 运行时兜底读取)
// 2026-10-10 修复 (P1): 本地提供商 (lmstudio/ollama) 的 api_key_env 为 null, 于是这里
//   既不写 api_key 也不写 api_key_env → LLMClient 校验时判定"无凭据"必抛。
//   本地服务实际上不需要密钥, 但 HTTP 客户端仍要求一个非空 api_key 字段,
//   故对无 key_env 的本地预设注入占位值 (不覆盖调用方显式传入的 key)。
// v4.2: 透传 protocol + 结构化模型目录 + display_name。
export function buildProvider(id, { apiKey = "", model = "" } = {}) {
  const preset = getPreset(id);
  if (!preset) return null;
  const ids = presetModelIds(preset);
  const chosen = String(model || "").trim() || ids[0] || "";
  const provider = {
    id: preset.id,
    backend: "http",
    base_url: preset.base_url,
    protocol: preset.protocol || "openai-completions",
    display_name: preset.label,
    model: chosen,
    context_window: preset.context_window,
  };
  if (preset.models?.length) provider.models = preset.models;
  if (preset.api_key_env) {
    provider.api_key_env = preset.api_key_env;
    if (apiKey) provider.api_key = apiKey;
  } else {
    // 本地/免 Key 提供商: 注入占位密钥, 让 HTTP 客户端能构造请求 (服务端忽略之)
    provider.api_key = apiKey || "local-no-key";
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

// ---- 模型名展示 (2026-11-14, BYO 体验轮) ----
// v4.2 起 models 是结构化对象数组 ({id,label,context_window,...}); 旧预设/手写配置可能是
//   字符串数组。setup 向导此前直接 join 对象 → 交互界面打印 "[object Object] / [object Object]"
//   (实测回归)。展示口径单一来源: label 优先, 无 label 用 id, 空项滤掉。
export function formatModelName(m) {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") return String(m.label || m.id || "");
  return "";
}
export function formatPresetModels(preset, sep = " / ") {
  return (preset?.models || []).map(formatModelName).filter(Boolean).join(sep);
}
