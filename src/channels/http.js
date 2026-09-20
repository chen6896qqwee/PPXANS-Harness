// src/channels/http.js - HTTP 通道 (零依赖)
// 起一个本地 HTTP server, 接收 POST /message 消息, 调 agent 回复
//
// 2026-09-18 重构: 路由主体原先是一个 ~530 行的巨型 handler, 其中
//   - 「鉴权失败写 401」重复 18 次
//   - 「writeHead + Content-Type + JSON.stringify + end」重复 40+ 次
//   - 「读 body → JSON.parse」重复 12 次
// 现收敛为 5 个私有工具方法 (_json / _unauthorized / _requireAuth / _readJson / _fail),
// 并按「CORS → MCP → webhook → 限流 → 路由」分层拆成若干具名方法;
// 对外接口 (类/方法/路径/状态码/响应体) 完全不变。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Channel } from "./base.js";
import { readBody, sendJson, SSE_HEADERS } from "../utils/http.js";
import {
  listProviders, addProvider, updateProvider, removeProvider, reorderProviders, readConfig,
} from "../config/providers.js";
import { getSettings, updateSettings } from "../config/settings.js";
import { suggestProactive } from "../ans/proactive.js";
import { ensureDir, atomicWrite, readText } from "../utils/store.js";
import { TokenBucket } from "../utils/rate-limit.js";
import { createMcpEndpoint } from "../mcp/http.js";
import { createAdminTools } from "../mcp/admin.js";
import { buildTree, readWorkspaceFile } from "./workspace.js";

const MAX_BODY = 1024 * 1024;          // 请求体上限 1MB
const RATE_PER_MIN = 60;               // 每 IP 每分钟最大请求数 (令牌桶)
const MAX_INFLIGHT = 4;                // 同时处理的最大对话请求数 (超出立即 429, 防单 agent 被并发压垮)

// REST 端点退役开关覆盖的路径 (channels.http.mcp.legacy_rest = false 时统一 410)
const LEGACY_REST_PATHS = ["/message", "/message/stream", "/chat", "/sessions", "/reset", "/interrupt"];

// 恒定时间字符串比较 (2026-09-17 安全修复):
// 直接 `a === b` 会在首个不同字节处提前返回, 理论上是可观测的计时侧信道。
// 先把两侧都摘要成定长 32 字节再比对, 长度差异也被消除。
// @param {string} a
// @param {string} b
// @returns {boolean}
export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const hb = crypto.createHash("sha256").update(String(b ?? "")).digest();
  try { return crypto.timingSafeEqual(ha, hb); } catch { return false; }
}

// 面向客户端的错误文案净化: 只保留业务语义, 屏蔽 Node/流内部实现细节
// (避免把 "Cannot write headers after they are sent to the client" 这类内部错误原文回给前端)
const INTERNAL_ERR_RE = /ERR_HTTP_HEADERS_SENT|ERR_STREAM_|Cannot (write headers|call write after)|write after end|EPIPE|ECONNRESET/i;
export function publicErrorMessage(e) {
  // 兼容三种入参: Error 实例 / 字符串 / 任意对象 (对象且无 message 时不该退化成 "[object Object]")
  const raw = (e && typeof e === "object" && typeof e.message === "string") ? e.message
    : (typeof e === "string" ? e : "");
  const msg = raw.trim();
  if (!msg) return "服务内部错误";
  if (INTERNAL_ERR_RE.test(msg)) return "连接状态异常, 请重试";
  return msg.slice(0, 300);
}

// HTTP 鉴权 token 解析 / 生成 (v1.0.9 起持久化, 重启复用, 免去 Web 前端每次重贴 token)
// 优先级: 1) 显式配置 (env/ppx.json 的 channels.http.auth_token) > 2) 数据目录持久化文件复用 > 3) 新生成并原子落盘
// @param {object} opts
// @param {string}       opts.configured    显式配置的 token (PPX_AUTH_TOKEN 或 config 里的 auth_token; 空串视为未配置)
// @param {string|null}  opts.persistedFile 自动生成 token 的持久化文件路径 (无则仅返回生成, 不落盘)
// @returns {{ token:string, source:"configured"|"persisted"|"generated", generated:boolean }}
// 纯函数, 便于单测: 不依赖 agent/实例状态, 全部副作用 (读/写文件) 走参数传入的路径
export function resolveAuthToken({ configured = "", persistedFile = null } = {}) {
  const explicit = String(configured || "").trim();
  // 优先级 1: 显式配置 (env/config) — 以身作则, 不读写持久化文件
  if (explicit) return { token: explicit, source: "configured", generated: false };

  // 优先级 2: 复用持久化文件里的旧 token (非空)
  if (persistedFile) {
    const old = String(readText(persistedFile, "") || "").trim();
    if (old) return { token: old, source: "persisted", generated: false };
  }

  // 优先级 3: 新生成随机 token; 若有持久化路径则原子落盘 (写 .tmp 再 rename, 全程目录存在)
  const token = crypto.randomBytes(24).toString("hex");
  if (persistedFile) {
    try {
      ensureDir(path.dirname(persistedFile));
      atomicWrite(persistedFile, token); // .tmp + rename: 原子替换, 并发/崩溃不损坏
    } catch {
      // token 已生成但在内存可用; 落盘失败仅丢失"跨重启复用", 不阻断启动
    }
  }
  return { token, source: "generated", generated: true };
}

