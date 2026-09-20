// src/mcp/client.js - MCP (Model Context Protocol) 客户端 (零依赖)
// 传输可插拔: stdio (本机 npx/uvx 服务器) + HTTP (Streamable HTTP, 远程托管服务器)。
// 协议: JSON-RPC 2.0 (换行分隔 JSON / HTTP body)。协议版本 2024-11-05 (stdio) / 2025-03-26 (HTTP)。
// 能力: initialize 握手 / tools/list / tools/call / resources/list / resources/read。
// 可靠性: 请求超时 + 断连时拒绝所有 pending 请求 (不再永久挂起)。
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { warn } from "../utils/logger.js";

const require = createRequire(import.meta.url);
// 客户端版本随包走, 不硬编码 (外部体检: 曾写死 0.1.0 与 package.json 漂移, server.js 已修, 此处补齐)
let PKG_VERSION = "0.0.0";
try { PKG_VERSION = require("../../package.json").version || "0.0.0"; } catch {}

const PROTOCOL_VERSION = "2024-11-05";      // stdio 本地服务器广泛兼容的版本
const HTTP_PROTOCOL_VERSION = "2025-03-26"; // Streamable HTTP 传输对应的协议版本
const DEFAULT_TIMEOUT = 60000;              // 单请求默认超时 (ms)
const MAX_STDIO_BUF = 1024 * 1024;          // stdout 缓冲上限: 防恶意/异常服务器发超长行耗尽内存 (v1.0.8)

// ---- SSE (Server-Sent Events) 解析 ----
// Streamable HTTP 服务器可用 text/event-stream 响应。抽 event -> data 里的 JSON-RPC 消息。
export function parseSSE(text) {
  const out = [];
  const events = String(text).split(/\r?\n\r?\n/);
  for (const ev of events) {
    let name = "message";
    const data = [];
    for (const line of ev.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    if (name !== "message" && name !== "endpoint") continue;
    const payload = data.join("\n").trim();
    if (!payload) continue;
    try {
      const j = JSON.parse(payload);
      if (Array.isArray(j)) out.push(...j);
      else out.push(j);
    } catch { /* 忽略非 JSON 负载 */ }
  }
  return out;
}

// 解析 HTTP 响应体 -> JSON-RPC 消息数组 (SSE 或 JSON 单条/批量)
function parseHttpBody(text, contentType) {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  const trimmed = text.trim();
  if (ct === "text/event-stream" || /^(event|data):/m.test(trimmed)) {
    return parseSSE(trimmed);
  }
  try {
    const j = JSON.parse(trimmed);
    return Array.isArray(j) ? j : [j];
  } catch { return []; }
}

// ---- x-mcp-header 标注解析 (MCP 2026-07-28) ----
// 从工具 inputSchema 提取 x-mcp-header 标注: 参数路径 (纯 properties 链) -> header 名。
// 约束校验 (违反任一 → 返回 null 表示该工具定义非法, 应排除):
//   - header 值非空, 匹配 HTTP token 语法 (RFC 9110 1*tchar)
//   - header 名在 schema 内大小写不敏感唯一
//   - 只允许 primitive 类型 (integer/string/boolean; number 不允许)
//   - 静态可达: 路径只能经过 properties, 不得穿过 items/composition/conditional/$ref
//   - 未经数组/组合/条件/$ref 嵌套的纯 properties 链
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function parseXMcpHeaders(toolName, schema) {
  const found = []; // { path, header }
  const seen = new Set(); // header (小写去重)
  const walk = (node, path, depth) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    // 检查当前属性是否有 x-mcp-header
    if (node["x-mcp-header"] !== undefined) {
      const hv = String(node["x-mcp-header"]);
      // 校验: 非空 + HTTP token
      if (!hv || !HTTP_TOKEN.test(hv)) throw new Error(`header 非法: ${JSON.stringify(hv)}`);
      // 校验: 大小写不敏感唯一
      const lk = hv.toLowerCase();
      if (seen.has(lk)) throw new Error(`header 重复: ${hv}`);
      seen.add(lk);
      // 校验: 类型必须 primitive 且非 number
      const type = node.type;
      if (!["integer", "string", "boolean"].includes(type)) throw new Error(`类型不允许: ${type || "(无)"}`);
      found.push({ path: [...path], header: hv });
    }
    // 递归 properties (纯链)
    if (node.properties && typeof node.properties === "object") {
      for (const [k, v] of Object.entries(node.properties)) {
        if (v && typeof v === "object") walk(v, [...path, k], depth + 1);
      }
    }
    // 非法穿透: items/oneOf/anyOf/allOf/not/if/then/else/$ref → x-mcp-header 出现在其中 = 非法
    for (const bad of ["items", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "$ref"]) {
      if (node[bad] !== undefined && hasXMcpHeader(node[bad])) {
        throw new Error(`x-mcp-header 出现在 ${bad} 内 (非法)`);
      }
    }
  };
  try {
    walk(schema, [], 0);
    return found;
  } catch (e) {
    warn(`[mcp] 工具 ${toolName} x-mcp-header 标注非法: ${e.message}`);
    return null;
  }
}

