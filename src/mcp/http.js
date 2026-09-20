// src/mcp/http.js - MCP Streamable HTTP 传输层 (零依赖)
// 2026-07-28 语义:
//   - 单端点只收 POST; 每个 JSON-RPC 请求/通知一次 POST
//   - 必带头: MCP-Protocol-Version (现代 era, 与 body _meta 校验一致)
//   - 响应: application/json 单对象 或 text/event-stream (SSE 流, 请求级)
//   - 通知 (无 id) -> 202 Accepted 无 body
//   - 取消 = 关闭 SSE 流 (无需 notifications/cancelled)
//   - Origin 校验防 DNS rebinding; 本地默认只绑 127.0.0.1
import { McpServer, McpError, MCP_ERROR, MODERN_PROTOCOL_VERSION, SERVER_INFO_META_KEY } from "./server.js";
import { readBody, sendJson, SSE_HEADERS } from "../utils/http.js";

const MAX_BODY = 1024 * 1024; // 1MB

// ---- SSE 序列化 ----
function sseMessage(obj) {
  return `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
}

// (readBody 收敛到 utils/http.js: 超限返回 null, 由下方改为抛 McpError 保持原语义)

// ---- 传输错误 -> HTTP 状态码映射 (2026-07-28) ----
function statusFor(err) {
  switch (err.code) {
    case MCP_ERROR.UNSUPPORTED_PROTOCOL_VERSION: return 400; // Bad Request
    case MCP_ERROR.HEADER_MISMATCH: return 400;
    case MCP_ERROR.MISSING_REQUIRED_CLIENT_CAPABILITY: return 400;
    case MCP_ERROR.METHOD_NOT_FOUND: return 404;             // 未知方法
    case MCP_ERROR.INVALID_PARAMS: return 400;
    case MCP_ERROR.INVALID_REQUEST: return 400;
    case MCP_ERROR.PARSE_ERROR: return 400;
    default: return 500;
  }
}

/**
 * 创建 MCP Streamable HTTP 请求处理器。
 * @param {McpServer} server
 * @param {object} [opts]
 * @param {(req:any)=>boolean} [opts.authenticated] 鉴权钩子: 返回 false 则 401 (可选, 未提供则放行)
 * @param {(req:any, res:any)=>boolean} [opts.rateLimit] 限流钩子: 返回 false 则已响应 429 (可选)
 * @param {string[]} [opts.allowedOrigins] CORS/Origin 白名单; 空 = 仅无 Origin 或本地回环
 * @param {boolean} [opts.skipOriginCheck] 宿主已统一处理 CORS/Origin 时跳过 (避免双重标准)
 * @returns {(req:any,res:any)=>Promise<void>}
 */
export function createMcpHttpHandler(server, opts = {}) {
  return async (req, res) => {
    try {
      // 1. 方法限制: 只收 POST
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" }, { headers: { "Allow": "POST" } });
        return;
      }

      // 2. Origin 校验 (防 DNS rebinding; 宿主已统一处理时可跳过)
      const origin = req.headers.origin;
      if (origin && !opts.skipOriginCheck) {
        const allowed = opts.allowedOrigins && opts.allowedOrigins.length
          ? opts.allowedOrigins.includes(origin)
          : /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
        if (!allowed) {
          sendJson(res, 403, { jsonrpc: "2.0", error: { code: -32600, message: "origin not allowed" } });
          return;
        }
      }

      // 3. 可选鉴权 / 限流 (由宿主通道注入)
      if (opts.authenticated && !opts.authenticated(req, res)) return;
      if (opts.rateLimit && !opts.rateLimit(req, res)) return;

      // 4. 读 body + 解析
      let msg;
      try {
        const body = await readBody(req, { maxBytes: MAX_BODY });
        if (body === null) throw new McpError(MCP_ERROR.INVALID_REQUEST, "request too large");
        msg = body ? JSON.parse(body) : {};
      } catch (e) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: MCP_ERROR.PARSE_ERROR, message: `Parse error: ${e.message}` },
        });
        return;
      }

      // 5. 版本头校验 (现代 era): MCP-Protocol-Version 必须与 body _meta 一致
      const headerVersion = req.headers["mcp-protocol-version"];
      const bodyVersion = msg && msg.params && msg.params._meta && msg.params._meta["io.modelcontextprotocol/protocolVersion"];
      if (bodyVersion && headerVersion && headerVersion !== bodyVersion) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: msg.id ?? null,
          error: { code: MCP_ERROR.HEADER_MISMATCH, message: "Header MCP-Protocol-Version does not match body _meta", data: { header: headerVersion, body: bodyVersion } },
        });
        return;
      }
      // 现代请求 (有 bodyVersion) 但缺 header: 允许 (兼容未带头的老客户端), 记录即可
      if (bodyVersion && !headerVersion) {
        // 2026-07-28 规范要求必带; 宽松兼容: 直接按 body 版本处理
      }

      // 6. 通知 (无 id) -> 202
      if (msg && (msg.id === undefined || msg.id === null)) {
        // 通知: 只处理 notifications/* 或 ping 通知语义; 直接受理
        await server.handle(msg, {}).catch((e) => {
          // 通知失败仅记日志, 不影响 202 语义
          if (opts.onError) opts.onError(e);
        });
        sendJson(res, 202);
        return;
      }

      // 7. 请求: 是否 SSE (客户端 Accept 两者之一; 流式工具请求开 SSE 流)
      const accept = String(req.headers.accept || "");
      const isStreamTool = msg && msg.method === "tools/call" && /stream/i.test(String(msg.params && msg.params.name || ""));
      const wantsSSE = accept.includes("text/event-stream") && isStreamTool;

      if (wantsSSE) {
        // SSE 响应流: 进度通知 + 最终响应, 关闭流 = 取消
        res.writeHead(200, SSE_HEADERS);
        res.write(": keep-alive\n\n");
        const progressToken = msg.params && msg.params._meta && msg.params._meta.progressToken;
        const streamCtx = {
          stream: {
            onDelta: (delta, extra = {}) => {
              if (res.writableEnded) return;
              const notif = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: extra.progress, total: extra.total, message: String(delta).slice(0, 4000) } };
              if (progressToken !== undefined) notif.params.progressToken = progressToken;
              res.write(sseMessage(notif));
            },
            onMessage: (text) => {
              if (res.writableEnded) return;
              res.write(sseMessage({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: String(text).slice(0, 4000) } }));
            },
            // v2.6.0: 结构化工具事件透传 (web 前端渲染工具卡片): notifications/message 带 type=tool
            onTool: (ev) => {
              if (res.writableEnded || !ev) return;
              res.write(sseMessage({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: { type: "tool", tool: ev.tool, status: ev.type || ev.status, ok: ev.ok, durationMs: ev.durationMs } } }));
            },
            // 推理轮次事件
            onStep: (ev) => {
              if (res.writableEnded || !ev) return;
              res.write(sseMessage({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: { type: "step", round: ev.round, maxRounds: ev.maxRounds } } }));
            },
          },
        };
        try {
          const { result } = await server.handle(msg, streamCtx);
          // 流式工具: 结果即最终 delta (chat.stream 已通过 onDelta 推送过; 这里补发完整结果)
          res.write(sseMessage({ jsonrpc: "2.0", id: msg.id, result: result ?? {} }));
        } catch (e) {
          const err = e instanceof McpError ? e : new McpError(MCP_ERROR.INTERNAL_ERROR, e.message || "internal error");
          res.write(sseMessage({ jsonrpc: "2.0", id: msg.id, error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) } }));
        } finally {
          try { res.end(); } catch {}
        }
        return;
      }

      // 8. 普通 JSON 响应
      try {
        const { result } = await server.handle(msg, {});
        sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, result: result ?? {} });
      } catch (e) {
        const err = e instanceof McpError ? e : new McpError(MCP_ERROR.INTERNAL_ERROR, e.message || "internal error");
        sendJson(res, statusFor(err), {
          jsonrpc: "2.0",
          id: msg.id ?? null,
          error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) },
        });
      }
    } catch (e) {
      // 外层兜底 (不应发生)
      try {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: e.message || "internal error" } });
      } catch {}
    }
  };
}

// ---- 便捷工厂: 从 agent 构建标准 McpServer + HTTP handler ----
export function createMcpEndpoint(agent, opts = {}) {
  const server = new McpServer(agent, {
    name: opts.name,
    version: opts.version,
    supportedVersions: opts.supportedVersions,
    extraTools: opts.extraTools,
    prompts: opts.prompts,
  });
  const handler = createMcpHttpHandler(server, {
    authenticated: opts.authenticated,
    rateLimit: opts.rateLimit,
    allowedOrigins: opts.allowedOrigins,
    onError: opts.onError,
  });
  return { server, handler };
}

export { McpServer, McpError, MCP_ERROR, MODERN_PROTOCOL_VERSION, SERVER_INFO_META_KEY };