export class HttpChannel extends Channel {
  constructor(agent, { port = 8899, host = "127.0.0.1" } = {}) {
    super("http", agent);
    this.port = port;
    this.host = host;
    this.server = null;
    this.agent = agent;
    this.publicDir = path.join(this.agent.root, "public");
    // v1.0.9: token 解析延迟到 connect() 的 _ensureToken, 以便持久化文件与 agent.dataDir 就绪
    // 这里只缓存显式配置 (env/config), 交给 _ensureToken 走"显式 > 持久化 > 新生成"的优先级
    this.authToken = process.env.PPX_AUTH_TOKEN || this._tokenFromConfig();
    this._persistedTokenFile = agent.dataDir ? path.join(agent.dataDir, "http-token") : null;
    this._rateLimiter = new TokenBucket({ perMin: RATE_PER_MIN });
    this._buckets = this._rateLimiter.buckets; // ip -> {tokens, last} (可观测, 与限流器同一 Map)
    // v1.0.8: webhook 路由注册表 (feishu/wechat 通道挂载), 单一 request handler 分发, 无多 listener 竞态
    this.webhookRoutes = new Map(); // path -> async (req, res) => void
    // CORS 来源白名单 (v1.0.7): channels.http.cors_origin 数组; 未配置默认 * (向后兼容)
    // 配置后仅放行白名单 origin, 其余跨域请求 403 (token 泄露时降低任意跨站读取风险)
    this.corsOrigins = this._corsFromConfig();
    this._inFlight = 0; // 当前处理中的对话请求数
    // v2.6.0: MCP 标准端点 (Streamable HTTP) — 默认开启, 路径 /mcp
    const mcpCfg = (this.agent?.config?.channels?.http?.mcp) || {};
    this.mcpEnabled = mcpCfg.enabled !== false;
    this.mcpPath = mcpCfg.path || "/mcp";
    // v2.6.0: 产品壳已全部走 MCP (前端不再调用 REST)。服务端默认保留 REST 兼容 (旧脚本/测试不受影响);
    // 想彻底退役可设 channels.http.mcp.legacy_rest=false → /api/* 与 /message* 返回 410 并引导 /mcp
    this.mcpLegacyRest = mcpCfg.legacy_rest !== false;
    if (this.mcpEnabled) {
      // v2.6.0: admin 虚拟工具 (会话/提供方/设置/任务面板) 注入 MCP 端点, 供 web 前端替代 REST /api/*
      const admin = createAdminTools(agent);
      this.mcpAdmin = admin;
      const { server: mcpServer, handler: mcpHandler } = createMcpEndpoint(agent, {
        name: agent.config?.agent?.name || "ppxans-harness",
        // 版本由 createMcpEndpoint -> McpServer 默认读 package.json (不再硬编码)
        supportedVersions: mcpCfg.supported_versions,
        extraTools: admin.tools,
        authenticated: (req, res) => {
          if (this._authed(req, res)) return true;
          // _authed 只做判断不写响应, 这里补 401 (否则客户端永远挂等)
          this._unauthorized(res);
          return false;
        },
        rateLimit: (req, res) => this._rateLimit(req, res),
        // Origin 校验已由顶部统一 CORS 处理 (含白名单/默认 localhost), MCP handler 内不再二次拦截
        skipOriginCheck: true,
      });
      this.mcpServer = mcpServer;
      this.mcpHandler = mcpHandler;
    }
  }

  // ==================== 请求/响应工具 (消除路由层重复样板) ====================

  // 统一 JSON 响应 (writeHead + Content-Type + 序列化 + end); headers 用于 Retry-After / Cache-Control
  _json(res, code, obj, headers = {}) {
    sendJson(res, code, obj, { headers });
  }

  // 鉴权失败响应
  _unauthorized(res) {
    this._json(res, 401, { error: "unauthorized" });
  }

  // 鉴权门禁: 通过返回 true; 未通过则已写 401 并返回 false
  // 用法: `if (!this._requireAuth(req, res)) return true;`
  _requireAuth(req, res) {
    if (this._authed(req, res)) return true;
    this._unauthorized(res);
    return false;
  }

  // 读 body 并解析 JSON (缺省 "{}")。体超限时 _readBody 已写 413 并返回 null → 这里也返回 null。
  // JSON 解析失败向上抛错, 由调用方 try/catch 转 400 (保持各路由既有错误语义)。
  async _readJson(req, res) {
    const body = await this._readBody(req, res);
    if (body === null) return null;
    return JSON.parse(body || "{}");
  }

  // 统一错误响应
  _fail(res, e, code = 400) {
    this._json(res, code, { error: e.message });
  }

  // 对话类路由的公共前置 (原 /message 与 /message/stream 各抄一份):
  //   鉴权 → 读 JSON (超限时 _readJson 已回 413) → 抽取消息文本与会话键。
  //   任一步失败时响应已写出, 返回 null, 调用方统一 `return true`。
  async _readChatRequest(req, res) {
    if (!this._requireAuth(req, res)) return null;
    const data = await this._readJson(req, res);
    if (data === null) return null;
    const text = data.message || data.text || "";
    if (!text) { this._json(res, 400, { error: "missing message" }); return null; }
    return { text, sessionKey: data.sessionId || "default" };
  }

  // 简单并发护栏: 用计数信号量限制同时处理的对话请求, 超出立即 429
  // 防止多个慢请求无限叠加占用单线程主 agent (可选的背压层, 区别于每 IP 令牌桶限流)
  _acquire(res) {
    if (this._inFlight >= MAX_INFLIGHT) {
      this._json(res, 429, { error: "too many concurrent requests, retry shortly" }, { "Retry-After": "5" });
      return false;
    }
    this._inFlight += 1;
    return true;
  }
  _release() { if (this._inFlight > 0) this._inFlight -= 1; }

