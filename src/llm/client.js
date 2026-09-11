// src/llm/client.js - LLM 客户端
// 后端两种模式:
//   backend="openclaw" : 通过 `openclaw agent` CLI 驱动 OpenClaw 引擎 (底座=OpenClaw)
//   backend="http"     : 直接 OpenAI 兼容 HTTP API (零依赖, 用 fetch)  [默认]
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { info, warn } from "../utils/logger.js";
import { estimateTokens, truncateByTokens } from "../utils/text.js";
import { buildFencePrompt, proxyToolLoop, parseToolCalls } from "./fence.js";
import { withRetry } from "./retry.js";

const PPX_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// DeepSeek Harness 已内嵌到 ppx-agent/.deps/deepseek-harness；仍可用 PPX_DSH_ROOT 覆盖。
const DEFAULT_DSH_ROOT = process.env.PPX_DSH_ROOT || path.join(PPX_ROOT, ".deps", "deepseek-harness");
const DEFAULT_MJS = process.env.PPX_OPENCLAW_MJS || "";

// 纯函数: 校验 Node 版本是否满足 OpenClaw 引擎要求 (>=22.22.3 / >=24.15 / >=25.9, 且 23 与 24.0-24.14 不支持)
export function nodeVersionOk(version) {
  const v = String(version).split(".").map(Number);
  const [maj, min, pat] = v;
  return (maj === 22 && (min > 22 || (min === 22 && pat >= 3))) ||
         (maj === 24 && min >= 15) ||
         (maj === 25 && min >= 9) || maj > 25;
}
export class LLMClient {
  constructor(provider) {
    this.providerId = provider.id || "openclaw";
    // 后端选择: 显式 backend=openclaw, 或 id=openclaw
    this.backend = provider.backend === "openclaw" || provider.id === "openclaw" ? "openclaw"
      : provider.backend === "deepseek" || provider.backend === "dsh" || provider.id === "dsh" ? "deepseek"
      : "http";
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
    // openclaw 后端专用
    this.mjs = provider.mjs || DEFAULT_MJS;
    this.sessionKey = provider.session_key || "ppx:main";
    const dshRoot = provider.dsh_root || DEFAULT_DSH_ROOT;
    this.dshRoot = path.isAbsolute(dshRoot) ? dshRoot : path.resolve(PPX_ROOT, dshRoot);
    this._tmpCounter = 0;
    if (this.backend === "openclaw") info(`LLMClient[${this.providerId}] backend=openclaw mjs=${this.mjs} session=${this.sessionKey}`);
  }

