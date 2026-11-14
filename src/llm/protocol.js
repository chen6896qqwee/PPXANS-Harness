// src/llm/protocol.js - 线上协议适配层 (v4.2, 2026-11-01, 雷仔对齐)
//
// 设计 (单一事实源):
//   对上收敛 —— 内部规范 = OpenAI Chat Completions wire 格式 (messages / tools / tool_calls),
//               agent / policy / tools 全链路只认识这一种形态;
//   对下适配 —— 三种线上协议, 各自实现「请求构建 + 响应解析 + SSE 流累积 + 模型列表」四件事:
//     openai-completions : /chat/completions (历史唯一底座, 直通)
//     openai-responses   : /responses (扁平 function 工具 + instructions 承载 system)
//     anthropic-messages : /v1/messages (system 分离 + content blocks + tool_use/tool_result)
//
//   设计溯源 docs/PROVENANCE.md#leizai providers.js 的能力位思想: 差异全部收敛在适配器内, LLMClient 只按
//   provider.protocol 选适配器, 不出现任何 if (vendor) 分叉。零依赖, 纯 fetch。
//
// 本文件只做注册与模型目录: 适配器实现见 ./adapters/{completions,responses,anthropic}.js。
//
// 适配器接口:
//   endpoint()                -> 请求路径 (拼在 base_url 后)
//   headers(apiKey)           -> 请求头 (含鉴权; anthropic 用 x-api-key 而非 Bearer)
//   buildBody(params)         -> 请求体 (params: {model, messages, tools, temperature, maxTokens, stream, includeUsage, reasoning, extraBody})
//   parseResponse(data)       -> {message:{role,content,tool_calls}, usage}
//   createStreamAcc()         -> {feed(j, cb), result()} (cb: {onDelta, onReasoning})
//   modelsUrl(baseUrl)        -> 模型列表 URL (fetch-models / 健康探测)
import { openaiCompletions } from "./adapters/completions.js";
import { openaiResponses } from "./adapters/responses.js";
import { anthropicMessages, toAnthropicMessages } from "./adapters/anthropic.js";

export const PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"];
export const DEFAULT_PROTOCOL = "openai-completions";

// 既有调用方 (test/providers-protocol.test.js) 从本文件取该转换函数; 实现已下沉到适配器。
export { toAnthropicMessages };

const ADAPTERS = {
  "openai-completions": openaiCompletions,
  "openai-responses": openaiResponses,
  "anthropic-messages": anthropicMessages,
};

export function getAdapter(protocol) {
  return ADAPTERS[protocol] || openaiCompletions;
}

// SSRF 守卫 (v4.2 加固): /api/providers/fetch-models 会把用户输入的 base_url 交给服务端 GET,
//   错误路径还回显远端响应片段 —— 可被借道探测内网/云元数据。只放行 http(s) 并拦截
//   link-local 元数据段 (169.254.0.0/16 / metadata.google.internal); 环回与局域网不拦 ——
//   本地提供商 (LM Studio / Ollama 默认 127.0.0.1) 是本端点的正当用户。
export function assertSafeModelsUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`无效的 base_url: ${url}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`不支持的协议 ${u.protocol.replace(":", "")} (仅允许 http/https)`);
  }
  const host = String(u.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (/^169\.254\./.test(host) || host === "metadata.google.internal" || host.endsWith(".internal")) {
    throw new Error("base_url 指向保留/元数据地址, 已拒绝");
  }
}

// 模型目录拉取 (fetch-models 端点 / 健康探测共用): 返回 {models:[{id,label}]}
// 失败抛错 (带 .status), 由调用方 classifyHttp 归类三态。
export async function listRemoteModels({ baseUrl, protocol = DEFAULT_PROTOCOL, apiKey, timeoutMs = 8000 }) {
  const adapter = getAdapter(protocol);
  const url = adapter.modelsUrl(String(baseUrl || "").replace(/\/$/, ""));
  assertSafeModelsUrl(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: "GET", headers: adapter.headers(apiKey || ""), signal: ctrl.signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const e = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      e.status = resp.status;
      throw e;
    }
    const data = await resp.json().catch(() => null);
    return { models: adapter.parseModels(data) };
  } finally {
    clearTimeout(t);
  }
}

// 协议名合法性 (provider.protocol 校验 / UI 下拉共用)
export function isProtocol(p) { return PROTOCOLS.includes(p); }