  // v1.0.8: webhook 通道注册路由 (路径匹配即由该通道处理, 不经过主逻辑)
  registerWebhook(path, handler) {
    if (typeof handler === "function") this.webhookRoutes.set(path, handler);
    return () => this.webhookRoutes.delete(path);
  }

  _corsFromConfig() {
    try {
      const c = this.agent?.config?.channels?.http?.cors_origin;
      if (c === undefined || c === null || c === "*") return [];
      if (Array.isArray(c)) return c.filter(Boolean);
      if (typeof c === "string") return [c];
    } catch { /* 配置异常回退默认 */ }
    return [];
  }

  // 判断请求是否来自本机回环 (127.0.0.1/::1) —— 只有本机才允许把 token 注入首页
  // 安全边界: 服务默认只绑 127.0.0.1; 即使绑到 0.0.0.0, 局域网访问者拿不到注入的 token,
  // 前端会退化为"手填 token"形态, 而恶意网页因 CORS 读不到首页响应, 无法窃取 token。
  _isLoopback(req) {
    const a = (req.socket && req.socket.remoteAddress) || "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
  }

  // 来源是否可信 (2026-09-17 安全修复, P0-1):
  // 仅靠 remoteAddress 判断"本机"是不够的 —— 浏览器里任意网站发起的请求, 其源地址同样是 127.0.0.1。
  // 配合默认 `Access-Control-Allow-Origin: *`, 恶意页面可以 fetch('http://127.0.0.1:8899/api/bootstrap')
  // 并把响应体读走, 从而拿到本地 API token (实测可复现)。
  // 因此对"下发 token"的路径追加两道浏览器侧的来源判据:
  //   1) Origin 头存在时, 其 hostname 必须是本机回环 (同源导航不带 Origin → 放行)
  //   2) Sec-Fetch-Site 为 cross-site → 一律拒绝 (现代浏览器的强信号)
  _originTrusted(req) {
    const sfs = String(req.headers["sec-fetch-site"] || "").toLowerCase();
    if (sfs === "cross-site") return false;
    const origin = req.headers["origin"];
    if (!origin) return true; // 非浏览器请求 (curl/脚本) 或同源导航
    try {
      const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
      return host === "127.0.0.1" || host === "localhost" || host === "::1";
    } catch {
      return false; // Origin 畸形 → 不予信任
    }
  }

  // 可信本地请求 = 回环地址 + 可信来源 (下发 token 的唯一条件)
  _isTrustedLocal(req) {
    return this._isLoopback(req) && this._originTrusted(req);
  }

  // 版本号取自 package.json (不硬编码, 与 McpServer 同源策略)
  // 2026-09-18: 结果缓存 —— /health 与 /api/bootstrap 每次请求都重读磁盘无必要 (版本运行期不变)
  _pkgVersion() {
    if (this._pkgVersionCache) return this._pkgVersionCache;
    try {
      const p = path.join(this.agent.root, "package.json");
      if (fs.existsSync(p)) {
        const v = JSON.parse(fs.readFileSync(p, "utf8")).version || "0.0.0";
        this._pkgVersionCache = v;
        return v;
      }
    } catch { /* 读不到就用占位 */ }
    return "0.0.0";
  }

  // Web 前端引导数据 (注入首页 <head>, 本地零配置可用)
  // authToken 仅在"可信本地请求"时下发 (回环 + 来源可信, 见 _isTrustedLocal);
  // 非回环 / 跨站来源只给 token_required 标志, 不下发任何凭据
  bootstrapPayload(req) {
    const loopback = this._isLoopback(req);
    const trusted = this._isTrustedLocal(req);
    return {
      app: "ppxans-harness",
      version: this._pkgVersion(),
      agent: (this.agent?.config?.agent?.name) || "皮皮虾",
      user: (this.agent?.config?.user?.name) || "",
      port: this.port,
      host: this.host,
      base: `http://${this.host === "0.0.0.0" ? "127.0.0.1" : this.host}:${this.port}`,
      authToken: trusted ? (this.authToken || "") : "",
      tokenLoopback: loopback,
      tokenTrusted: trusted,
      tokenRequired: Boolean(this.authToken),
      mcpPath: this.mcpPath,
      legacyRest: this.mcpLegacyRest,
      time: new Date().toISOString(),
    };
  }

  // 读取首页 HTML 并注入 window.__PPX_BOOTSTRAP__ (找不到文件返回 null)
  renderIndex(req) {
    const htmlPath = path.join(this.publicDir, "index.html");
    if (!fs.existsSync(htmlPath)) return null;
    let html = fs.readFileSync(htmlPath, "utf8");
    const cfg = JSON.stringify(this.bootstrapPayload(req)).replace(/</g, "\\u003c");
    const tag = `<script>window.__PPX_BOOTSTRAP__=${cfg};</script>`;
    // 优先插在 </head> 前; 模板没有 head 就退化为插到 </body> 前
    if (html.includes("</head>")) html = html.replace("</head>", `${tag}\n</head>`);
    else if (html.includes("</body>")) html = html.replace("</body>", `${tag}\n</body>`);
    else html = tag + html;
    return html;
  }

