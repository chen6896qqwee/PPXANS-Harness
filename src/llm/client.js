// src/llm/client.js - LLM 客户端 (自研底座: 纯 HTTP 直连, 零 SDK)
// 后端模式: backend="http" (默认唯一后端, 零依赖, 用 fetch)
//   - 直连任意 OpenAI 兼容 API: OpenAI/DeepSeek/通义/智谱/本地 (lmstudio/ollama/vLLM)
//   - 原生 tool_calls + 文本工具调用修复 (围栏/DSML 解析, 自研)
//   - SSE 流式 / 瞬态错误重试 / provider 健康探测
// 历史: v2.4.0 前支持 openclaw/dsh 外部引擎底座, v2.5.0 起全部移除, 只保留自研 http 底座。
// v4.2 (2026-11-01, 雷仔对齐): 引入线上协议适配层 (src/llm/protocol.js) ——
//   provider.protocol 决定线上格式 (openai-completions 缺省 / openai-responses / anthropic-messages),
//   本类对上仍只暴露内部规范形态 (OpenAI chat wire), 工具循环与调用方零改动;
//   模型目录 (models[]) 提供 per-model 元数据 (上下文窗口/最大输出/输入类型), 未配置逐级回退;
//   HTTP 失败统一 classifyHttp 三态分类 + 脱敏落盘 (data/logs/llm/last-error.json)。
import { noteCatch } from "../utils/catch-log.js";
import { parseToolCalls } from "./fence.js";
import { withRetry, classifyHttp, dumpLlmDiag } from "./retry.js";
import { markNeedsAction, clearNeedsAction } from "./needs-action.js";
import { getAdapter, isProtocol, DEFAULT_PROTOCOL } from "./protocol.js";
import { warn } from "../utils/logger.js";

export class LLMClient {
  constructor(provider) {
    this.providerId = provider.id || "http";
    // 唯一后端: http (纯 API 直连)
    this.backend = "http";
    this.baseUrl = (provider.base_url || "").replace(/\/$/, "");
    this.apiKey = provider.api_key || process.env[provider.api_key_env] || "";
    this.apiKeyEnvName = provider.api_key_env || ""; // 供缺失 key 报错时提示应设置的环境变量名
    this.model = provider.model || provider.models?.chat || "gpt-4o-mini";
    // v4.2: 线上协议 (未知值宁可回落缺省也不抛 — 配置校验已在 providers.js 拦)
    this.protocol = isProtocol(provider.protocol) ? provider.protocol : DEFAULT_PROTOCOL;
    this.adapter = getAdapter(this.protocol);
    // v4.2: per-model 元数据解析 (模型目录), 未命中回退 provider 级字段
    const catalog = Array.isArray(provider.models) ? provider.models : [];
    this.modelMeta = catalog.find((m) => m && m.id === this.model) || null;
    // 上下文窗口 (token): 供 agent 据此收紧会话历史预算, 防止本地小模型溢出。
    // 可选字段, 未配置时用保守默认 8192 (绝不因未知窗口放大历史)。
    this.context_window = Number(this.modelMeta?.context_window)
      || Number(provider.context_window)
      || Number(provider.models?.context_window)
      || 8192;
    // 单次最大输出 (token): anthropic-messages 协议必填 max_tokens 的上限依据
    this.max_output = Number(this.modelMeta?.max_output) || Number(provider.max_output) || null;
    // 视觉能力: 模型目录 inputs 含 image > provider.vision 布尔 (legacy)
    this.vision = this.modelMeta
      ? (Array.isArray(this.modelMeta.inputs) ? this.modelMeta.inputs.includes("image") : !!provider.vision)
      : !!provider.vision; // 是否支持多模态 (视觉) — 标记后才会注入图片到 user 消息
    this.timeoutMs = provider.timeout_ms || 120000;
    this.retryMax = provider.retry_max ?? 3; // 单次调用内瞬态错误重试次数 (429/5xx/timeout)
    // 思考强度 (config.llm.reasoning): auto/off/low/medium/high/max
    // completions 协议按 base_url 家族白名单注入 (_thinkParams); responses/anthropic 由适配器按档位下发
    this.reasoning = String(provider.reasoning || "auto").toLowerCase();
    // 自定义注入逃生口: config.llm.reasoning_params (对象) 原样合并进请求体
    this.reasoningParams = (provider.reasoning_params && typeof provider.reasoning_params === "object")
      ? provider.reasoning_params : null;
  }

  // 请求头 (协议适配: completions/responses 走 Bearer, anthropic 走 x-api-key + version 头)
  _headers() { return this.adapter.headers(this.apiKey); }