  // ===== OpenClaw 后端异步版 (async spawn, 不阻塞事件循环) ====
  async _openclawChatAsync(messages) {
    this._openclawReadyOrThrow();
    const lastUser = [...messages].reverse().find(m => m && (m.role === "user"));
    const text = lastUser?.content || "";
    const tmp = path.join(os.tmpdir(), `ppx_msg_${Date.now()}_${this._tmpCounter++}.txt`);
    fs.writeFileSync(tmp, String(text), "utf8");
    try {
      const args = [
        this.mjs, "agent",
        "--session-key", this.sessionKey,
        "--message-file", tmp,
        "--json",
        "--timeout", String(Math.floor(this.timeoutMs / 1000)),
      ];
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", d => out += d);
        child.stderr.on("data", d => err += d);
        child.on("error", reject);
        child.on("close", code => {
          if (code !== 0) reject(this._translateOpenclawError(new Error(`openclaw 退出 code=${code}: ${err.slice(-500)}`)));
          else resolve(out);
        });
      });
      const j = JSON.parse(stdout);
      if (j.status && j.status !== "ok") throw new Error(`[皮皮虾] OpenClaw 执行状态异常 (status=${j.status})`);
      const payloads = j?.result?.payloads || [];
      const content = payloads.map(p => p?.text || "").filter(Boolean).join("\n");
      if (!content) {
        const alt = j?.result?.meta?.finalAssistantVisibleText;
        if (alt) return { content: alt, usage: null };
        throw new Error("OpenClaw 返回空内容 (runId=" + (j.runId ?? "?") + ")");
      }
      return { content, usage: null, meta: { engine: "openclaw", runId: j.runId } };
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  }

  // ===== DeepSeek Harness 后端 (dsh headless 一次性运行器) ====
  _dshReadyOrThrow() {
    if (!fs.existsSync(path.join(this.dshRoot, "apps/cli/src/bin.ts"))) {
      throw new Error("[皮皮虾] dsh 源码未就绪: " + this.dshRoot + "/apps/cli/src/bin.ts 不存在。\n请先 clone deepseek-harness 到 .deps/deepseek-harness。");
    }
    if (!fs.existsSync(path.join(this.dshRoot, "node_modules", "tsx"))) {
      throw new Error("[皮皮虾] dsh 依赖未安装: " + this.dshRoot + "/node_modules/tsx 不存在。\n请先运行 npm run dsh:install（等价于 cd .deps/deepseek-harness && pnpm install）。");
    }
  }

  // 驱动 `node --import tsx/esm apps/cli/src/bin.ts --profile headless "<task>"`,
  // stdout = 最终助手文本, exit 0 = turn 完成, 1 = 出错(stderr 带错误)
  async _dshChatAsync(messages) {
    this._dshReadyOrThrow();
    const lastUser = [...messages].reverse().find(m => m && m.role === "user");
    const text = lastUser?.content || "";
    const args = ["--import", "tsx/esm", "apps/cli/src/bin.ts", "--profile", "headless", text];
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: this.dshRoot, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", d => out += d);
      child.stderr.on("data", d => err += d);
      child.on("error", reject);
      child.on("close", code => {
        if (code !== 0) reject(new Error(`dsh 退出 code=${code}: ${err.slice(-500)}`));
        else resolve(out);
      });
    });
    const content = stdout.trim();
    if (!content) throw new Error("dsh 返回空内容");
    return { content, usage: null, meta: { engine: "deepseek-harness" } };
  }

  // 原生 chat (无工具)
  // timeoutMs/retryMax: 可选覆盖 provider 默认 (辅助调用传短超时+禁重试快速失败, 见 AUX_TIMEOUT_MS)
  async chat(messages, { temperature = 0.7, maxTokens = 2048, timeoutMs, retryMax } = {}) {
    if (this.backend === "openclaw") {
      const r = await this._openclawChatAsync(messages);
      return { content: r.content, usage: r.usage };
    }
    if (this.backend === "deepseek") {
      const r = await this._dshChatAsync(messages);
      return { content: r.content, usage: r.usage };
    }
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
    if (this.backend === "openclaw") {
      // OpenClaw 引擎是外部进程, 无法直接调用 PPX 内部工具。
      // 若提供 toolRunner, 走围栏代理循环: 引擎以纯 LLM 输出工具意图, PPX 解析执行。
      // 否则退化纯 LLM (引擎自带工具循环, 只回最终文本)。
      if (toolRunner && tools.length) return this._proxyChat(messages, { tools, toolRunner, engine: "openclaw" });
      const r = await this._openclawChatAsync(messages);
      return { message: { role: "assistant", content: r.content, tool_calls: null }, usage: r.usage };
    }
    if (this.backend === "deepseek") {
      if (toolRunner && tools.length) return this._proxyChat(messages, { tools, toolRunner, engine: "deepseek" });
      const r = await this._dshChatAsync(messages);
      return { message: { role: "assistant", content: r.content, tool_calls: null }, usage: r.usage };
    }
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
    // 纯文本工具调用修复 (吸收 OpenClaw tool-call-repair):
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

  // 围栏代理循环: 把工具清单注入, 引擎以纯 LLM 输出工具意图, PPX 执行 [P0#1]
  // 围栏上下文 token 预算 (v0.6.6 优化: 替代固定 800/400 字符截断)
  // 按 token 预算动态分配: persona 优先 40%, 历史按"最新优先 + 信息量"分配剩余 60%
  static get FENCE_CTX_TOKEN_BUDGET() { return 2400; }
  static get FENCE_PERSONA_RATIO() { return 0.4; }
  static get FENCE_HIST_BUDGET() { return 2400 * 0.6; }
  // 信息量启发: 含指令/数字/路径/结论的轮次更该保留
  static _histPriority(m) {
    const s = String(m?.content || "");
    let p = 0;
    if (/[查|算|写|建|改|创建|删除|修复|总结|分析|配置|执行|运行|启动|停止|提交|部署|安装|生成|编译|测试]/.test(s)) p += 2;
    if (/[0-9]{2,}/.test(s)) p += 1;
    if (/\.(js|py|md|json|txt|ts|go)\b|[:\\\/][A-Za-z]/.test(s)) p += 2;
    if (/失败|错误|报错|异常|成功|完成|结果|结论|决定|方案/.test(s)) p += 2;
    if (/^(你好|hi|hello|在吗|谢谢|好的|嗯|是的|对|收到|再见)/i.test(s.trim())) p -= 3;
    return p;
  }
  async _proxyChat(messages, { tools, toolRunner, engine }) {
    const fencePrompt = buildFencePrompt(tools);
    // 保留 system/persona 设定 + 最近历史, 避免外部引擎只见"当前问题" [复审 P2]
    const systemMsg = messages.find((m) => m && m.role === "system");
    const nonSys = messages.filter((m) => m && m.role !== "system");
    // person 预算: 固定 40%, 截断到预算内
    const persona = systemMsg?.content
      ? "角色设定:\n" + truncateByTokens(systemMsg.content, LLMClient.FENCE_CTX_TOKEN_BUDGET * LLMClient.FENCE_PERSONA_RATIO)
      : null;
    // 历史预算: 剩余 60% 按"最新优先 + 信息量"分配
    const histBudget = LLMClient.FENCE_HIST_BUDGET;
    let histLines = [], used = 0;
    // 1) 最新 6 条按时间倒序, 优先保留(信息量高或最新)
    const recent = nonSys.slice(-6);
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      const line = (m.role === "user" ? "用户" : "助手") + ": " + String(m.content || "");
      const t = estimateTokens(line);
      if (used + t > histBudget) continue; // 超预算跳过(不截断硬塞)
      histLines.push(line); used += t;
    }
    // 2) 若预算还有余量, 补更早的高信息量轮次
    const older = nonSys.slice(0, Math.max(0, nonSys.length - 6));
    for (let i = older.length - 1; i >= 0; i--) {
      const m = older[i];
      if (LLMClient._histPriority(m) < 2) continue; // 只补高信息量
      const line = (m.role === "user" ? "用户" : "助手") + ": " + String(m.content || "");
      const t = estimateTokens(line);
      if (used + t > histBudget) break;
      histLines.push(line); used += t;
    }
    histLines.reverse(); // 恢复时间正序
    const ctx = [persona, histLines.length ? histLines.join("\n") : null].filter(Boolean).join("\n\n");
    const combined = fencePrompt + "\n\n[上下文]\n" + ctx;
    const finalText = await proxyToolLoop(
      async (context) => {
        // 每条消息: 围栏协议 + 任务 + 累积工具结果
        const msg = context ? combined + "\n\n" + context : combined;
        if (engine === "openclaw") {
          const r = await this._openclawChatAsync([{ role: "user", content: msg }]);
          return r.content;
        }
        const r = await this._dshChatAsync([{ role: "user", content: msg }]);
        return r.content;
      },
      toolRunner,
      { maxRounds: 8 }
    );
    return { message: { role: "assistant", content: finalText, tool_calls: null }, usage: null };
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

  // 是否支持逐字流式: 仅直连 HTTP API 后端 (openclaw/deepseek 为外部进程, 一次性返回) [复审 P2]
  get supportsStream() { return this.backend !== "openclaw" && this.backend !== "deepseek"; }

  // 是否支持原生 tool_calls: 仅 http 后端 (OpenAI 兼容 API)。
  // openclaw 是完整 agent 运行时, 拒绝 PPX 的围栏协议(视为伪协议); dsh 走文本围栏。
  // 工具类任务应优先路由到支持原生 tool_calls 的后端 (实测 LM Studio 原生 tool_calls 全链路通过)。
  get supportsNativeToolCalls() { return this.backend === "http"; }

  // openclaw 后端: 启动前校验 Node 版本, 不满足则抛中文引导错误 (而非原始报错)
  _openclawReadyOrThrow() {
    if (!nodeVersionOk(process.versions.node)) {
      throw new Error("[皮皮虾] 当前 Node v" + process.versions.node + " 不满足 OpenClaw 引擎要求。\n请升级 Node 至 >=22.22.3 (推荐 26.x)；注意 Node 23 与 24.0-24.14 不支持。\n或改用 http 后端配置 API key 直连。");
    }
    if (!this.mjs || !fs.existsSync(this.mjs)) {
      throw new Error("[皮皮虾] OpenClaw 引擎未就绪: mjs 路径不存在 (" + this.mjs + ")。\n请设置环境变量 PPX_OPENCLAW_MJS 指向 openclaw.mjs，或在 config/ppx.json 的 openclaw provider 里填 mjs 字段。");
    }
  }

  // 翻译 openclaw CLI 的版本类报错为中文引导
  _translateOpenclawError(e) {
    const msg = String((e && e.message) || e);
    if (/Node\.js >= \d+\.\d+\.\d+/.test(msg) || /engines|不满足引擎要求/.test(msg)) {
      return new Error("[皮皮虾] OpenClaw 引擎要求更高的 Node 版本，请升级 Node 至 >=22.22.3 (推荐 26.x) 后重试。原始信息: " + msg.slice(0, 200));
    }
    return e;
  }
  // ===== Provider 健康探测 (Harness 化: 并发探测可用性, 支持快速失败) =====
  // openclaw 后端: 校验本地 Node 版本是否满足引擎要求 (>=22.22.3 / >=24.15 / >=25.9)
  // http 后端: 快速探测 /models (3s 超时), 不发完整请求
  async health() {
    if (this.backend === "openclaw") {
      const okNode = nodeVersionOk(process.versions.node);
      const okMjs = !!this.mjs && fs.existsSync(this.mjs);
      const ok = okNode && okMjs;
      if (!okNode) info("[health] openclaw 不可用: Node v" + process.versions.node + " 不满足引擎要求");
      if (okNode && !okMjs) info("[health] openclaw 不可用: mjs 路径不存在 (" + this.mjs + ")，请设置 PPX_OPENCLAW_MJS");
      return ok;
    }
    if (this.backend === "deepseek") {
      const okRoot = fs.existsSync(path.join(this.dshRoot, "apps/cli/src/bin.ts"));
      const okDeps = fs.existsSync(path.join(this.dshRoot, "node_modules", "tsx"));
      if (!okRoot) info("[health] deepseek 不可用: dsh 源码缺失 " + this.dshRoot);
      else if (!okDeps) info("[health] deepseek 不可用: dsh 依赖未安装 (请运行 npm run dsh:install)");
      return okRoot && okDeps && nodeVersionOk(process.versions.node);
    }
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
    if (this.backend === "openclaw") {
      // OpenClaw CLI 非流式: 一次性返回全文 (先可用, 后续可切 SSE)
      const r = await this._openclawChatAsync(messages);
      if (onDelta) onDelta(r.content);
      return r.content;
    }
    if (this.backend === "deepseek") {
      // dsh headless 非流式: 一次性返回全文
      const r = await this._dshChatAsync(messages);
      if (onDelta) onDelta(r.content);
      return r.content;
    }
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