  _tokenFromConfig() {
    try {
      const p = path.join(this.agent.root, "config", "ppx.json");
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
        return (cfg.channels && cfg.channels.http && cfg.channels.http.auth_token) || "";
      }
    } catch {}
    return "";
  }

  // 若未配置 token: 复用持久化文件(重启不变)或自动生成并原子落盘 (类似 Jupyter token)
  _ensureToken() {
    if (this.authToken) return this.authToken;
    const r = resolveAuthToken({ configured: process.env.PPX_AUTH_TOKEN || "", persistedFile: this._persistedTokenFile });
    this.authToken = r.token;
    if (r.source === "persisted") {
      console.log("  ℹ  HTTP 认证 token 复用自持久化文件 (重启不更换, 前端无需重贴)");
    } else {
      console.log("");
      console.log("  ⚠️  HTTP 认证 token 未配置, 已自动生成并持久化 (重启复用):");
      console.log(`       PPX_AUTH_TOKEN=${this.authToken}`);
      console.log(`     用法: Authorization: Bearer ${this.authToken}`);
      console.log(`     token 已保存到 ${this._persistedTokenFile}, 重启不再更换`);
      console.log("      (或设置 config/ppx.json 的 channels.http.auth_token)");
      console.log("");
    }
    return this.authToken;
  }

  _authed(req, res) {
    if (!this.authToken) return true; // 兼容旧调用: _ensureToken 在 connect 时已执行
    const h = req.headers["authorization"] || "";
    return safeEqual(h, "Bearer " + this.authToken);
  }

  // 简单令牌桶限流: 每 IP 60 req/min (实现共用 utils/rate-limit, 含过期桶回收)
  // 2026-09-17: 桶表原本只增不减 —— 长期运行 + 多变源地址会持续吃内存; 现由 TokenBucket.sweep 摊还回收。
  // this._buckets 仍指向限流器内部 Map, 保持可观测性 (测试据此注入过期桶)。
  _rateLimit(req, res) {
    const ip = req.socket?.remoteAddress || "unknown";
    if (this._rateLimiter.take(ip)) return true;
    this._json(res, 429, { error: "rate limited" }, { "Retry-After": "60" });
    return false;
  }

  // 读取请求体, 限制大小 (超限写 413 并返回 null)
  async _readBody(req, res) {
    const body = await readBody(req, { maxBytes: MAX_BODY });
    if (body === null) {
      this._json(res, 413, { error: "request too large" });
      return null;
    }
    return body;
  }

  // ==================== 路由 ====================

  async connect() {
    this._ensureToken(); // 启动时确保有 token
    this.server = http.createServer((req, res) => this._dispatch(req, res));

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.connected = true;
    return this;
  }

  // 单入口分发: CORS/OPTIONS → MCP 端点 → webhook → 限流 → 业务路由, 最后兜底 404/500
  async _dispatch(req, res) {
    try {
      if (!this._applyCors(req, res)) return;
      const reqPath = (req.url || "/").split("?")[0];

      // v2.6.0: MCP 标准端点优先 (Streamable HTTP, 单端点 POST)
      if (this.mcpEnabled && this.mcpHandler && req.method === "POST" && reqPath === this.mcpPath) {
        return this._runHandler(this.mcpHandler, req, res);
      }
      // v1.0.8: webhook 路由分发 (feishu/wechat 等): 匹配路径交给对应通道, 不走主逻辑
      const wh = this.webhookRoutes.get(reqPath);
      if (wh) return this._runHandler(wh, req, res);

      // 静态页面与 /health 不设限, 其余 API 限流
      const isOpenGet = req.method === "GET" && (reqPath === "/" || reqPath === "/index.html" || reqPath === "/health");
      if (!isOpenGet && !this._rateLimit(req, res)) return;

      // v2.6.0 REST 退役开关: /message* /sessions* /reset 与 /api/* 同受 mcp.legacy_rest 控制
      // (默认关闭: 全部走标准 MCP 端点 /mcp; 旧脚本可配置 legacy_rest: true 恢复)
      if (!this.mcpLegacyRest && LEGACY_REST_PATHS.some((p) => reqPath === p || reqPath.startsWith(p + "/"))) {
        return this._json(res, 410, { error: "REST 端点已退役, 请使用标准 MCP 端点 POST /mcp (channels.http.mcp.legacy_rest=true 可恢复)" });
      }

      if (await this._route(req, res, reqPath)) return;
      res.writeHead(404); res.end("not found");
    } catch (e) {
      // 兜底: 路由内异常不应泄漏内部实现细节, 也不应让连接悬空
      try {
        if (!res.writableEnded) this._json(res, 500, { error: publicErrorMessage(e) });
      } catch {}
    }
  }

  // 执行「自行写响应」的子 handler (MCP / webhook): 失败时若尚未写头则补 500
  async _runHandler(fn, req, res) {
    try {
      await fn(req, res);
    } catch (e) {
      try {
        if (!res.writableEnded) this._json(res, 500, { error: e.message });
      } catch {}
    }
  }

  // 统一 CORS 响应头 (所有路由含 /mcp 共用)。返回 false 表示本次请求无需继续 (已响应或来源被拒)。
  // v1.0.7 语义: 默认 * (兼容); 配置 cors_origin 白名单时校验浏览器来源
  _applyCors(req, res) {
    const reqOrigin = req.headers.origin;
    let allowOrigin = "*";
    if (this.corsOrigins.length) {
      allowOrigin = !reqOrigin ? "*" : (this.corsOrigins.includes(reqOrigin) ? reqOrigin : null);
    }
    if (!allowOrigin) {
      this._json(res, 403, { error: "origin not allowed" });
      return false;
    }
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    if (allowOrigin !== "*") res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return false; }
    return true;
  }

  // 业务路由。返回 true 表示已处理 (响应已写); false 交给 404 兜底。
  // 2026-09-18 重构: 原为一个 161 行的巨型分支链, 现按域拆成 4 个具名子路由 + 1 个 API 门禁,
  // 每个子路由「不匹配 → undefined/false, 匹配 → 已写响应并返回 true」。分支顺序与语义完全不变。
  async _route(req, res, reqPath) {
    const get = req.method === "GET";
    const post = req.method === "POST";

    if (this._routeHealth(req, res, get, reqPath)) return true;
    if (await this._routeChat(req, res, post, reqPath)) return true;
    if (await this._routeSessions(req, res, get, post, reqPath)) return true;

    // 静态界面三态: undefined = 不匹配, true/false = 已匹配且该值即路由结果
    const stat = this._routeStatic(req, res, get, reqPath);
    if (stat !== undefined) return stat;

    // API 门禁 (REST 退役开关 + 鉴权); 返回 true 表示已拦下并写响应
    if (this._gateApi(req, res, reqPath)) return true;
    return this._apiRoute(req, res, reqPath);
  }

  // ---- 路由域 1: 健康检查 ----
  _routeHealth(req, res, get, reqPath) {
    if (!get || reqPath !== "/health") return false;
    this._json(res, 200, {
      status: "ok",
      agent: this.agent.config.agent?.name || "ppx",
      app: "ppxans-harness",
      version: this._pkgVersion(),
      web: "/",
      mcp: this.mcpEnabled ? this.mcpPath : null,
      uptime_ms: Math.round(process.uptime() * 1000),
    });
    return true;
  }

  // ---- 路由域 2: 对话 (POST /message 与 SSE 流式) ----
  async _routeChat(req, res, post, reqPath) {
    if (!post) return false;

    // 非流式对话: POST /message
    if (reqPath === "/message") {
      const req0 = await this._readChatRequest(req, res);
      if (!req0) return true;
      const { text, sessionKey } = req0;
      if (!this._acquire(res)) return true;
      try {
        const reply = await this.agent.chat(String(text), { sessionKey });
        this._json(res, 200, { reply, sessionId: sessionKey, agent: this.agent.config.agent?.name || "ppx" });
      } catch (e) {
        this._fail(res, e, 500);
      } finally { this._release(); }
      return true;
    }

    // SSE 流式对话: POST /message/stream 或 /chat
    if (reqPath === "/message/stream" || reqPath === "/chat") {
      const req0 = await this._readChatRequest(req, res);
      if (!req0) return true;
      const { text, sessionKey } = req0;
      // 2026-09-17 修复 (P0-3 / P1-1):
      //   ① 并发护栏必须在 writeHead(200) 之前判定 —— 原先先发 200 SSE 头再 _acquire,
      //      超限时 _acquire 内的 writeHead(429) 抛 ERR_HTTP_HEADERS_SENT, 被外层 catch
      //      转成一条 SSE error 事件, 客户端拿到 "HTTP 200 + text/event-stream" 却永远等不到
      //      内容 (实测可复现), 同时把 Node 内部错误原文泄漏给了客户端。
      //   ② 发完 200 后立刻 flushHeaders() —— 否则响应头要等到第一次 res.write 才下发,
      //      LLM 慢首包时客户端迟迟收不到任何响应头 (实测 6s 无任何响应)。
      if (!this._acquire(res)) return true;
      res.writeHead(200, SSE_HEADERS);
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      try {
        const send = (obj) => { if (!res.writableEnded) res.write("data: " + JSON.stringify(obj) + "\n\n"); };
        let full = "";
        const reply = await this.agent.chatStream(String(text), {
          sessionKey,
          onDelta: (d) => { full += d; try { send({ type: "delta", content: d }); } catch {} },
          onTool: (ev) => { try { send({ type: "tool", tool: ev.tool, id: ev.id, status: ev.type, args: ev.args, ok: ev.ok, durationMs: ev.durationMs }); } catch {} }, // 工具调用可视化
          onStep: (ev) => { try { send({ type: "step", round: ev.round, maxRounds: ev.maxRounds }); } catch {} }, // turn/step 推理轮次进度
        });
        const finalContent = full || reply;
        send({ type: "done", content: finalContent, sessionId: sessionKey });
        if (!res.writableEnded) res.end();
      } catch (e) {
        // 不外泄内部实现细节 (如 ERR_HTTP_HEADERS_SENT 之类)
        try { res.write("data: " + JSON.stringify({ type: "error", error: publicErrorMessage(e) }) + "\n\n"); } catch {}
        try { res.end(); } catch {}
      } finally { this._release(); }
      return true;
    }

    return false;
  }

  // ---- 路由域 3: 会话管理 (列表/历史/重命名/删除/重置/中断) ----
  async _routeSessions(req, res, get, post, reqPath) {
    if (get && reqPath === "/sessions") {
      if (!this._requireAuth(req, res)) return true;
      const list = (this.agent.sessionStore && this.agent.sessionStore.list) ? this.agent.sessionStore.list() : [];
      this._json(res, 200, { sessions: list });
      return true;
    }
    if (get && /^\/sessions\/[^/]+\/history$/.test(reqPath)) {
      if (!this._requireAuth(req, res)) return true;
      const key = decodeURIComponent(reqPath.split("/")[2]);
      const msgs = this.agent.sessionStore && typeof this.agent.sessionStore.deriveMessages === "function"
        ? this.agent.sessionStore.deriveMessages(key)
        : [];
      this._json(res, 200, { sessionId: key, messages: msgs });
      return true;
    }
    if (post && reqPath === "/sessions/rename") {
      if (!this._requireAuth(req, res)) return true;
      // 2026-09-18 修复 (缺陷 #1): 原实现把 _readBody 的【原始字符串】当对象用 —— body.from / body.to
      //   恒为 undefined, rename 实际收到 (undefined, undefined) 后恒返回 false, 前端
      //   post("/sessions/rename", {from,to}) 的契约从未生效 (重命名一直失败)。改为解析 JSON body。
      const data = await this._readJson(req, res);
      if (data === null) return true;
      const ok = this.agent.sessionStore && typeof this.agent.sessionStore.rename === "function"
        ? this.agent.sessionStore.rename(data.from, data.to) : false;
      this._json(res, ok ? 200 : 404, { ok });
      return true;
    }
    if (post && reqPath === "/sessions/delete") {
      if (!this._requireAuth(req, res)) return true;
      // 2026-09-18 修复 (缺陷 #2): 同上 —— 原实现 body.key 恒为 undefined → `|| "default"` 兜底,
      //   于是"删除某个会话"实际删掉的是 default 主会话 (误删数据)。改为解析 JSON body。
      const data = await this._readJson(req, res);
      if (data === null) return true;
      if (this.agent.sessionStore) this.agent.sessionStore.delete(data.key || "default");
      this._json(res, 200, { ok: true });
      return true;
    }
    if (post && reqPath === "/reset") {
      if (!this._requireAuth(req, res)) return true;
      const data = await this._readJson(req, res);
      if (data === null) return true;
      this.agent.resetSession(data.sessionId || "default");
      this._json(res, 200, { ok: true });
      return true;
    }
    if (post && reqPath === "/interrupt") {
      if (!this._requireAuth(req, res)) return true;
      const body = await this._readBody(req, res);
      if (body === null) return true;
      try {
        const data = JSON.parse(body || "{}");
        const sessionId = data.sessionId || "default";
        if (typeof this.agent.interrupt === "function") this.agent.interrupt();
        this._json(res, 200, { ok: true, interrupted: true, sessionId });
      } catch (e) {
        this._fail(res, e);
      }
      return true;
    }

    return false;
  }

  // ---- 路由域 4: 静态界面 (三态返回: undefined 不匹配 / true / false) ----
  _routeStatic(req, res, get, reqPath) {
    if (!get) return undefined;

    // 首页: 服务端注入 window.__PPX_BOOTSTRAP__ (本机回环请求附带 auth token) → 单进程免配置可用
    if (reqPath === "/" || reqPath === "/index.html") {
      const html = this.renderIndex(req);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html !== null ? html : "<!DOCTYPE html><meta charset=utf-8><p>皮皮虾服务已启动, 但 public/index.html 未找到。</p>");
      return true;
    }
    // 通用静态文件服务 (public/ 下任意文件, 含 vendor/ 资源, 防路径穿越)
    if (!reqPath.startsWith("/api/") && !LEGACY_REST_PATHS.some((p) => reqPath === p)) {
      return this._serveStatic(res, reqPath);
    }
    return undefined;
  }

  // ---- API 门禁: REST 退役开关 + 鉴权。返回 true = 已写响应 (路由结束), false = 放行到具体 API 路由 ----
  // channels.http.mcp.legacy_rest = true 时保留旧 /api/* REST 端点 (兼容旧脚本/客户端);
  // 默认 false: /api/* 返回 410 Gone, 引导使用标准 MCP 端点 /mcp
  _gateApi(req, res, reqPath) {
    if (!reqPath.startsWith("/api/")) return false;
    if (!this.mcpLegacyRest) {
      this._json(res, 410, { error: "REST /api/* 已退役, 请使用标准 MCP 端点 POST /mcp (channels.http.mcp.legacy_rest=true 可恢复)" });
      return true;
    }
    // /api/bootstrap 例外: 它本身就是"取 token"的入口, 可信本地请求免鉴权放行
    // (必须用 _isTrustedLocal 而非 _isLoopback —— 否则浏览器里任意网站发来的跨源请求
    //  源地址同样是 127.0.0.1, 会被误判为本机并拿到 token)
    const bootstrapLocal = reqPath === "/api/bootstrap" && this._isTrustedLocal(req);
    if (!bootstrapLocal && !this._requireAuth(req, res)) return true;
    return false;
  }

  // API 路由表: 每个 handler 返回 true (已处理)
  async _apiRoute(req, res, reqPath) {
    const get = req.method === "GET";
    // v3.0 (codex 对齐): 命令面板 / 审批流 / 目标看板 / 审查报告 / 权限热更新
    if (await this._apiV3(req, res, reqPath, get)) return true;
    switch (reqPath) {
      // 引导信息 API (前端启动时刷新用): 版本/端口/token(仅回环)/能力开关
      case "/api/bootstrap":
        if (!get) return false;
        this._json(res, 200, this.bootstrapPayload(req), { "Cache-Control": "no-store" });
        return true;
      case "/api/traces": {
        if (!get) return false;
        const limit = Number((req.url.split("limit=")[1] || "").split("&")[0] || 50);
        this._json(res, 200, this.agent.traces.read(undefined, limit));
        return true;
      }
      case "/api/stats":
        if (!get) return false;
        this._json(res, 200, this.agent.stats ? this.agent.stats() : this.agent.traces.stats());
        return true;
      case "/api/memory": {
        if (!get) return false;
        const facts = this.agent.facts ? this.agent.facts.list().slice(0, 20).map((f) => ({ content: f.content, score: f.score, type: f.type })) : [];
        const scenes = this.agent.scenes ? this.agent.scenes.listWithDesc().slice(-10) : [];
        this._json(res, 200, { facts, scenes });
        return true;
      }
      // 主动任务生成 API (ANS 自主性): 扫描记忆待办/偏好, 返回主动提醒 + 结构化 items (含 id)
      case "/api/proactive":
        if (!get) return false;
        try {
          const out = await suggestProactive(this.agent);
          this._json(res, 200, { message: out ? out.text : null, items: out ? out.items : [] });
        } catch (e) {
          this._json(res, 200, { message: null, items: [], error: e.message });
        }
        return true;
      // 标记待办完成 (ANS): POST /api/proactive/done { id } → 之后不再主动提醒
      case "/api/proactive/done": {
        if (req.method !== "POST") return false;
        if (!this._requireAuth(req, res)) return true;
        const body = await this._readBody(req, res);
        if (body === null) return true;
        try {
          const data = JSON.parse(body || "{}");
          const ok = this.agent.proactiveMarkDone(data.id);
          this._json(res, ok ? 200 : 404, { ok });
        } catch (e) {
          this._fail(res, e);
        }
        return true;
      }
      // 生命周期状态 API (ANS): 阶段/年龄/进化/繁衍
      case "/api/lifecycle":
        if (!get) return false;
        this._json(res, 200, this.agent.lifecycleStatus ? this.agent.lifecycleStatus() : {});
        return true;

      // 提供方 API - 模型配置 Web UI 后端
      // GET 列出 (key 抹掉, 只回 api_key_set) / POST 新增 / PUT 更新 / DELETE 删除
      case "/api/providers":
        return this._apiProviders(req, res);
      // 健康探测 (body: { id }), 复用 LLMClient.health()
      case "/api/providers/test":
        if (req.method !== "POST") return false;
        return this._apiProviderTest(req, res);
      // 重排 (body: { order: [id1, id2, ...] })
      case "/api/providers/reorder":
        if (req.method !== "POST") return false;
        return this._apiProviderReorder(req, res);

      // 通用设置 API: 用户名 / HTTP 端口 / 安全 / agent 预设
      case "/api/settings":
        return this._apiSettings(req, res);

      // 工作区文件树 + 读取 (Web UI 项目文件引用)
      case "/api/workspace/tree":
        if (!get) return false;
        return this._apiWorkspaceTree(res, req);
      case "/api/workspace/read":
        if (!get) return false;
        return this._apiWorkspaceRead(res, req);

      default:
        return false;
    }
  }

  // ---- 静态文件 ----
  _serveStatic(res, reqPath) {
    const file = path.resolve(this.publicDir, reqPath.replace(/^\//, ""));
    if (file.startsWith(this.publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file).toLowerCase();
      const mime = {
        ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
        ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
      }[ext] || "application/octet-stream";
      const headers = { "Content-Type": mime };
      if ([".html", ".js", ".mjs", ".css"].includes(ext)) headers["Cache-Control"] = "no-cache";
      res.writeHead(200, headers);
      res.end(fs.readFileSync(file));
      return true;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return true;
  }

  // ---- v3.0 API (codex 对齐): 命令/审批/看板/审查/权限热更新 ----
  // 全部端点失败时静默 404 (前端优雅降级隐藏对应能力)
  async _apiV3(req, res, reqPath, get) {
    const agent = this.agent;
    // GET /api/commands — 斜杠命令清单 (claude-code 命令模型)
    if (get && reqPath === "/api/commands") {
      const cmds = agent.commands?.list ? agent.commands.list(true) : [];
      this._json(res, 200, { commands: cmds.map((c) => ({ name: c.name, description: c.description || "", argumentHint: c.argumentHint || "" })) });
      return true;
    }
    // GET /api/approvals/pending — 待审批清单 (codex approval flow)
    if (get && reqPath === "/api/approvals/pending") {
      this._json(res, 200, { approvals: agent.pendingApprovals ? agent.pendingApprovals() : [] });
      return true;
    }
    // POST /api/approvals/:id — 审批裁决 { decision: "approve" | "deny" }
    if (req.method === "POST" && reqPath.startsWith("/api/approvals/")) {
      const id = reqPath.slice("/api/approvals/".length);
      const body = await this._readBody(req, res);
      if (body === null) return true;
      let decision = "deny";
      try { decision = JSON.parse(body || "{}").decision || "deny"; } catch {}
      const ok = agent.resolveApproval ? agent.resolveApproval(id, decision) : false;
      this._json(res, ok ? 200 : 404, { ok });
      return true;
    }
    // GET /api/goalboard — 目标看板 (OMH goal board)
    if (get && reqPath === "/api/goalboard") {
      const board = agent.goalBoard;
      if (!board) { this._json(res, 200, { goals: [] }); return true; }
      const goals = board.list ? board.list() : [];
      this._json(res, 200, { goals, text: board.render ? board.render() : "" });
      return true;
    }
    // GET /api/review/latest — 最近一次审查报告 (OCR 分级流水线)
    if (get && reqPath === "/api/review/latest") {
      this._json(res, 200, agent._lastReview || { issues: [], report: null });
      return true;
    }
    // POST /api/permissions — 权限热更新 { approvalMode?, sandbox?, networkAccess? }
    if (req.method === "POST" && reqPath === "/api/permissions") {
      const body = await this._readBody(req, res);
      if (body === null) return true;
      if (!agent.permissions) { this._json(res, 200, { ok: false, reason: "权限引擎未装配" }); return true; }
      let cfg = {};
      try { cfg = JSON.parse(body || "{}"); } catch {}
      if (cfg.approvalMode) agent.permissions.approvalMode = cfg.approvalMode;
      if (cfg.sandbox) agent.permissions.sandbox = cfg.sandbox;
      if (cfg.networkAccess != null) agent.permissions.networkAccess = !!cfg.networkAccess;
      this._json(res, 200, { ok: true, approvalMode: agent.permissions.approvalMode, sandbox: agent.permissions.sandbox });
      return true;
    }
    return false;
  }

  // ---- 提供方 CRUD ----
  async _apiProviders(req, res) {
    if (!this._requireAuth(req, res)) return true;
    const method = req.method;
    if (method === "GET") {
      const providers = listProviders(this.agent.root);
      const defaultId = providers[0] ? providers[0].id : null;
      this._json(res, 200, { providers, default_id: defaultId });
      return true;
    }
    if (!["POST", "PUT", "DELETE"].includes(method)) return false;
    const body = await this._readBody(req, res);
    if (body === null) return true;
    try {
      const data = JSON.parse(body || "{}");
      if (method === "POST") {
        const created = addProvider(this.agent.root, data.provider || data);
        this.agent.reloadProviders(); // 热重载 (新增默认时让 agent 立即可用)
        this._json(res, 200, { ok: true, provider: created });
        return true;
      }
      if (!data.id) throw new Error("缺少 id");
      if (method === "PUT") {
        const updated = updateProvider(this.agent.root, data.id, data.patch || {});
        this.agent.reloadProviders();
        this._json(res, 200, { ok: true, provider: updated });
        return true;
      }
      const removed = removeProvider(this.agent.root, data.id);
      this.agent.reloadProviders();
      this._json(res, 200, { ok: true, provider: removed });
      return true;
    } catch (e) {
      // 不存在/缺参 → 404, 其余校验失败 → 400 (保持原语义)
      this._fail(res, e, /不存在|缺少/.test(e.message) ? 404 : 400);
      return true;
    }
  }

  // 提供方健康探测: 优先复用 agent 已有客户端 (含测试注入的 stub), 避免对磁盘配置的真实网络探测
  async _apiProviderTest(req, res) {
    if (!this._requireAuth(req, res)) return true;
    const body = await this._readBody(req, res);
    if (body === null) return true;
    try {
      const data = JSON.parse(body || "{}");
      if (!data.id) throw new Error("缺少 id");
      // 兜底顺序: allProviders → agent.llm → 磁盘配置临时构造
      let client = (this.agent.allProviders || []).find((c) => c.providerId === data.id);
      let fromCache = !!client;
      if (!client && this.agent.llm && this.agent.llm.providerId === data.id) {
        client = this.agent.llm;
        fromCache = true;
      }
      if (!client) {
        const { providers } = readConfig(this.agent.root);
        const p = providers.find((x) => x.id === data.id);
        if (!p) throw new Error("提供方不存在");
        // LLM 客户端按需加载 (避免把网络栈带进未使用该端点的进程)
        const { LLMClient } = await import("../llm/client.js");
        client = new LLMClient(p);
      }
      const healthy = await client.health();
      const detail = healthy
        ? (fromCache ? "复用 agent 客户端, 探测通过" : "API 端点可达")
        : "探测失败, 请检查 key/base_url";
      this._json(res, 200, { ok: true, healthy, detail, source: fromCache ? "agent-cache" : "disk-config" });
    } catch (e) {
      this._fail(res, e);
    }
    return true;
  }

  async _apiProviderReorder(req, res) {
    if (!this._requireAuth(req, res)) return true;
    const body = await this._readBody(req, res);
    if (body === null) return true;
    try {
      const data = JSON.parse(body || "{}");
      const providers = reorderProviders(this.agent.root, data.order || []);
      this.agent.reloadProviders();
      this._json(res, 200, { ok: true, providers });
    } catch (e) {
      this._fail(res, e);
    }
    return true;
  }

  // ---- 通用设置 ----
  async _apiSettings(req, res) {
    if (!this._requireAuth(req, res)) return true;
    if (req.method === "GET") {
      this._json(res, 200, { settings: getSettings(this.agent.root) });
      return true;
    }
    if (req.method !== "PUT") return false;
    const body = await this._readBody(req, res);
    if (body === null) return true;
    try {
      const data = JSON.parse(body || "{}");
      const settings = updateSettings(this.agent.root, data.patch || {});
      this.agent.reloadSettings(); // 热重载: 用户名/安全/agent 预设立即生效
      this._json(res, 200, { ok: true, settings });
    } catch (e) {
      this._fail(res, e);
    }
    return true;
  }

  // ---- 工作区 ----
  _apiWorkspaceTree(res, req) {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      const wsRoot = path.resolve(this.agent.root);
      const { tree, truncated, maxDepth, baseDir } = buildTree(wsRoot, {
        root: u.searchParams.get("root") || "",
        maxDepth: u.searchParams.get("maxDepth") || 3,
      });
      this._json(res, 200, {
        ok: true, root: wsRoot, dir: baseDir, maxDepth, truncated,
        tree: tree || { name: "", path: "", type: "dir", children: [] },
      });
    } catch (e) {
      this._fail(res, e);
    }
    return true;
  }

  _apiWorkspaceRead(res, req) {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      const out = readWorkspaceFile(path.resolve(this.agent.root), u.searchParams.get("path") || "");
      this._json(res, 200, { ok: true, ...out });
    } catch (e) {
      this._fail(res, e);
    }
    return true;
  }

  async send(to, text) { return text; } // HTTP 是请求-响应, 直接返回

  // 连通性测试: 用独立实例起临时 server 验证端口可绑定
  async test() {
    try {
      await this.connect();
      await this.disconnect();
      return { ok: true, detail: `HTTP 通道可启动: http://${this.host}:${this.port}` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }

  async disconnect() {
    if (this.server) { await new Promise((r) => this.server.close(r)); this.server = null; }
    this.connected = false;
  }
}
