// src/mcp/server.js - MCP (Model Context Protocol) 服务器核心 (零依赖)
// 把皮皮虾的 43+ 内置工具 + 记忆/轨迹/统计/会话资源 + 方法型技能 暴露为标准 MCP 服务。
// 双 era 支持:
//   - 现代 2026-07-28: 无握手, 每请求 _meta 携带 protocolVersion/clientInfo/clientCapabilities,
//     server/discover 探测, 结果带 resultType, 响应 _meta 带 serverInfo 身份戳。
//   - legacy 2025-06-18 及更早: initialize 握手 + capabilities 协商 (兼容存量 MCP 客户端)。
// 传输无关: 仅做 JSON-RPC 分发, stdio/HTTP 传输由上层 (src/mcp/http.js 等) 接入。
import { TOOL_ERROR_PREFIX } from "../tools/catalog.js";
import { warn } from "../utils/logger.js";
import { sanitizeMcpName } from "./index.js";

// 版本号统一读 package.json, 避免与发布版本漂移 (外部体检: 硬编码 2.5.0 导致 serverInfo 落后真实版本)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
let PKG_VERSION = "0.0.0";
try {
  PKG_VERSION = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")).version || "0.0.0";
} catch {} // 非标准安装位置时降级, 不影响启动

// 协议版本常量 (与官方 schema/2026-07-28 对齐)
export const MODERN_PROTOCOL_VERSION = "2026-07-28";  // 现代 era (每请求 _meta)
export const LEGACY_PROTOCOL_VERSION = "2025-06-18";  // legacy era (initialize 握手) 最高支持版本
export const SUPPORTED_VERSIONS = [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];
export const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

// ---- MCP 标准错误码 (JSON-RPC 保留段 + MCP 定义段) ----
export const MCP_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HEADER_MISMATCH: -32020,                 // HTTP 头与 body _meta 不一致
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,    // 版本不支持
};

// MCP 请求级错误: 携带 code/message/data, 由分发层转成 JSON-RPC error 响应
export class McpError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function isModernRequest(msg) {
  return !!(msg && msg.params && msg.params._meta && msg.params._meta["io.modelcontextprotocol/protocolVersion"]);
}

function isLegacyInitialize(msg) {
  return !!(msg && msg.method === "initialize" && !isModernRequest(msg));
}

// 结果统一加 serverInfo 身份戳 (2026-07-28: 身份在 result._meta 而非 body)
function stampServerInfo(result, serverInfo) {
  if (!result || typeof result !== "object") return result;
  return { ...result, _meta: { ...(result._meta || {}), [SERVER_INFO_META_KEY]: serverInfo } };
}

// ---- 工具名清洗: MCP 规范只允许 [A-Za-z0-9_.-] ----
function safeToolName(name) {
  const n = sanitizeMcpName(name); // 只留 \w.-, 截断 64
  return n || "unnamed";
}

