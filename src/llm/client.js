// src/llm/client.js - LLM 客户端 (自研底座: 仅 OpenAI 兼容 HTTP 直连)
// 后端模式: backend="http" (默认唯一后端, 零依赖, 用 fetch)
//   - 直连任意 OpenAI 兼容 API: OpenAI/DeepSeek/火山/通义/智谱/本地 (lmstudio/ollama/vLLM)
//   - 原生 tool_calls + 文本工具调用修复 (围栏/DSML 解析, 自研)
//   - SSE 流式 / 瞬态错误重试 / provider 健康探测
// 历史: v2.4.0 前支持 openclaw/dsh 外部引擎底座, v2.5.0 起全部移除, 只保留自研 http 底座。
import { parseToolCalls } from "./fence.js";
import { withRetry } from "./retry.js";
import { warn } from "../utils/logger.js";

export class LLMClient {
  constructor(provider) {
    this.providerId = provider.id || "http";
    // 唯一后端: http (OpenAI 兼容 API 直连)
    this.backend = "http";
    this.baseUrl = (provider.base_url || "").replace(/\/$/, "");
    this.apiKey = provider.api_key || process.env[provider.api_key_env] || "";
    this.apiKeyEnvName = provider.api_key_env || ""; // 供缺失 key 报错时提示应设置的环境变量名
    this.model = provider.model || provider.models?.chat || "gpt-4o-mini";
    this.vision = !!provider.vision; // 是否支持多模态 (视觉) — 标记后才会注入图片到 user 消息
    // 上下文窗口 (token): 供 agent 据此收紧会话历史预算, 防止本地小模型溢出。
    // 可选字段, provider 未配置时用保守默认 8192 (绝不因未知窗口放大历史)。
    this.context_window = Number(provider.context_window) || Number(provider.models?.context_window) || 8192;
    this.timeoutMs = provider.timeout_ms || 120000;
    this.retryMax = provider.retry_max ?? 3; // 单次调用内瞬态错误重试次数 (429/5xx/timeout)
  }

  // 原生 chat (无工具)
  // timeoutMs/retryMax: 可选覆盖 provider 默认 (辅助调用传短超时+禁重试快速失败, 见 AUX_TIMEOUT_MS)
  async chat(messages, { temperature = 0.7, maxTokens = 2048, timeoutMs, retryMax } = {}) {
    const data = await this._request("/chat/completions", { model: this.model, messages, temperature, max_tokens: maxTokens }, { timeoutMs, retryMax });
    const m1 = data?.choices?.[0]?.message;
    let content = m1?.content;
    // 本地推理模型兜底: thinking 吃满 token 时 content 为空, 用 reasoning_content 降级, 避免误判"断线/失败"并写入污染记忆
    if (!content && m1?.reasoning_content) content = "[思考] " + m1.reasoning_content;
    if (!content) throw new Error("LLM 返回空内容");
    return { content, usage: data?.usage };
  }

  // API chat (支持工具调用), 返回完整 message (含 tool_calls)
  async apiChat(messages, { tools = [], temperature = 0.7, maxTokens = 4096, toolRunner = null, timeoutMs, retryMax } = {}) {
    const body = { model: this.model, messages, temperature, max_tokens: maxTokens };
    if (tools.length) body.tools = tools;
    const data = await this._request("/chat/completions", body, { timeoutMs, retryMax });
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error("LLM 返回空 message");
    let toolCalls = message.tool_calls || null;
    let content = message.content || null;
    // 本地推理模型兜底: 无正文且无工具调用时, 用 reasoning_content 降级(避免误判断线/失败并写入污染记忆)
    if (!content && !toolCalls?.length && message.reasoning_content) {
      content = "[思考] " + message.reasoning_content;
      toolCalls = null;
    }
    // 纯文本工具调用修复 (自研围栏 ⟪tool⟫ / DSML 解析):
    // 部分模型(本地/DSML)返回文本工具意图而非原生 tool_calls, 从文本恢复
    if (tools.length && (!toolCalls || !toolCalls.length) && typeof content === "string" && content) {
      const parsed = parseToolCalls(content);
      if (parsed.calls.length) {
        toolCalls = parsed.calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.function.name, arguments: c.function.arguments },
        }));
        content = parsed.clean || null;
      }
    }
    return {
      message: {
        role: message.role || "assistant",
        content,
        tool_calls: toolCalls,
      },
      usage: data?.usage,
    };
  }

  // 辅助 LLM 调用短超时 (毫秒): 压缩/提炼/扩展/经验 等非主对话调用, 快速失败降级, 避免 120s 卡死
  // 使用场景: 模型未运行/网络不通时, 主对话靠 localIntent 或回退, 辅助调用不应阻塞主流程
  static get AUX_TIMEOUT_MS() { return 10000; }

  async _request(path, jsonBody, { timeoutMs, retryMax } = {}) {
    if (!this.apiKey) throw new Error(`[皮皮虾] LLM 缺少 API key (env=${this.apiKeyEnvName || "?"})`);
    const url = `${this.baseUrl}${path}`;
    const ms = timeoutMs || this.timeoutMs;
    // 辅助调用 (压缩/提炼/扩展等) 传 retryMax:0 禁重试: 短超时 + 不重试 = 快速失败降级, 不阻塞主流程
    const maxRetries = retryMax === undefined ? this.retryMax : retryMax;
    const doFetch = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
          body: JSON.stringify(jsonBody),
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          const e = new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
          e.status = resp.status; // 结构化状态码, 供 retry.isTransientError 分类
          throw e;
        }
        return await resp.json();
      } finally {
        clearTimeout(timer);
      }
    };
    // 瞬态错误(429/5xx/timeout)单次调用内重试, 非瞬态(400/401/403)立即抛给上层 provider 回退
    return withRetry(doFetch, { maxRetries });
  }

  // 自研 http 底座: 支持逐字流式 (SSE)
  get supportsStream() { return true; }

  // 自研 http 底座: 支持原生 tool_calls (OpenAI 兼容 API)
  get supportsNativeToolCalls() { return true; }

  // Provider 健康探测: 快速探测 /models (3s 超时), 不发完整请求
  async health() {
    if (!this.apiKey) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(this.baseUrl + "/models", {
        headers: { "Authorization": "Bearer " + this.apiKey },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return r.ok;
    } catch (e) {
      warn("[health] " + this.providerId + " 探测失败:", e.message);
      return false;
    }
  }

  // 流式 chat: 逐块回调 (SSE), 返回累积文本
  // onDelta(content) 每次增量, onDone(full) 结束
  async streamChat(messages, { temperature = 0.7, maxTokens = 4096, onDelta, signal } = {}) {
    if (!this.apiKey) throw new Error(`[皮皮虾] LLM 缺少 API key`);
    const url = `${this.baseUrl}/chat/completions`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const extSig = signal || null;
    if (extSig) extSig.addEventListener("abort", () => ctrl.abort());
    let full = "";
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages, temperature, max_tokens: maxTokens, stream: true }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`LLM HTTP ${resp.status}: ${txt.slice(0, 300)}`);
      }
      if (!resp.body) { throw new Error("响应无 body, 不支持流式"); }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let streamDone = false; // 独立结束信号, 不污染 reader.read() 的 done
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // 按行解析 SSE
        let idx;
        while (!streamDone && (idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim().replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          // 官方结束信号: 仅匹配空格式的 "data: [DONE]", 不做 buf 全文搜防误截
          if (data === "[DONE]") { streamDone = true; break; }
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) { full += delta; onDelta && onDelta(delta); }
          } catch {}
        }
      }
      return full;
    } finally {
      clearTimeout(timer);
    }
  }
}
