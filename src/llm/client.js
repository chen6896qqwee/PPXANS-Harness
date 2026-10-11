// src/llm/client.js - LLM 客户端 (自研底座: 仅 OpenAI 兼容 HTTP 直连)
// 后端模式: backend="http" (默认唯一后端, 零依赖, 用 fetch)
//   - 直连任意 OpenAI 兼容 API: OpenAI/DeepSeek/通义/智谱/本地 (lmstudio/ollama/vLLM)
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
    // 思考强度 (config.llm.reasoning): auto/off/low/medium/high/max
    // 由 router 注入; 未识别厂商/模型一律不注入参数 (宁可不发, 不发错——乱塞参数会 400)
    this.reasoning = String(provider.reasoning || "auto").toLowerCase();
    // 自定义注入逃生口: config.llm.reasoning_params (对象) 原样合并进请求体
    this.reasoningParams = (provider.reasoning_params && typeof provider.reasoning_params === "object")
      ? provider.reasoning_params : null;
  }

  // 思考强度 → 厂商参数映射 (按 base_url 家族 + 模型名白名单, 保守注入)
  _thinkParams() {
    if (this.reasoningParams) return { ...this.reasoningParams };
    const lvl = this.reasoning;
    const host = String(this.baseUrl || "").toLowerCase();
    const model = String(this.model || "").toLowerCase();
    if (!lvl || lvl === "auto") return {};
    const off = lvl === "off";
    const on = !off;
    // 智谱 GLM (open.bigmodel.cn): thinking.type; 仅 4.5+/z1 系支持
    if (/bigmodel\.cn|zhipu/.test(host)) {
      if (!/glm-(4\.[5-9]|z1)|glm-5/.test(model)) return {};
      return { thinking: { type: off ? "disabled" : "enabled" } };
    }
    // 火山方舟 Ark: thinking.type; 支持 thinking 的模型族
    if (/volces\.com|volcengine|ark\.cn/.test(host)) {
      if (!/doubao-seed|doubao-1\.5|kimi-k2|deepseek-r1|deepseek-v3/.test(model)) return {};
      return { thinking: { type: on ? "enabled" : "disabled" } };
    }
    // 通义 DashScope: enable_thinking (qwen3 系)
    if (/dashscope/.test(host)) {
      if (!/qwen3|qwen-3/.test(model)) return {};
      return { enable_thinking: on };
    }
    // OpenAI 推理系: reasoning_effort (off 无法强制关闭, 不注入)
    if (/api\.openai\.com/.test(host)) {
      if (off) return {};
      if (!/^o[1-9]|gpt-5/.test(model)) return {};
      return { reasoning_effort: lvl === "max" ? "high" : lvl };
    }
    return {};
  }

  // 原生联网搜索 (模型 API 自带, 2026-10-11): 按厂商返回"如何注入联网搜索"的规格, 不支持的返回 null。
  //   - tool 型: 把 web_search 工具塞进 tools 数组 (智谱 / 火山方舟 / OpenAI)
  //   - param 型: 顶层开 enable_search 布尔 (通义 DashScope/百炼)
  //   - DeepSeek 的 chat/completions 官方明确不支持内置搜索 → null (走外部搜索回退)
  _nativeSearchSpec() {
    const host = String(this.baseUrl || "").toLowerCase();
    if (/bigmodel\.cn|zhipu/.test(host)) {
      return { kind: "tool", tool: { type: "web_search", web_search: { enable: true, require_search: true } }, injectQuery: true };
    }
    if (/dashscope|bailian|qwencloud|qianwen|maas\./.test(host)) {
      return { kind: "param", key: "enable_search", value: true };
    }
    if (/volces\.com|volcengine|ark\.cn/.test(host)) {
      return { kind: "tool", tool: { type: "web_search" }, injectQuery: false };
    }
    if (/api\.openai\.com/.test(host)) {
      return { kind: "tool", tool: { type: "web_search" }, injectQuery: false };
    }
    return null;
  }

  async nativeWebSearch(query, { count = 5, contentSize = "medium", timeoutMs } = {}) {
    const spec = this._nativeSearchSpec();
    if (!spec) return null;
    const messages = [{ role: "user", content: String(query || "") }];
    try {
      let data;
      if (spec.kind === "param") {
        data = await this._request("/chat/completions", {
          model: this.model, messages, [spec.key]: spec.value, ...this._thinkParams(),
        }, { timeoutMs });
      } else {
        let tool = spec.tool;
        if (spec.injectQuery) {
          tool = {
            type: "web_search",
            web_search: {
              ...spec.tool.web_search,
              search_query: String(query || ""),
              count: Math.min(Math.max(Number(count) || 5, 1), 10),
              content_size: contentSize,
            },
          };
        }
        data = await this._request("/chat/completions", {
          model: this.model, messages, tools: [tool], ...this._thinkParams(),
        }, { timeoutMs });
      }
      const m = data?.choices?.[0]?.message;
      return m?.content ? String(m.content) : null;
    } catch {
      return null; // 搜索失败静默回退到外部搜索, 不把主流程带崩
    }
  }

  // 原生 chat (无工具)
  // timeoutMs/retryMax: 可选覆盖 provider 默认 (辅助调用传短超时+禁重试快速失败, 见 AUX_TIMEOUT_MS)
  async chat(messages, { temperature = 0.7, maxTokens = 2048, timeoutMs, retryMax } = {}) {
    const data = await this._request("/chat/completions", { model: this.model, messages, temperature, max_tokens: maxTokens, ...this._thinkParams() }, { timeoutMs, retryMax });
    const m1 = data?.choices?.[0]?.message;
    let content = m1?.content;
    // 本地推理模型兜底: thinking 吃满 token 时 content 为空, 用 reasoning_content 降级, 避免误判"断线/失败"并写入污染记忆
    if (!content && m1?.reasoning_content) content = "[思考] " + m1.reasoning_content;
    if (!content) throw new Error("LLM 返回空内容");
    return { content, usage: data?.usage };
  }

  // API chat (支持工具调用), 返回完整 message (含 tool_calls)
  async apiChat(messages, { tools = [], temperature = 0.7, maxTokens = 4096, toolRunner = null, timeoutMs, retryMax } = {}) {
    const body = { model: this.model, messages, temperature, max_tokens: maxTokens, ...this._thinkParams() };
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
    // { once: true } (2026-09-18 修复): 复用同一 signal 的多次流式对话不再累积监听器
    if (extSig) extSig.addEventListener("abort", () => ctrl.abort(), { once: true });
    let full = "";
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages, temperature, max_tokens: maxTokens, stream: true, ...this._thinkParams() }),
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