function hasXMcpHeader(node) {
  if (!node || typeof node !== "object") return false;
  if (node["x-mcp-header"] !== undefined) return true;
  return Object.values(node).some((v) => v && typeof v === "object" && hasXMcpHeader(v));
}

// ---- stdio 传输 ----
// 启动本地服务器子进程, 从 stdout 读换行分隔 JSON, 请求写 stdin。
class StdioTransport {
  constructor({ command, args = [], env = {}, cwd = null }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.proc = null;
    this._buf = "";
    this._spawned = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, this.args, {
        cwd: this.cwd || undefined,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
        // 2026-09-18 修复 (仅非 Windows): close() 用 process.kill(-pid) 杀进程组,
        //   但原 spawn 未 detached, 子进程与父进程同组 → 负 pid kill 必抛 ESRCH 被吞,
        //   npx/uvx 派生的孙进程在 Unix 上泄漏。Windows 走 taskkill /T 不受影响。
        detached: process.platform !== "win32",
      });
      this.proc = proc;
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => this._onData(chunk));
      proc.stderr.on("data", (d) => warn(`[mcp] ${this.command} stderr: ${String(d).slice(0, 300)}`));
      // v1.0.8: stdin error 监听 (子进程退出后 write 触发 EPIPE 会 unhandled 崩溃)
      if (proc.stdin) proc.stdin.on("error", (e) => warn(`[mcp] ${this.command} stdin: ${e.message}`));
      proc.once("spawn", () => { this._spawned = true; resolve(); });
      proc.once("error", (e) => {
        if (!this._spawned) reject(new Error(`无法启动 MCP 服务器 ${this.command}: ${e.message}`));
        else this.onClose?.(e);
      });
      proc.on("exit", (code) => {
        if (this._spawned) this.onClose?.(new Error(`MCP 服务器进程退出 (code ${code})`));
      });
    });
  }

  send(msg) {
    if (!this.proc || !this.proc.stdin || this.proc.killed) {
      throw new Error("MCP 服务器未连接");
    }
    try {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    } catch (e) {
      throw new Error(`MCP 写入失败: ${e.message}`);
    }
  }

  close() {
    if (this.proc) {
      const pid = this.proc.pid;
      // v1.0.8: 杀进程树 (npx/uvx 会派生子进程, 只 kill 直接子进程会泄漏)
      if (process.platform === "win32") {
        try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 }); } catch {}
      } else {
        try { process.kill(-pid, "SIGTERM"); } catch {} // 负 pid = 整个进程组
      }
      try { this.proc.kill(); } catch {}
    }
    this.proc = null;
  }

  _onData(chunk) {
    this._buf += chunk;
    // v1.0.8: 缓冲上限保护 (防内存耗尽)
    if (this._buf.length > MAX_STDIO_BUF) {
      warn(`[mcp] ${this.command} stdout 缓冲超限 (${MAX_STDIO_BUF}), 丢弃多余数据`);
      this._buf = this._buf.slice(-4096);
    }
    let idx;
    while ((idx = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.onMessage?.(msg);
    }
  }
}

// ---- HTTP 传输 (Streamable HTTP) ----
// 每次请求 POST 到 url, 响应可为 JSON 或 SSE; 维护 Mcp-Session-Id 会话头。
class HttpTransport {
  constructor({ url, headers = {}, timeout = DEFAULT_TIMEOUT }) {
    this.url = url;
    this.headers = headers;
    this.timeout = timeout;
    this.sessionId = null;
    this.closed = false;
  }

  async start() { /* 单次 POST 流即可, 无需预开连接 */ }