  // 思考强度 → 厂商参数映射 (仅 openai-completions; 按 base_url 家族 + 模型名白名单, 保守注入)
  _thinkParams() {
    if (this.reasoningParams) return { ...this.reasoningParams };
    if (this.protocol !== "openai-completions") return {}; // 其他协议的思考映射在适配器内
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

  // 适配器请求参数公共段: 显式 reasoning_params 是全协议逃生口 (原样进 body);
  // 未配置时 completions 走家族白名单映射, responses/anthropic 由适配器按 reasoning 档位下发
  _adapterParams() {
    let extraBody = null;
    if (this.reasoningParams) extraBody = { ...this.reasoningParams };
    else if (this.protocol === "openai-completions") extraBody = this._thinkParams();
    return { reasoning: this.reasoningParams ? null : this.reasoning, extraBody };
  }

  // 单次最大输出钳制 (模型目录声明了 max_output 就不越界)
  _clampOut(n) {
    const v = Math.floor(Number(n) || 0);
    if (this.max_output && v > this.max_output) return this.max_output;
    return v;
  }

  // 原生联网搜索 (模型 API 自带, 2026-10-11): 按厂商返回"如何注入联网搜索"的规格, 不支持的返回 null。
  //   - tool 型: 把 web_search 工具塞进 tools 数组 (智谱 / 火山方舟 / OpenAI)
  //   - param 型: 顶层开 enable_search 布尔 (通义 DashScope/百炼)
  //   - DeepSeek 的 chat/completions 官方明确不支持内置搜索 → null (走外部搜索回退)
  // v4.2: 仅 openai-completions 协议支持 (responses/anthropic 原生搜索工具未接线 → null 回退外部搜索)
  _nativeSearchSpec() {
    if (this.protocol !== "openai-completions") return null;
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
        data = await this._request(this.adapter.endpoint(), {
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
        data = await this._request(this.adapter.endpoint(), {
          model: this.model, messages, tools: [tool], ...this._thinkParams(),
        }, { timeoutMs });
      }
      const m = data?.choices?.[0]?.message;
      return m?.content ? String(m.content) : null;
    } catch {
      return null; // 搜索失败静默回退到外部搜索, 不把主流程带崩 /* swallowed-ok(2026-11-03): 设计回退, 非丢数据 */
    }
  }

  // 原生 chat (无工具)
  // timeoutMs/retryMax: 可选覆盖 provider 默认 (辅助调用传短超时+禁重试快速失败, 见 AUX_TIMEOUT_MS)
  async chat(messages, { temperature = 0.7, maxTokens = 2048, timeoutMs, retryMax } = {}) {
    const body = this.adapter.buildBody({
      model: this.model, messages, temperature,
      maxTokens: this._clampOut(maxTokens) || maxTokens,
      stream: false, ...this._adapterParams(),
    });
    const data = await this._request(this.adapter.endpoint(), body, { timeoutMs, retryMax });
    const parsed = this.adapter.parseResponse(data);
    let content = parsed?.message?.content ?? null;
    // 本地推理模型兜底: thinking 吃满 token 时 content 为空, 用 reasoning_content 降级, 避免误判"断线/失败"并写入污染记忆
    if (!content && parsed?.message?.reasoning_content) content = "[思考] " + parsed.message.reasoning_content;
    if (!content) throw new Error("LLM 返回空内容");
    return { content, usage: parsed?.usage, reasoning: parsed?.message?.reasoning_content || null };
  }

  // API chat (支持工具调用), 返回完整 message (含 tool_calls)
  async apiChat(messages, { tools = [], temperature = 0.7, maxTokens = 4096, toolRunner = null, timeoutMs, retryMax, signal } = {}) {
    // R12: 已中止的 signal 前置即抛 (在适配器组装请求体之前, 不发起请求)
    if (signal?.aborted) {
      const e = new Error("LLM 调用已被用户中断");
      e.name = "AbortError";
      throw e;
    }
    const body = this.adapter.buildBody({
      model: this.model, messages, tools, temperature,
      maxTokens: this._clampOut(maxTokens) || maxTokens,
      stream: false, ...this._adapterParams(),
    });
    const data = await this._request(this.adapter.endpoint(), body, { timeoutMs, retryMax, signal });
    const parsed = this.adapter.parseResponse(data);
    if (!parsed) throw new Error("LLM 返回空 message");
    const message = parsed.message;
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
      const parsedFence = parseToolCalls(content);
      if (parsedFence.calls.length) {
        toolCalls = parsedFence.calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.function.name, arguments: c.function.arguments },
        }));
        content = parsedFence.clean || null;
      }
    }
    return {
      message: {
        role: message.role || "assistant",
        content,
        tool_calls: toolCalls,
        // 2026-11-03: 非流式同样带回思考链 —— 此前只把 reasoning_content 当空回复兜底,
        //   正常回答时整段丢弃, 非流式 provider 的思考块与 _lastReasoning 永远为空。
        reasoning_content: message.reasoning_content || null,
      },
      usage: parsed.usage,
    };
  }

  // 辅助 LLM 调用短超时 (毫秒): 压缩/提炼/扩展/经验 等非主对话调用, 快速失败降级, 避免 120s 卡死
  // 使用场景: 模型未运行/网络不通时, 主对话靠 localIntent 或回退, 辅助调用不应阻塞主流程
  static get AUX_TIMEOUT_MS() { return 10000; }

  async _request(path, jsonBody, { timeoutMs, retryMax, signal, headers } = {}) {
    if (!this.apiKey) throw new Error(`[皮皮虾] LLM 缺少 API key (env=${this.apiKeyEnvName || "?"})`);
    // 2026-10-24 (R12): 非流式请求接入外部中断 signal —— 此前只有流式路径
    // (apiChatStream/streamChat) 可被 interrupt 掐断, 非流式请求一旦发出便不可阻挡,
    // "chatStream 不带 onDelta" (policy 走 apiChat) 时叫停完全失效。
    // 与流式同款: 前置检查 (已 aborted 的 signal 上 addEventListener 永不触发) + 桥接。
    if (signal?.aborted) {
      const e = new Error("LLM 调用已被用户中断");
      e.name = "AbortError";
      throw e;
    }
    const url = `${this.baseUrl}${path}`;
    const ms = timeoutMs || this.timeoutMs;
    // 辅助调用 (压缩/提炼/扩展等) 传 retryMax:0 禁重试: 短超时 + 不重试 = 快速失败降级, 不阻塞主流程
    const maxRetries = retryMax === undefined ? this.retryMax : retryMax;
    const doFetch = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { ...this._headers(), ...(headers || {}) },
          body: JSON.stringify(jsonBody),
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw this._httpError(resp.status, text, url, jsonBody);
        }
        // 2026-11-14 (评测 P1-2): 通道恢复即清"需要用户处理"标志 —— 下次失败会重新标记,
        //   成功不清就会留下过期告警, 看门狗永远 WARN。
        clearNeedsAction();
        return await resp.json();
      } finally {
        clearTimeout(timer);
      }
    };
    // 瞬态错误(429/5xx/timeout)单次调用内重试, 非瞬态(400/401/403)立即抛给上层 provider 回退
    return withRetry(doFetch, { maxRetries });
  }

  // v4.2: HTTP 失败统一构造 —— 三态分类挂到 e.classified (供 agent/UI 提示), 脱敏落盘供排障
  _httpError(status, text, url, requestBody) {
    const e = new Error(`LLM HTTP ${status}: ${String(text || "").slice(0, 300)}`);
    e.status = status; // 结构化状态码, 供 retry.isTransientError 分类
    try {
      const classified = classifyHttp(e);
      e.classified = classified;
      dumpLlmDiag({
        providerId: this.providerId, model: this.model, protocol: this.protocol,
        url, status, classified, requestBody, responseText: text, secret: this.apiKey,
      });
      // 2026-11-14 (评测 P1-2): auth/balance/404 类失败 (needsUserAction) 落持久标志 ——
      //   last-error.json 会被任何瞬时失败 (含测试桩) 覆写, 撑不起"静默停摆"的告警面。
      if (classified?.needsUserAction) {
        markNeedsAction({
          provider: this.providerId, model: this.model,
          reason: classified.reason, userHint: classified.userHint, status,
        });
      }
    } catch (e) { noteCatch("src/llm/client.js#dumpLlmDiag", e); /* 诊断绝不影响主链路 */ }
    return e;
  }

  // 自研 http 底座: 支持逐字流式 (SSE)
  get supportsStream() { return true; }

  // 自研 http 底座: 支持原生 tool_calls (三种协议都原生支持 function calling)
  get supportsNativeToolCalls() { return true; }

  // Provider 健康探测: 快速探测 /models (3s 超时), 不发完整请求
  async health() {
    if (!this.apiKey) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(this.adapter.modelsUrl(this.baseUrl), {
        headers: this._headers(),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return r.ok;
    } catch (e) {
      warn("[health] " + this.providerId + " 探测失败:", e.message);
      return false;
    }
  }

  // 2026-10-24 (R4): 流式 API chat —— 支持 tools 的 SSE 流式调用。
  // 增量 tool_call 按协议规范累积 (v4.2 起由适配器负责: completions 按规范累积 /
  // responses 按 output_item.added+arguments.delta / anthropic 按 content_block+input_json_delta),
  // 文本增量实时回调 onDelta。返回形状与 apiChat 完全一致 ({message, usage}), 工具循环无感切换。
  // 这是"带工具就整体退化为非流式"的替代路径: 工具轮次的思考文本也逐字可见。
  async apiChatStream(messages, { tools = [], temperature = 0.7, maxTokens = 4096, onDelta = null, onReasoning = null, signal = null, timeoutMs } = {}) {
    if (!this.apiKey) throw new Error(`[皮皮虾] LLM 缺少 API key (env=${this.apiKeyEnvName || "?"})`);
    // 2026-10-24 (R12): 外部 signal 在进入本函数前就可能已中止 (中断落在健康探测/
    // 上下文装配阶段) —— addEventListener 对已 aborted 的 signal 永远不再触发,
    // 不做前置检查的话叫停会被静默吞掉, 请求照跑 (真模型探测实锤: 60ms 叫停,
    // 17.8s 后散文照样全文返回)。
    if (signal?.aborted) {
      const e = new Error("LLM 调用已被用户中断");
      e.name = "AbortError";
      throw e;
    }
    const url = `${this.baseUrl}${this.adapter.endpoint()}`;
    const body = this.adapter.buildBody({
      model: this.model, messages, tools, temperature,
      maxTokens: this._clampOut(maxTokens) || maxTokens,
      stream: true, includeUsage: true, ...this._adapterParams(),
    });
    const ctrl = new AbortController();
    // 2026-10-25 评估修复: 超时从"总时长制"改"空闲制" —— 原实现一次 setTimeout 定死,
    //   慢速长流 (逐字活跃但总时长 > timeoutMs) 会在中途被硬掐; 现在每收到一个 chunk
    //   重置计时器, 只有"静默超过 timeoutMs"才判死。中断语义不变 (abort 同一 ctrl)。
    const idleMs = timeoutMs || this.timeoutMs;
    let idleTimer = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(), idleMs);
    };
    armIdle();
    if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    const acc = this.adapter.createStreamAcc(); // v4.2: 协议差异收敛进适配器
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw this._httpError(resp.status, txt, url, body);
      }
      if (!resp.body) throw new Error("响应无 body, 不支持流式");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle(); // 收到数据 = 流仍活跃, 重置空闲计时
        buf += decoder.decode(value, { stream: true });
        let idx;
        while (!streamDone && (idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim().replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue; // anthropic 的 event: 行 / SSE 注释都跳过
          const data = line.slice(5).trim();
          if (data === "[DONE]") { streamDone = true; break; } // completions 系结束信号
          try {
            const j = JSON.parse(data);
            acc.feed(j, { onDelta, onReasoning });
          } catch (e) { noteCatch(e); /* 非 JSON 行跳过 (SSE 注释/心跳) */ }
        }
      }
      const r = acc.result();
      return {
        message: r.message,
        usage: r.usage,
        streamed: !!r.streamed,
        reasoning: r.reasoning || null,
      };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  // 流式 chat: 逐块回调 (SSE), 返回累积文本
  // onDelta(content) 每次增量, onDone(full) 结束
  // v4.2: 统一走 apiChatStream (适配器内按协议解析), 无工具纯文本流
  // 2026-11-01 修复 (v4.2 回归): 经 LLMClient.prototype 直呼而非 this.apiChatStream ——
  //   agent._installUsageTracking 会把 apiChatStream/streamChat 都包装成实例属性, 委托调用
  //   解析到的是已包装的内层 → 一次纯文本流式轮被内外两层各记一次账 (calls/tokens/cost 全双倍)。
  //   走原型方法绕开实例包装, 记账只落在外层 streamChat 包装器一处 (语义与 v4.1 独立 fetch 时一致)。
  async streamChat(messages, { temperature = 0.7, maxTokens = 4096, onDelta, onReasoning, signal, __ppxUsageSink } = {}) {
    if (signal?.aborted) {
      const e = new Error("LLM 调用已被用户中断");
      e.name = "AbortError";
      throw e;
    }
    const r = await LLMClient.prototype.apiChatStream.call(this, messages, {
      temperature, maxTokens, onDelta: (d) => onDelta && onDelta(d), onReasoning, signal,
    });
    this.__ppxStreamUsage = r.usage; // 兼容旧读取方 (记账包装层已改用按调用 sink)
    // 2026-11-12: 按调用回传 usage —— 并发流式轮不再共享单槽互相覆盖
    if (typeof __ppxUsageSink === "function") { try { __ppxUsageSink(r.usage); } catch (e) { noteCatch("src/llm/client.js#streamChat:usage-sink", e); } }
    let text = r.message?.content || "";
    if (!text && r.message?.tool_calls?.length) {
      warn("[streamChat] 纯文本流收到工具调用 (已丢弃): " + r.message.tool_calls.map((t) => t.function?.name).join(","));
    }
    // 本地推理模型兜底 (与非流式 chat 的 "[思考]" 降级对齐): thinking 吃满输出预算时 content 为空,
    // 返回空串会让消费方落库/展示空轮; reasoning 全文已由 onReasoning 通道透出, 此处只补返回值。
    if (!text && r.reasoning) text = "[思考] " + r.reasoning;
    return text;
  }
}