export class McpServer {
  /**
   * @param {object} agent - PPXAgent 实例 (提供 tools/facts/scenes/traces/sessionStore/stats 等)
   * @param {object} [opts]
   * @param {string} [opts.name]  serverInfo.name (默认 agent 名)
   * @param {string} [opts.version] serverInfo.version
   * @param {string[]} [opts.supportedVersions] 支持的协议版本列表
   * @param {object[]} [opts.extraTools] 额外虚拟工具: [{name,title,description,inputSchema,execute}]
   * @param {object[]} [opts.prompts] 额外提示模板: [{name,description,arguments:[{name,required,description}]}]
   */
  constructor(agent, opts = {}) {
    this.agent = agent;
    this.serverInfo = {
      name: opts.name || agent?.config?.agent?.name || "ppxans-harness",
      version: opts.version || PKG_VERSION,
    };
    this.supportedVersions = opts.supportedVersions || SUPPORTED_VERSIONS;
    // 对话虚拟工具 (MCP 客户端驱动 agent 对话的入口, 不进 catalog 避免污染 LLM 工具列表)
    const chatTools = [
      {
        name: "ppx.chat.send",
        title: "对话 (非流式)",
        description: "发送消息给皮皮虾 agent, 返回完整回复。内部会执行完整工具调用循环 (记忆/搜索/命令等)。sessionId 用于区分会话上下文, 默认 default。",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "用户消息" },
            sessionId: { type: "string", description: "会话标识 (默认 default)" },
          },
          required: ["message"],
        },
        execute: async (args, ctx, agent) => {
          const reply = await agent.chat(String(args.message || ""), { sessionKey: args.sessionId || "default" });
          return { content: [{ type: "text", text: String(reply) }] };
        },
      },
      {
        name: "ppx.chat.stream",
        title: "对话 (流式)",
        description: "发送消息给皮皮虾 agent, 流式返回回复 (SSE 进度通知)。内部会执行完整工具调用循环。sessionId 用于区分会话上下文, 默认 default。",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "用户消息" },
            sessionId: { type: "string", description: "会话标识 (默认 default)" },
          },
          required: ["message"],
        },
        execute: async (args, ctx, agent) => {
          let full = "";
          const reply = await agent.chatStream(String(args.message || ""), {
            sessionKey: args.sessionId || "default",
            onDelta: (d) => { full += d; ctx?.stream?.onDelta?.(d); },
            // v2.6.0: 结构化工具/推理事件透传 (web 前端渲染工具卡片 + 轮次进度)
            onTool: (ev) => { ctx?.stream?.onTool?.(ev); },
            onStep: (ev) => { ctx?.stream?.onStep?.(ev); },
          });
          const text = full || String(reply);
          return { content: [{ type: "text", text }] };
        },
      },
    ];
    this.extraTools = opts.extraTools ? [...chatTools, ...opts.extraTools] : chatTools;
    this.extraPrompts = opts.prompts || [];
    // 工具名 -> 实现映射 (虚拟工具), 冲突时优先内置工具 (工具名唯一性在 server 内)
    this._virtualTools = new Map(this.extraTools.map((t) => [safeToolName(t.name), t]));
  }

  // ---- 对外分发入口: 接收 JSON-RPC 消息, 返回 { result } 或抛 McpError ----
  async handle(msg, ctx = {}) {
    if (!msg || typeof msg !== "object") throw new McpError(MCP_ERROR.INVALID_REQUEST, "无效请求: 非 JSON-RPC 对象");
    if (msg.jsonrpc !== "2.0") throw new McpError(MCP_ERROR.INVALID_REQUEST, "jsonrpc 字段必须为 2.0");
    const method = msg.method;
    if (typeof method !== "string" || !method) throw new McpError(MCP_ERROR.INVALID_REQUEST, "缺少 method");

    // 版本协商 (现代 era): 请求版本不在支持列表 → UnsupportedProtocolVersionError
    const reqMeta = (msg.params && msg.params._meta) || {};
    const reqVersion = reqMeta["io.modelcontextprotocol/protocolVersion"];
    if (reqVersion && !this.supportedVersions.includes(reqVersion)) {
      throw new McpError(MCP_ERROR.UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
        supported: this.supportedVersions,
        requested: reqVersion,
      });
    }

    // 分发
    switch (method) {
      // ---- 现代 era 核心 ----
      case "server/discover": {
        if (!isModernRequest(msg)) throw new McpError(MCP_ERROR.INVALID_REQUEST, "server/discover 需现代 _meta");
        return { result: stampServerInfo({
          resultType: "complete",
          supportedVersions: this.supportedVersions,
          capabilities: await this._capabilities(),
          instructions: this._instructions(),
          ttlMs: 3600000,
          cacheScope: "public",
        }, this.serverInfo) };
      }
      case "ping":
        return { result: stampServerInfo({ resultType: "complete" }, this.serverInfo) };

      // ---- tools ----
      case "tools/list": {
        const tools = await this._listTools();
        // 分页: 单页返回全部 (cursor 非空时返回空, 表示无更多页)
        const cursor = msg.params && msg.params.cursor;
        const result = {
          resultType: "complete",
          tools,
          ttlMs: 300000,      // 工具列表 5 分钟缓存 (2026-07-28 缓存语义)
          cacheScope: "public",
        };
        if (cursor) result.nextCursor = null;
        return { result: stampServerInfo(result, this.serverInfo) };
      }
      case "tools/call": {
        const name = msg.params && msg.params.name;
        if (!name) throw new McpError(MCP_ERROR.INVALID_PARAMS, "tools/call 缺少 name");
        const args = (msg.params && msg.params.arguments) || {};
        const raw = await this._callTool(name, args, ctx);
        // raw 可能是 { content, structuredContent, isError, stream? } 或字符串 (内置工具返回)
        const result = { resultType: "complete" };
        if (raw && typeof raw === "object" && !Array.isArray(raw) && ("content" in raw || "stream" in raw)) {
          Object.assign(result, raw);
          delete result.stream; // stream 由传输层消费
          if (raw.stream) result.streamHandle = raw.stream;
        } else {
          const text = typeof raw === "string" ? raw : JSON.stringify(raw);
          // isError 判定: 皮皮虾 [工具错误] 前缀 或 工具内部返回的 {"error":...} JSON
          let isError = typeof raw === "string" && raw.startsWith(TOOL_ERROR_PREFIX);
          if (!isError && typeof raw === "string") {
            const trimmed = raw.trim();
            if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
              try { isError = !!(JSON.parse(trimmed).error); } catch { /* 非 JSON 不管 */ }
            }
          }
          result.content = [{ type: "text", text }];
          result.isError = isError;
        }
        return { result: stampServerInfo(result, this.serverInfo), stream: raw && raw.stream ? raw.stream : null };
      }

      // ---- resources ----
      case "resources/list": {
        const result = { resultType: "complete", resources: await this._listResources() };
        return { result: stampServerInfo(result, this.serverInfo) };
      }
      case "resources/read": {
        const uri = msg.params && msg.params.uri;
        if (!uri) throw new McpError(MCP_ERROR.INVALID_PARAMS, "resources/read 缺少 uri");
        const contents = await this._readResource(uri);
        if (!contents) throw new McpError(MCP_ERROR.INVALID_PARAMS, `资源不存在: ${uri}`);
        return { result: stampServerInfo({ resultType: "complete", contents }, this.serverInfo) };
      }

      // ---- prompts ----
      case "prompts/list": {
        const result = { resultType: "complete", prompts: this._listPrompts() };
        return { result: stampServerInfo(result, this.serverInfo) };
      }
      case "prompts/get": {
        const name = msg.params && msg.params.name;
        if (!name) throw new McpError(MCP_ERROR.INVALID_PARAMS, "prompts/get 缺少 name");
        const messages = this._getPrompt(name, (msg.params && msg.params.arguments) || {});
        if (!messages) throw new McpError(MCP_ERROR.INVALID_PARAMS, `提示模板不存在: ${name}`);
        return { result: stampServerInfo({ resultType: "complete", messages }, this.serverInfo) };
      }

      // ---- legacy era (initialize 握手) ----
      case "initialize": {
        if (isLegacyInitialize(msg)) {
          const clientVersion = (msg.params && msg.params.protocolVersion) || "2024-11-05";
          const negotiated = this.supportedVersions.includes(clientVersion) ? clientVersion : LEGACY_PROTOCOL_VERSION;
          return { result: {
            protocolVersion: negotiated,
            capabilities: await this._capabilities(),
            serverInfo: this.serverInfo,
            instructions: this._instructions(),
          } };
        }
        throw new McpError(MCP_ERROR.INVALID_REQUEST, "initialize 需 legacy 格式 (无现代 _meta)");
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return { result: null }; // 通知无响应, 传输层处理为 202/忽略

      default:
        throw new McpError(MCP_ERROR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  // ---- 能力声明 ----
  async _capabilities() {
    return {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: {},
    };
  }

  _instructions() {
    return "PPXANS-Harness (皮皮虾) 智能体内核。可用 tools 执行文件/命令/搜索/记忆/文档/治理等操作; " +
      "resources 暴露记忆 (memory://)、轨迹 (traces://)、统计 (stats://)、会话 (sessions://) 数据; " +
      "prompts 提供方法型技能模板 (humanize/plan/debug 等)。" +
      "对话入口: 使用工具 ppx.chat.send 发送消息给 agent (含完整工具调用循环)。";
  }

  // ---- tools 实现 ----
  async _listTools() {
    const out = [];
    const seen = new Set();
    // 1. 内置 + MCP 注册工具 (catalog 全量)
    const detailed = this.agent && this.agent.tools && typeof this.agent.tools.listDetailed === "function"
      ? this.agent.tools.listDetailed() : [];
    for (const t of detailed) {
      const name = safeToolName(t.name);
      if (!t.enabled || seen.has(name)) continue;
      seen.add(name);
      const tool = {
        name,
        title: t.title || t.name,
        description: t.description || `MCP 工具: ${name}`,
        inputSchema: t.parameters || { type: "object", properties: {} },
      };
      if (t.timeoutMs) tool.annotations = { timeoutMs: t.timeoutMs, idempotent: !!t.idempotent, readOnlyHint: false };
      out.push(tool);
    }
    // 2. 虚拟工具 (对话等)
    for (const [name, t] of this._virtualTools) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        title: t.title || name,
        description: t.description || "",
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      });
    }
    return out;
  }

  async _callTool(name, args, ctx) {
    // 虚拟工具优先 (对话/流式等非 catalog 能力)
    if (this._virtualTools.has(name)) {
      return this._virtualTools.get(name).execute(args, ctx, this.agent);
    }
    // catalog 工具: 走统一策略链 (命令守卫/审计/超时)
    if (this.agent && this.agent.tools && typeof this.agent.tools.call === "function") {
      // 未知工具需在进入 catalog.call 前拦截 (catalog.call 返回错误串而非抛错)
      if (typeof this.agent.tools.has === "function" && !this.agent.tools.has(name)) {
        throw new McpError(MCP_ERROR.INVALID_PARAMS, `未知工具: ${name}`);
      }
      return this.agent.tools.call(name, args || {}, {});
    }
    throw new McpError(MCP_ERROR.INVALID_PARAMS, `未知工具: ${name}`);
  }

  // ---- resources 实现 ----
  async _listResources() {
    const out = [];
    const add = (uri, name, mimeType = "application/json", description = "") => out.push({ uri, name, mimeType, description });
    add("memory://facts", "L1 原子记忆", "application/json", "长期记忆事实库 (含分数/类型)");
    add("memory://scenes", "L2 场景", "application/json", "记忆聚类场景");
    add("traces://recent", "最近工具轨迹", "application/json", "最近 N 条工具调用轨迹");
    add("stats://overview", "运行统计", "application/json", "记忆/轨迹/工具/会话聚合统计");
    add("sessions://list", "会话列表", "application/json", "全部会话 key");
    // 动态: 会话历史按 key (sessions://<key>/history)
    if (this.agent && this.agent.sessionStore && typeof this.agent.sessionStore.list === "function") {
      for (const s of this.agent.sessionStore.list()) {
        const key = typeof s === "string" ? s : (s && (s.key || s.id)) || "";
        if (key) add(`sessions://${encodeURIComponent(key)}/history`, `会话历史: ${key}`, "application/json");
      }
    }
    return out;
  }

  async _readResource(uri) {
    const json = (obj) => [{ uri, mimeType: "application/json", text: JSON.stringify(obj, null, 2) }];
    const a = this.agent;
    try {
      if (uri === "memory://facts") return json(a.facts ? a.facts.list() : []);
      if (uri === "memory://scenes") return json(a.scenes && typeof a.scenes.listWithDesc === "function" ? a.scenes.listWithDesc() : []);
      if (uri === "traces://recent") return json(a.traces && typeof a.traces.read === "function" ? a.traces.read(undefined, 50) : []);
      if (uri === "stats://overview") return json(typeof a.stats === "function" ? a.stats() : (a.traces && a.traces.stats ? a.traces.stats() : {}));
      if (uri === "sessions://list") return json(a.sessionStore && typeof a.sessionStore.list === "function" ? a.sessionStore.list() : []);
      const m = uri.match(/^sessions:\/\/([^/]+)\/history$/);
      if (m && a.sessionStore && typeof a.sessionStore.deriveMessages === "function") {
        const key = decodeURIComponent(m[1]);
        return json(a.sessionStore.deriveMessages(key));
      }
    } catch (e) {
      warn(`[mcp] 资源读取失败 ${uri}: ${e.message}`);
      return json({ error: e.message });
    }
    return null;
  }

  // ---- prompts 实现 ----
  _listPrompts() {
    const builtins = [
      { name: "humanize", description: "去 AI 味: 检查并改写长文, 消除虚高意义/虚假深度/广告腔等 AI 模式残留", arguments: [{ name: "text", required: true, description: "待检查文本" }] },
      { name: "plan", description: "精确计划: 把模糊目标拆成可执行步骤 (P1 目标/P2 输入/P3 输出/P4 约束/P5 模式)", arguments: [{ name: "goal", required: true, description: "目标" }] },
      { name: "debug", description: "五步调试: 复现 → 二分 → 根因 → 修复 → 验证", arguments: [{ name: "problem", required: true, description: "问题描述" }] },
      { name: "verify", description: "验证优先: 任何声称完成前产出可复现证据", arguments: [{ name: "claim", required: true, description: "待验证的声称" }] },
      { name: "write_article", description: "分阶段写作: 大纲 → 初稿 → 打磨", arguments: [{ name: "topic", required: true, description: "主题" }] },
    ];
    const extra = this.extraPrompts.map((p) => ({
      name: safeToolName(p.name),
      description: p.description || "",
      arguments: (p.arguments || []).map((a) => ({ name: a.name, required: !!a.required, description: a.description || "" })),
    }));
    return [...builtins, ...extra];
  }

  _getPrompt(name, args) {
    const builtin = {
      humanize: () => [{ role: "user", content: { type: "text", text: `请对以下文本执行去 AI 味检查并改写 (消除虚高意义/虚假深度/广告腔/模糊归因/AI 词汇/规则三连/破折号狂魔/空洞结尾):\n\n${args.text || ""}` } }],
      plan: () => [{ role: "user", content: { type: "text", text: `请为以下目标制定精确计划 (P1 目标 / P2 输入 / P3 输出 / P4 约束 / P5 模式):\n\n${args.goal || ""}` } }],
      debug: () => [{ role: "user", content: { type: "text", text: `请用五步调试法 (复现 → 二分 → 根因 → 修复 → 验证) 处理:\n\n${args.problem || ""}` } }],
      verify: () => [{ role: "user", content: { type: "text", text: `请验证以下声称, 给出可复现证据或明确"未验证+原因":\n\n${args.claim || ""}` } }],
      write_article: () => [{ role: "user", content: { type: "text", text: `请分阶段写作 (大纲 → 初稿 → 打磨), 主题:\n\n${args.topic || ""}` } }],
    }[name];
    if (builtin) return builtin();
    const extra = this.extraPrompts.find((p) => safeToolName(p.name) === name);
    if (extra && typeof extra.build === "function") return extra.build(args);
    return null;
  }
}