  async send(msg, extraHeaders = {}) {
    const headers = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      ...this.headers,
      ...extraHeaders,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    timer.unref?.(); // 不阻塞事件循环退出

    let res;
    try {
      res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(msg), signal: ctrl.signal });
    } catch (e) {
      const err = e.name === "AbortError"
        ? new Error(`MCP HTTP 请求超时 (${this.timeout}ms)`)
        : new Error(`MCP HTTP 请求失败: ${e.message}`);
      this._error(msg, err);
      return;
    } finally {
      clearTimeout(timer);
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      this._error(msg, new Error(`MCP HTTP ${res.status}: ${t.slice(0, 200)}`));
      return;
    }
    const text = await res.text();
    if (!text) return; // 202/204 空响应 (通知), 无需分发
    for (const m of parseHttpBody(text, res.headers.get("content-type") || "")) {
      this.onMessage?.(m);
    }
  }

  _error(msg, e) {
    if (msg && msg.id != null) {
      this.onMessage?.({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message } });
    } else {
      warn(`[mcp] HTTP 通知失败: ${e.message}`);
    }
  }

  close() { this.closed = true; }
}

// ---- MCP 客户端核心 (传输无关) ----
export class McpClient {
  constructor(config = {}) {
    this.config = config;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    const isHttp = Boolean(config.url) || config.transport === "http";
    if (isHttp) {
      if (!config.url) throw new Error("HTTP MCP 服务器需 url");
      this.transport = new HttpTransport(config);
      this.protocolVersion = config.protocolVersion || HTTP_PROTOCOL_VERSION;
    } else {
      if (!config.command) throw new Error("stdio MCP 服务器需 command");
      this.transport = new StdioTransport(config);
      this.protocolVersion = config.protocolVersion || PROTOCOL_VERSION;
    }
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._nextId = 0;
    this._dead = false;
    this.capabilities = {}; // initialize 握手后填充
    this.transport.onMessage = (m) => this._onMessage(m);
    this.transport.onClose = (e) => this._failAll(e || new Error("MCP 连接已断开"));
  }

  // 启动 + initialize 握手 + initialized 通知
  async connect() {
    await this.transport.start();
    const init = await this._request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "ppx-agent", version: PKG_VERSION },
    });
    if (init && init.protocolVersion) this.protocolVersion = init.protocolVersion;
    this.capabilities = (init && init.capabilities) || {};
    await this._notify("notifications/initialized", {});
    return this;
  }

  async listTools() {
    const r = await this._request("tools/list", {});
    const tools = (r && r.tools) || [];
    // v2.6.0: x-mcp-header 客户端支持 — 解析每把工具的 inputSchema 里的 x-mcp-header 标注,
    // 存为 { 参数路径 -> headerName }; 非法标注 (约束见 MCP 2026-07-28 规范) 的工具整体排除
    this._toolHeaders = new Map(); // toolName -> [{ path: string[], header: string }]
    const kept = [];
    for (const t of tools) {
      if (!t || !t.name || !t.inputSchema) { kept.push(t); continue; }
      const parsed = parseXMcpHeaders(t.name, t.inputSchema);
      if (parsed === null) {
        // 非法标注: 排除该工具 (规范: 单个坏工具不影响其他有效工具)
        warn(`[mcp] 工具 ${t.name} 的 x-mcp-header 标注非法, 已排除`);
        continue;
      }
      if (parsed.length) this._toolHeaders.set(t.name, parsed);
      kept.push(t);
    }
    return kept;
  }

  // 调用工具 -> 提取纯文本结果 (向后兼容)
  async callTool(name, args = {}) {
    return extractToolText(await this.callToolRaw(name, args));
  }

  // 调用工具 -> 返回原始 result (含 content/isError, 供上层判断)
  async callToolRaw(name, args = {}) {
    const msg = { name, arguments: args };
    // x-mcp-header 镜像: 工具定义里有标注时, 把参数值转成 Mcp-Param-* 头 (仅 HTTP 传输生效)
    const extraHeaders = this._resolveParamHeaders(name, args);
    return this._request("tools/call", msg, extraHeaders);
  }

  // 解析工具参数 -> Mcp-Param-{Header} HTTP 头 (x-mcp-header 标注)
  // 按规范: 仅 primitive (string/integer/boolean) 且静态可达路径 (纯 properties 链) 可镜像
  _resolveParamHeaders(name, args) {
    const out = {};
    const anns = this._toolHeaders && this._toolHeaders.get(name);
    if (!anns || !args || typeof args !== "object") return out;
    for (const { path, header } of anns) {
      let v = args;
      for (const seg of path) {
        if (v == null || typeof v !== "object") { v = undefined; break; }
        v = v[seg];
      }
      if (v === undefined) continue; // 参数未提供 -> 省略该头
      let sv;
      if (typeof v === "string") sv = v;
      else if (typeof v === "number" && Number.isInteger(v)) sv = String(v);
      else if (typeof v === "boolean") sv = v ? "true" : "false";
      else continue; // 非 primitive 不镜像
      out[`Mcp-Param-${header}`] = sv;
    }
    return out;
  }

  async listResources() {
    const r = await this._request("resources/list", {});
    return (r && r.resources) || [];
  }

  async readResource(uri) {
    return this._request("resources/read", { uri });
  }

  async listPrompts() {
    const r = await this._request("prompts/list", {});
    return (r && r.prompts) || [];
  }

  // 获取提示模板并填充参数 -> 返回消息数组 [{ role, content }]
  async getPrompt(name, args = {}) {
    const r = await this._request("prompts/get", { name, arguments: args });
    return (r && r.messages) || [];
  }

  close() {
    if (this._dead) return;
    this._dead = true;
    this.transport.close?.();
    this._failAll(new Error("MCP 连接已关闭"));
  }

  // ---- 内部 ----
  _request(method, params = {}, extraHeaders = {}) {
    if (this._dead) return Promise.reject(new Error("MCP 连接已关闭"));
    const id = ++this._nextId;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP 请求超时 (${this.timeout}ms): ${method}`));
      }, this.timeout);
      this._pending.set(id, { resolve, reject, timer });
      Promise.resolve()
        .then(() => this.transport.send(msg, extraHeaders))
        .catch((e) => this._settle(id, null, e));
    });
  }

  _notify(method, params = {}) {
    if (this._dead) return Promise.resolve();
    return Promise.resolve()
      .then(() => this.transport.send({ jsonrpc: "2.0", method, params }))
      .catch((e) => warn(`[mcp] 通知发送失败 ${method}: ${e.message}`));
  }

  _onMessage(msg) {
    if (!msg || msg.id == null) return; // 忽略服务器通知/无 id 消息
    const p = this._pending.get(msg.id);
    if (!p) return;
    if (msg.error) this._settle(msg.id, null, new Error(msg.error.message || "MCP 调用失败"));
    else this._settle(msg.id, msg.result, null);
  }

  _settle(id, result, err) {
    const p = this._pending.get(id);
    if (!p) return;
    this._pending.delete(id);
    clearTimeout(p.timer);
    err ? p.reject(err) : p.resolve(result);
  }

  _failAll(err) {
    for (const [id, p] of [...this._pending]) {
      clearTimeout(p.timer);
      this._pending.delete(id);
      p.reject(err);
    }
  }
}

// 提取 tools/call 结果的文本 (MCP 返回 content 数组, 每项 type=text 含 text)
export function extractToolText(result) {
  if (result == null) return "";
  const content = result.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text);
    if (texts.length) return texts.join("\n");
    // 非文本内容 (image/resource) 回退为 JSON
    return JSON.stringify(content);
  }
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

// 提取 tools/call 结果的 { text, isError } (识别 MCP 工具级报错, 供自愈重试)
export function extractToolResult(result) {  if (result == null) return { text: "", isError: false };
  const content = result.content;
  let isError = Boolean(result.isError);
  if (Array.isArray(content)) {
    const texts = [];
    for (const c of content) {
      if (!c) continue;
      if (c.isError) isError = true;
      if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
      else if (c.type === "image" || c.type === "resource" || c.type === "audio") {
        texts.push(`[${c.type}: ${c.mimeType || c.uri || ""}]`);
      }
    }
    if (texts.length) return { text: texts.join("\n"), isError };
    return { text: JSON.stringify(content), isError };
  }
  if (typeof result === "string") return { text: result, isError };
  return { text: JSON.stringify(result), isError };
}

// 提取 resources/read 结果的文本 (MCP 返回 { contents: [{ uri, mimeType, text }] })
export function extractResourceText(result) {
  if (result == null) return "";
  const contents = result.contents;
  if (Array.isArray(contents)) {
    const texts = contents
      .filter((c) => c && typeof c.text === "string")
      .map((c) => `[${c.uri || "resource"}]\n${c.text}`);
    return texts.join("\n\n") || JSON.stringify(contents);
  }
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

export { parseXMcpHeaders, hasXMcpHeader };
