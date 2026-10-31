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
  readRouting, writeRouting,
} from "../config/providers.js";
import { listPresets } from "../llm/presets.js";
import { isUsableProvider } from "../llm/router.js";
import { resolveVoice, resolveLocalAsr, voiceStatus, cloudTranscribe } from "../tools/voice.js";
import { getSettings, updateSettings, REASONING_LEVELS } from "../config/settings.js";
import { suggestProactive } from "../ans/proactive.js";
import { ensureDir, atomicWrite, readText } from "../utils/store.js";
import { readPpxConfig } from "../utils/config-file.js";
import { TokenBucket } from "../utils/rate-limit.js";
import { APPROVAL_RANK, SANDBOX_RANK, detectEscalations } from "../permissions/index.js";
import { createMcpEndpoint } from "../mcp/http.js";
import { createAdminTools } from "../mcp/admin.js";
import { buildTree, readWorkspaceFile, writeWorkspaceFile, searchWorkspace } from "./workspace.js";
import { runReview } from "../review/index.js";
import { createTaskBoard } from "../mcp/tasks.js";
import { handleBotApi } from "../web/bot-api.js";
import { handlePluginApi } from "../web/plugin-api.js";
import { handleUsageStatsApi } from "../web/usage-stats.js";

const MAX_BODY = 1024 * 1024;          // 请求体上限 1MB
const RATE_PER_MIN = 60;               // 每 IP 每分钟最大请求数 (令牌桶)
const MAX_INFLIGHT = 4;                // 同时处理的最大对话请求数 (超出立即 429, 防单 agent 被并发压垮)

// 统一安全响应头 (2026-10-25 安全加固): 此前仅有 CORS 头, 无任何浏览器安全基线。
// Web UI 有 70+ innerHTML 拼接点, 编码纪律需要一道服务器侧护栏兜底 ——
// 注入的外域脚本/样式/资源一律被 CSP 拒绝, 页面也禁止被 iframe (frame-ancestors)。
// script-src 只放行 'self': 2026-10-30 起首屏主题脚本已外置为 public/theme.js,
// 页面不再有任何可执行内联脚本, 因此不再需要维护内容 sha256 白名单。
// 引导数据走 <script type="application/json" id="ppx-boot">, 不是可执行脚本, 不受 script-src 约束;
// style-src 需 'unsafe-inline': SVG sprite/输入框既有内联 style 属性是既有 UI 结构。
// connect-src 'self': app.js 仅同源 fetch (实测无外域调用)。
export const SECURITY_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

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
      // 2026-10-31: 落盘后收紧权限位 (POSIX 0600; Windows 用户目录 ACL 默认已受限, chmod 无效则忽略)
      try { fs.chmodSync(persistedFile, 0o600); } catch { /* 非 POSIX 或已受限: 忽略 */ }
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
    // 2026-10-10: SSE /events 广播订阅者集合 (send() 主动提醒 + EQ 结构化事件桥接用)
    this._sseClients = new Set(); // res 对象 (断连时移除)
    // 2026-10-24: SSE 一次性 ticket (POST /events-ticket 换发, 60s 过期, 用后即焚)
    this._eventsTickets = new Map(); // ticket -> 过期时间戳
    // 2026-10-31: 权限放宽二次确认 (POST /api/permissions), 一次性确认码 + 60s TTL
    this._permConfirm = null;
    // CORS 来源策略 (v1.0.7): channels.http.cors_origin; v1.0.7 默认 * (兼容)
    // 2026-10-31 安全默认收紧: 未配置 = "same-origin" 严格模式 (带跨源 Origin 的一律 403)。
    //   显式放开: "*" / [] / 白名单数组 (旧配置写法全部保留)。
    // 2026-10-24: "same-origin" 严格模式 —— 跨源带 Origin 的一律 403
    this.corsStrictSameOrigin = false;
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
    this._json(res, 401, { error: "未授权: 请提供有效的访问令牌" });
  }

  // 2026-10-24 (R13): 审批 sink 注册表 + agent._onApprovalEvent 广播接线 (懒安装一次)。
  _ensureApprovalSinks() {
    if (!this._approvalSinks) this._approvalSinks = new Set();
    if (!this.agent._onApprovalEvent) {
      this.agent._onApprovalEvent = (req) => {
        for (const fn of this._approvalSinks) { try { fn(req); } catch { /* 单个 sink 异常不断流 */ } }
      };
    }
    return this._approvalSinks;
  }

  // 鉴权门禁: 通过返回 true; 未通过则已写 401 并返回 false
  // 用法: `if (!this._requireAuth(req, res)) return true;`
  _requireAuth(req, res) {
    if (this._authed(req, res)) return true;
    this._unauthorized(res);
    return false;
  }

  // 读 body 并解析 JSON (缺省 "{}")。体超限时 _readBody 已写 413 并返回 null → 这里也返回 null。
  // JSON 解析失败属【客户端错误】, 本方法就地回 400 并返回 null ——
  //   (2026-10-10 修复 P1) 原实现"向上抛错由调用方 try/catch 转 400", 但 5 处调用方
  //   (_readChatRequest / /sessions/rename / /sessions/delete / /reset) 全都没接 try/catch,
  //   SyntaxError 一路冒泡到顶层通用处理器, 被兜成 500 —— 客户端分不清"我发错了"与"服务挂了",
  //   会触发无意义重试风暴、并把脏数据误报成服务端故障。
  //   收口于此: 与"超限时已写 413 返回 null"同构, 调用方沿用 `if (data === null) return true` 既有约定,
  //   5 个路由无需改动即一次性收敛为 400。
  async _readJson(req, res) {
    const body = await this._readBody(req, res);
    if (body === null) return null;
    if (body === "" || body == null) return {};
    try {
      return JSON.parse(body);
    } catch {
      this._json(res, 400, { error: "请求体不是合法 JSON" });
      return null;
    }
  }

  // 统一错误响应
  _fail(res, e, code = 400) {
    // 2026-10-10 修复: 原直接透传 e.message, 会把 ERR_HTTP_HEADERS_SENT 等内部实现细节回给客户端。
    //   收敛到 publicErrorMessage —— 唯一真相源, 屏蔽 Node/流内部细节, 只留业务语义。
    this._json(res, code, { error: publicErrorMessage(e) });
  }

  // 对话类路由的公共前置 (原 /message 与 /message/stream 各抄一份):
  //   鉴权 → 读 JSON (超限时 _readJson 已回 413) → 抽取消息文本与会话键。
  //   任一步失败时响应已写出, 返回 null, 调用方统一 `return true`。
  async _readChatRequest(req, res) {
    if (!this._requireAuth(req, res)) return null;
    const data = await this._readJson(req, res);
    if (data === null) return null;
    const text = data.message || data.text || "";
    if (!text) { this._json(res, 400, { error: "缺少 message 字段" }); return null; }
    return { text, sessionKey: data.sessionId || "default" };
  }

  // 简单并发护栏: 用计数信号量限制同时处理的对话请求, 超出立即 429
  // 防止多个慢请求无限叠加占用单线程主 agent (可选的背压层, 区别于每 IP 令牌桶限流)
  _acquire(res) {
    if (this._inFlight >= MAX_INFLIGHT) {
      this._json(res, 429, { error: "并发请求过多, 请稍后重试" }, { "Retry-After": "5" });
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
      // 2026-10-31 安全默认: 未配置 = same-origin 严格模式 (此前默认 *, 恶意网页可跨源读
      //   本地 API 响应)。显式放开仍支持: "*" / [] / 白名单数组 —— 旧配置写法全兼容。
      if (c === undefined || c === null) { this.corsStrictSameOrigin = true; return []; }
      // 2026-10-24: "same-origin" 严格模式开关 (不进白名单逻辑)
      if (c === "same-origin" || c === "strict") { this.corsStrictSameOrigin = true; return []; }
      if (c === "*" || (Array.isArray(c) && c.length === 0)) return []; // 显式选择放行任意来源
      if (Array.isArray(c)) return c.filter(Boolean);
      if (typeof c === "string") return [c];
    } catch { /* 配置异常回退默认 */ }
    // 配置异常 → 按最保守处理 (fail-closed)
    this.corsStrictSameOrigin = true;
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

  // 可信本地请求 = 回环地址 + 回环 Host + 可信来源 (下发 token 的唯一条件)
  // 2026-10-10 安全修复 (S7): 追加 Host 头回环校验, 堵 DNS rebinding。
  //   攻击形态: evil.test 解析到 127.0.0.1, 浏览器把它当同源 → 请求 remoteAddress 是回环、
  //   Origin 头缺失 (同源导航), 两道旧判据全部通过, token 被读走。
  //   唯一破绽在 Host 头 —— 它始终是攻击者的域名, 因此必须要求 Host 也是回环名。
  _hostTrusted(req) {
    const raw = String(req.headers?.host || "").trim();
    // 无 Host = 非浏览器客户端 (curl/脚本) 或同源顶层导航 —— P0-1 契约里这类请求本就视为可信
    //   (它们不带 Origin, 也无法被恶意页面驱动)。而真正的 DNS rebinding 一定经浏览器发出,
    //   Host 头恒为攻击者域名 → 下面那道"Host 必须回环"的判据即可拦住, 无需靠 missing-Host 兜底。
    if (!raw) return true;
    // 去端口 + 去 IPv6 方括号
    let host = raw;
    const v6 = raw.match(/^\[([^\]]+)\]:?\d*$/);
    if (v6) host = v6[1];
    else host = raw.replace(/:\d+$/, "");
    host = host.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }

  _isTrustedLocal(req) {
    return this._isLoopback(req) && this._hostTrusted(req) && this._originTrusted(req);
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
    // 2026-10-10: 设置面板三项死绑定根因 —— 前端读 model/toolsCount/root 却从未下发, 补上。
    let model = "";
    try {
      model = (this.agent?.llm?.model) || (this.agent?.config?.providers?.[0]?.model) || "";
    } catch { /* 取不到就留空 */ }
    let toolsCount = 0;
    try {
      toolsCount = typeof this.agent?.tools?.list === "function" ? this.agent.tools.list().length : 0;
    } catch { /* 取不到就留 0 */ }
    return {
      app: "ppxans-harness",
      version: this._pkgVersion(),
      agent: (this.agent?.config?.agent?.name) || "皮皮虾",
      user: (this.agent?.config?.user?.name) || "",
      model,
      toolsCount,
      root: this.agent?.root || process.cwd(),
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

  // 读取首页 HTML 并注入引导数据 (找不到文件返回 null)
  //
  // 2026-10-27 修: 此前注入的是 <script>window.__PPX_BOOTSTRAP__={...}</script> ——
  // 那是页面上第二个可执行内联脚本, 内容含时间戳, 哈希每次都变, 必然被 CSP 拦掉
  // (script-src 只白名单了首屏主题脚本那一个 sha256)。表现是浏览器里
  // window.__PPX_BOOTSTRAP__ 恒为 undefined, 所有 /api/* 先吃一次 401, 靠 app.js 的
  // 401 兜底再取一遍才恢复 —— 这条路一直是瘸的, 只是被兜底盖住了。
  // 改成 type="application/json" 数据节点: 不可执行, 不受 script-src 约束, 前端 JSON.parse 读取。
  renderIndex(req) {
    const htmlPath = path.join(this.publicDir, "index.html");
    if (!fs.existsSync(htmlPath)) return null;
    let html = fs.readFileSync(htmlPath, "utf8");
    const cfg = JSON.stringify(this.bootstrapPayload(req)).replace(/</g, "\\u003c");
    const tag = `<script type="application/json" id="ppx-boot">${cfg}</script>`;
    // 优先插在 </head> 前; 模板没有 head 就退化为插到 </body> 前
    if (html.includes("</head>")) html = html.replace("</head>", `${tag}\n</head>`);
    else if (html.includes("</body>")) html = html.replace("</body>", `${tag}\n</body>`);
    else html = tag + html;
    return html;
  }

  _tokenFromConfig() {
    try {
      const cfg = readPpxConfig(this.agent.root, {});
      return (cfg.channels && cfg.channels.http && cfg.channels.http.auth_token) || "";
    } catch {}
    return "";
  }

  // 若未配置 token: 复用持久化文件(重启不变)或自动生成并原子落盘 (类似 Jupyter token)
  // 2026-10-30: 非 TTY (Electron/服务重定向日志) 不再把完整 token 打进日志 ——
  //   桌面壳会把子进程 stdout 落盘, 日志文件常被同步/上报, 长效凭据不该以明文扩散。
  //   交互式终端仍打印完整值 (否则用户没法复制); 需要脚本取值请直接读持久化文件。
  _ensureToken() {
    if (this.authToken) return this.authToken;
    const r = resolveAuthToken({ configured: process.env.PPX_AUTH_TOKEN || "", persistedFile: this._persistedTokenFile });
    this.authToken = r.token;
    if (r.source === "persisted") {
      console.log("  ℹ  HTTP 认证 token 复用自持久化文件 (重启不更换, 前端无需重贴)");
    } else {
      const showFull = !!(process.stdout && process.stdout.isTTY) || process.env.PPX_SHOW_AUTH_TOKEN === "1";
      const shown = showFull ? this.authToken : `*** (已隐藏, 长度 ${this.authToken.length}; 完整值见持久化文件)`;
      console.log("");
      console.log("  ⚠️  HTTP 认证 token 未配置, 已自动生成并持久化 (重启复用):");
      console.log(`       PPX_AUTH_TOKEN=${shown}`);
      console.log(`     用法: Authorization: Bearer ${shown}`);
      console.log(`     token 已保存到 ${this._persistedTokenFile}, 重启不再更换`);
      console.log("      (或设置 config/ppx.json 的 channels.http.auth_token; 终端里需要直接查看可加 PPX_SHOW_AUTH_TOKEN=1)");
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
    this._json(res, 429, { error: "请求过于频繁, 请稍后重试" }, { "Retry-After": "60" });
    return false;
  }

  // 读取请求体, 限制大小 (超限写 413 并返回 null)
  async _readBody(req, res) {
    const body = await readBody(req, { maxBytes: MAX_BODY });
    if (body === null) {
      this._json(res, 413, { error: "请求体过大" });
      return null;
    }
    return body;
  }

  // ==================== 路由 ====================

  async connect() {
    this._ensureToken(); // 启动时确保有 token
    this.server = http.createServer((req, res) => this._dispatch(req, res));

    // keep-alive 加固 (2026-10-11 补): Node 默认 keepAliveTimeout 仅 5s, 而浏览器
    // 复用连接的窗口更长。服务端 5s 掐掉空闲连接后, 浏览器复用这条"僵尸连接"发请求
    // 会静默挂死 (表现为界面弹窗/列表永远"加载中…")。调大到 65s 并同步抬高
    // headersTimeout (必须 > keepAliveTimeout, 官方要求)。
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 66_000;

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.connected = true;
    return this;
  }

  // 单入口分发: 安全响应头 → CORS/OPTIONS → MCP 端点 → webhook → 限流 → 业务路由, 最后兜底 404/500
  async _dispatch(req, res) {
    try {
      this._applySecurityHeaders(res);
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
      // (注释一直写着「静态页面不设限」, 但实现一度只豁免了 / 与 /index.html:
      //  单文件页面 (如 1.5MB 量级的展示页) 被限流一次就整块挂不上,
      //  所以把所有静态资源的 GET 一并豁免; /api/* 仍走令牌桶。)
      const isStaticGet = req.method === "GET" && !reqPath.startsWith("/api/") && /\.(html|js|mjs|css|json|png|jpe?g|webp|gif|svg|ico|woff2|map)$/i.test(reqPath);
      const isOpenGet = req.method === "GET" && (reqPath === "/" || reqPath === "/index.html" || reqPath === "/health");
      if (!isOpenGet && !isStaticGet && !this._rateLimit(req, res)) return;

      // v2.6.0 REST 退役开关: /message* /sessions* /reset 与 /api/* 同受 mcp.legacy_rest 控制
      // (默认开启以兼容旧脚本/前端; 退役请显式配置 legacy_rest: false → 统一 410 引导 /mcp)
      if (!this.mcpLegacyRest && LEGACY_REST_PATHS.some((p) => reqPath === p || reqPath.startsWith(p + "/"))) {
        return this._json(res, 410, { error: "REST 端点已退役, 请使用标准 MCP 端点 POST /mcp (channels.http.mcp.legacy_rest=true 可恢复)" });
      }

      if (await this._route(req, res, reqPath)) return;
      res.writeHead(404); res.end("未找到");
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

  // 统一安全响应头 (2026-10-25): 在任何 writeHead 之前 set, 对静态页/API/SSE/MCP 全部生效。
  //   nosniff 防 MIME 嗅探; DENY 防点击劫持; no-referrer 防 token 进 Referer;
  //   CSP 见 SECURITY_CSP 常量注释。API/JSON 响应带 CSP 无副作用。
  _applySecurityHeaders(res) {
    try {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", SECURITY_CSP);
    } catch { /* 头已发送等场景: 不因安全头炸主链路 */ }
  }

  // 统一 CORS 响应头 (所有路由含 /mcp 共用)。返回 false 表示本次请求无需继续 (已响应或来源被拒)。
  // v1.0.7 语义: 默认 * (兼容); 配置 cors_origin 白名单时校验浏览器来源
  // 2026-10-24: cors_origin: "same-origin" 严格模式 —— 敏感部署 (token 受限/公网暴露面) 用:
  //   带跨源 Origin 头的请求一律 403 (同源导航与 curl 等非浏览器请求无 Origin, 不受影响)。
  _applyCors(req, res) {
    const reqOrigin = req.headers.origin;
    if (this.corsStrictSameOrigin) {
      if (reqOrigin && !this._originTrusted(req)) {
        this._json(res, 403, { error: "跨域来源不被信任 (same-origin 模式)" });
        return false;
      }
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return false; }
      return true;
    }
    let allowOrigin = "*";
    if (this.corsOrigins.length) {
      allowOrigin = !reqOrigin ? "*" : (this.corsOrigins.includes(reqOrigin) ? reqOrigin : null);
    }
    if (!allowOrigin) {
      this._json(res, 403, { error: "跨域来源不被信任" });
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
    if (this._routeEvents(req, res, get, reqPath)) return true;
    if (this._routeEventsTicket(req, res, post, reqPath)) return true;
    if (await this._routeChat(req, res, post, reqPath)) return true;
    if (await this._routeSessions(req, res, get, post, reqPath)) return true;

    // 静态界面三态: undefined = 不匹配, true/false = 已匹配且该值即路由结果
    const stat = this._routeStatic(req, res, get, reqPath);
    if (stat !== undefined) return stat;

    // API 门禁 (REST 退役开关 + 鉴权); 返回 true 表示已拦下并写响应
    if (this._gateApi(req, res, reqPath)) return true;
    return this._apiRoute(req, res, reqPath);
  }

  // ---- 路由域 1.5: SSE 事件流 (/events) ----
  // 鉴权 (token 查询参数 或 单次 ticket) + 主动提醒广播 + EQ 结构化事件桥接。
  // 2026-10-10 补齐: 此前 /events 从未实现 —— send() 是 no-op, 协议总线 EQ 零消费者。
  // 2026-10-24: 支持 ticket 参数 —— EventSource 无法带 Authorization 头, 旧方案把长效
  //   token 放 URL query 易进访问日志/Referer。新方案: 先 POST /events-ticket (bearer 鉴权)
  //   换 60 秒一次性 ticket, SSE 用 ticket 连接。token query 保留兼容旧客户端。
  _routeEvents(req, res, get, reqPath) {
    if (!get || reqPath !== "/events") return false;
    // 鉴权: 无 token 或 token 不匹配 → 401 (拒绝不得返 200)
    if (!this.authToken) return this._json(res, 401, { error: "未配置鉴权 token" }), true;
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const qToken = u.searchParams.get("token");
    const qTicket = u.searchParams.get("ticket");
    let authed = false;
    if (qTicket) {
      authed = this._consumeEventsTicket(qTicket);
      if (!authed) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ticket 无效/过期/已使用" }));
        return true;
      }
    } else if (qToken && safeEqual(qToken, this.authToken)) {
      authed = true;
    }
    if (!authed) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "鉴权失败" }));
      return true;
    }
    // 建 SSE 流并登记
    res.writeHead(200, SSE_HEADERS);
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    this._sseClients.add(res);
    // 订阅 EQ 结构化事件 → 桥接为 SSE 事件 (协议总线不再零消费者)
    const onEq = (ev) => {
      try { res.write(`data: ${JSON.stringify({ type: ev.type, payload: ev.payload })}\n\n`); } catch { /* 客户端已断 */ }
    };
    this.agent?.protocolBus?.eq?.subscribe?.(onEq);
    req.on("close", () => {
      this._sseClients.delete(res);
    });
    return true;
  }

  // ---- SSE ticket 签发 (POST /events-ticket, bearer 鉴权) ----
  // 60 秒一次性: 换取后只能连一次 /events?ticket=...。泄露面从"长效 token 进 URL"缩到
  // "60 秒单次凭据进 URL"。挂靠 /events 同域 (不经 /api/* 门禁, REST 退役开关不影响)。
  _routeEventsTicket(req, res, post, reqPath) {
    if (!post || reqPath !== "/events-ticket") return false;
    if (!this._requireAuth(req, res)) return true;
    const ticket = crypto.randomBytes(24).toString("hex");
    this._eventsTickets.set(ticket, Date.now() + 60000);
    this._sweepEventsTickets();
    this._json(res, 200, { ticket, expires_in: 60 });
    return true;
  }

  // 消费 ticket: 一次性 (取出即删), 过期无效
  _consumeEventsTicket(ticket) {
    if (!ticket || !this._eventsTickets.has(ticket)) return false;
    const exp = this._eventsTickets.get(ticket);
    this._eventsTickets.delete(ticket);
    return Date.now() <= exp;
  }

  _sweepEventsTickets() {
    const now = Date.now();
    for (const [t, exp] of this._eventsTickets) {
      if (now > exp) this._eventsTickets.delete(t);
    }
  }

  // 向所有 /events 客户端广播一条 SSE 事件
  _broadcastSse(type, payload) {
    const line = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
    for (const res of this._sseClients) {
      try { res.write(line); } catch { this._sseClients.delete(res); }
    }
  }

  // ---- 路由域 1: 健康检查 ----
  _routeHealth(req, res, get, reqPath) {
    if (!get || reqPath !== "/health") return false;
    // 桌面壳握手: 只对携带挑战且进程内有 PPX_DESKTOP_SECRET 时回 HMAC 证明,
    // 防止本机其他服务冒充 /health 被桌面端当成自己的内核接入 (2026-10-30)。
    const headers = {};
    const challenge = req.headers["x-ppx-desktop-challenge"];
    const secret = process.env.PPX_DESKTOP_SECRET;
    if (challenge && secret) {
      headers["x-ppx-desktop-proof"] = crypto.createHmac("sha256", secret).update(String(challenge)).digest("hex");
    }
    this._json(res, 200, {
      status: "ok",
      agent: this.agent.config.agent?.name || "ppx",
      app: "ppxans-harness",
      version: this._pkgVersion(),
      web: "/",
      mcp: this.mcpEnabled ? this.mcpPath : null,
      uptime_ms: Math.round(process.uptime() * 1000),
      // 协议总线条观测 (2026-10-25 SQ 真实化): SQ 积压 op 数 + EQ 事件序号水位。
      //   sqPending 持续上涨 = 有轮次只提交不收口 (死轮泄漏), 是队列健康度的直接信号。
      protocol: typeof this.agent?.protocolStats === "function" ? this.agent.protocolStats() : undefined,
    }, headers);
    return true;
  }

  // ---- 路由域 2: 对话 (POST /message 与 SSE 流式) ----

  // 2026-10-11: 最近一次 LLM usage 快照 → 前端底部状态条 (上下文长度/缓存命中)。
  //   兼容 DeepSeek 专属字段 (prompt_cache_hit_tokens/prompt_cache_miss_tokens) 与
  //   OpenAI 形态 (prompt_tokens_details.cached_tokens); 无缓存字段时 cacheHitPct 为 null。
  _usageSnapshot() {
    const u = this.agent?.lastUsage;
    if (!u) return null;
    const prompt = Number(u.prompt_tokens) || 0;
    const completion = Number(u.completion_tokens) || 0;
    const cacheHit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null;
    const cacheMiss = u.prompt_cache_miss_tokens ?? null;
    const cacheHitPct = (cacheHit != null && prompt > 0) ? Math.round((cacheHit / prompt) * 100) : null;
    return {
      prompt,
      completion,
      total: Number(u.total_tokens) || prompt + completion,
      cacheHit,
      cacheMiss,
      cacheHitPct,
    };
  }

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
        this._json(res, 200, { reply, sessionId: sessionKey, agent: this.agent.config.agent?.name || "ppx", tokens: this._usageSnapshot() });
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
      let onApproval = null; // (R13) 审批 sink, finally 里摘除 (作用域须在 try 外)
      try {
        const send = (obj) => { if (!res.writableEnded) res.write("data: " + JSON.stringify(obj) + "\n\n"); };
        // 2026-10-24 (R13 审批闭环): 流式通道接线审批事件 —— agent._requestApproval 此前
        //   只推 EQ (/events 桥, 前端未订阅) + 轮询兜底 (仅流结束后跑), 正在等待审批的
        //   这条流自己从不发 approval 事件 → UI 审批卡片在等待期内不出现, 只能干等
        //   120s 超时被拒 (真浏览器 E2E 实锤)。现每条流注册一个审批 sink, agent 的
        //   _onApprovalEvent 广播给全部活跃 sink (跨会话可见性与 pollApprovals 一致)。
        const approvalSinks = this._ensureApprovalSinks();
        onApproval = (a) => { try { send({ type: "approval", id: a.id, kind: a.kind, tool: a.tool, args: a.args, summary: a.summary, reason: a.reason }); } catch {} };
        approvalSinks.add(onApproval);
        let full = "";
        const reply = await this.agent.chatStream(String(text), {
          sessionKey,
          onDelta: (d) => { full += d; try { send({ type: "delta", content: d }); } catch {} },
          onTool: (ev) => { try { send({ type: "tool", tool: ev.tool, id: ev.id, status: ev.type, args: ev.args, ok: ev.ok, durationMs: ev.durationMs }); } catch {} }, // 工具调用可视化
          onStep: (ev) => { try { send({ type: "step", round: ev.round, maxRounds: ev.maxRounds }); } catch {} }, // turn/step 推理轮次进度
        });
        const finalContent = full || reply;
        send({ type: "done", content: finalContent, sessionId: sessionKey, tokens: this._usageSnapshot() });
        if (!res.writableEnded) res.end();
      } catch (e) {
        // 不外泄内部实现细节 (如 ERR_HTTP_HEADERS_SENT 之类)
        try { res.write("data: " + JSON.stringify({ type: "error", error: publicErrorMessage(e) }) + "\n\n"); } catch {}
        try { res.end(); } catch {}
      } finally {
        try { this._approvalSinks?.delete(onApproval); } catch {}
        this._release();
      }
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
    // 2026-10-11: 会话标题覆盖 { key, title } — 改名不改内容/归属/排序 (list 已优先读覆盖标题)
    if (post && reqPath === "/sessions/title") {
      if (!this._requireAuth(req, res)) return true;
      const data = await this._readJson(req, res);
      if (data === null) return true;
      const store = this.agent.sessionStore;
      if (!store || typeof store.setTitle !== "function") { this._json(res, 501, { ok: false, error: "会话存储不支持标题" }); return true; }
      const key = String(data?.key || "");
      if (!key) { this._json(res, 400, { ok: false, error: "缺少 key" }); return true; }
      const ok = store.setTitle(key, data?.title);
      this._json(res, ok ? 200 : 404, { ok });
      return true;
    }
    // 2026-10-11: 会话归档/恢复 { key, archived: true|false } — 不删数据, 仅打标记 (自动归档的手动对偶)
    if (post && reqPath === "/sessions/archive") {
      if (!this._requireAuth(req, res)) return true;
      const data = await this._readJson(req, res);
      if (data === null) return true;
      const store = this.agent.sessionStore;
      if (!store || typeof store.archive !== "function") { this._json(res, 501, { ok: false, error: "会话存储不支持归档" }); return true; }
      const key = String(data?.key || "");
      if (!key) { this._json(res, 400, { ok: false, error: "缺少 key" }); return true; }
      const ok = data?.archived === false ? store.unarchive(key) : store.archive(key);
      this._json(res, ok ? 200 : 404, { ok });
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
      // 2026-10-09 二次修复 (缺陷 #2 回归): 前端 delSession 发的是 { sessionKey }, 后端读 data.key
      //   → 仍恒为 undefined → 仍兜底删掉 default 主会话。同一缺陷以"字段名不对齐"的形式复发。
      //   两处一起改: 后端同时接受 key / sessionKey, 且【缺字段时拒绝而不是兜底 default】——
      //   兜底才是误删的根因, 宁可 400 也不要静默删掉用户的主会话。
      //   契约由 test/session-api-contract.test.js 锁死, 防第三次复发。
      const data = await this._readJson(req, res);
      if (data === null) return true;
      const delKey = data.key || data.sessionKey;
      if (!delKey) {
        this._json(res, 400, { ok: false, error: "缺少 key (会话标识不能为空, 拒绝兜底删除 default)" });
        return true;
      }
      if (this.agent.sessionStore) this.agent.sessionStore.delete(delKey);
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
    // 上传图片回显: /uploads/<file> → <root>/uploads/ (与 public/ 同为只读静态;
    // 服务默认只绑 127.0.0.1, 风险面与 public/ 一致; 文件名已在写入时消毒)
    if (reqPath.startsWith("/uploads/")) {
      const upDir = path.resolve(this.agent.root, "uploads");
      // 中文/空格文件名在 URL 里是百分号编码, 必须解码后再拼路径 (2026-10-11 修复: 中文附件回显 404)
      let rel = "";
      try { rel = decodeURIComponent(reqPath.replace(/^\/uploads\//, "")); } catch { rel = ""; }
      const file = path.resolve(upDir, rel);
      if (rel && file.startsWith(upDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" }[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
        res.end(fs.readFileSync(file));
        return true;
      }
      return false;
    }
    if (!reqPath.startsWith("/api/") && !LEGACY_REST_PATHS.some((p) => reqPath === p)) {
      return this._serveStatic(res, reqPath);
    }
    return undefined;
  }

  // ---- API 门禁: REST 退役开关 + 鉴权。返回 true = 已写响应 (路由结束), false = 放行到具体 API 路由 ----
  // channels.http.mcp.legacy_rest = true (默认) 时保留旧 /api/* REST 端点 (兼容旧脚本/客户端);
  // 显式设为 false 时 /api/* 返回 410 Gone, 引导使用标准 MCP 端点 /mcp
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
    // 2026-10-27: 本体 (bot) 形态接口 —— /api/bot.state 聚合首屏快照, /api/bot.manage 单入口写
    // 必须排在 switch 之前: 这几个路径不在 case 表里, 落到 default 会 404
    if (await handleBotApi(this, req, res, reqPath)) return true;
    // 2026-10-30: 用户插件管理 (列表/详情/创建/更新/启停/删除)
    if (await handlePluginApi(this, req, res, reqPath)) return true;
    // 2026-10-31: 「使用统计」页 —— 按天 token 账本 + 会话时长 + 连续天数
    if (await handleUsageStatsApi(this, req, res, reqPath)) return true;
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
      // 厂商预设库 (只读): 让前端"选厂商 → 自动带出 base_url / 常用模型 / 环境变量名 / 申请地址"
      // 纯静态数据, 不碰磁盘配置, 因此不涉及写权限
      case "/api/providers/presets":
        if (!get) return false;
        if (!this._requireAuth(req, res)) return true;
        this._json(res, 200, { presets: listPresets() });
        return true;
      // 健康探测 (body: { id }), 复用 LLMClient.health()
      case "/api/providers/test":
        if (req.method !== "POST") return false;
        return this._apiProviderTest(req, res);
      // 重排 (body: { order: [id1, id2, ...] })
      case "/api/providers/reorder":
        if (req.method !== "POST") return false;
        return this._apiProviderReorder(req, res);
      // 2026-10-24 (R16): 分层路由 (aux 辅助模型 + local/cloud 优先序) 读写
      case "/api/routing":
        return this._apiRouting(req, res);
      // 2026-10-24 (R16): per-provider 用量 (usageStats.byModel 按模型→提供方聚合)
      case "/api/providers/usage":
        if (!get) return false;
        return this._apiProviderUsage(req, res);
      // 2026-10-30: 最近一次生成运行态 + 用量快照 + 累计用量 —— 供 Web 底部状态条常驻显示
      //   (刷新后不丢, 不必等下一次生成才有数; 此前这套数只在内存算, 刷新即消失)。
      case "/api/run.state":
        if (!get) return false;
        return this._apiRunState(req, res);

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

      // 文件上传 (Web UI 附件): JSON { name, data(base64) } → 存 <root>/uploads/ → 返回相对路径。
      //   图片: 路径拼进消息后 visionUserContent 会自动注入多模态 (8MB 上限, 防 base64 撑爆上下文);
      //   其他文件 (pdf/docx/zip/代码等): 路径进消息文本, agent 用 read_document/read_file 等工具读取 (20MB 上限)。
      case "/api/upload": {
        if (req.method !== "POST") return false;
        const body = await readBody(req, { maxBytes: 28 * 1024 * 1024 }); // base64 ≈ 4/3 原体积
        if (body === null) { this._json(res, 413, { error: "文件过大 (上限 20MB)" }); return true; }
        try {
          const p = JSON.parse(body || "{}");
          const name = String(p.name || "file.bin").replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_").slice(-80) || "file.bin";
          const ext = path.extname(name).toLowerCase();
          const isImg = /^\.(png|jpe?g|gif|webp|bmp)$/.test(ext);
          const b64 = String(p.data || "").replace(/^data:[^,]*,/, "");
          const buf = Buffer.from(b64, "base64");
          const limit = isImg ? 8 * 1024 * 1024 : 20 * 1024 * 1024;
          if (!buf.length) { this._json(res, 400, { error: "文件为空" }); return true; }
          if (buf.length > limit) {
            this._json(res, 413, { error: (isImg ? "图片" : "文件") + "过大 (上限 " + (isImg ? 8 : 20) + "MB)" });
            return true;
          }
          const dir = path.join(this.agent.root, "uploads");
          ensureDir(dir);
          // 防覆盖: 同名追加序号
          let file = path.join(dir, name);
          if (fs.existsSync(file)) {
            const stem = name.slice(0, -ext.length) || name;
            let i = 1;
            while (fs.existsSync(file)) file = path.join(dir, `${stem}-${i++}${ext}`);
          }
          fs.writeFileSync(file, buf);
          const rel = "uploads/" + path.basename(file);
          this._json(res, 200, { ok: true, path: rel, bytes: buf.length, kind: isImg ? "image" : "file" });
        } catch (e) { this._fail(res, e, 400); }
        return true;
      }

      // LLM 运行时切换 (Web UI 模型胶囊 / 思考强度滑杆):
      //   GET  → 现状 + 候选 provider 列表 + 语音能力状态
      //   POST → { provider?, reasoning? } 写 config.llm 并热重载 LLM 客户端
      case "/api/llm":
        return this._apiLlm(req, res);

      // 语音输入: 状态查询 + 音频转写 (复用 tools/voice.js 的云端 ASR)
      case "/api/voice/status":
        if (!get) return false;
        this._json(res, 200, { ok: true, ...voiceStatus(this.agent.config || {}) });
        return true;
      case "/api/voice/transcribe":
        if (req.method !== "POST") return false;
        return this._apiVoiceTranscribe(req, res);

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
    res.end("未找到");
    return true;
  }

  // 任务面板 (HTTP /api/tasks) 用的 TaskBoard: 懒建 + 复用同一份实例 (与 MCP 工具共享落盘文件)
  _taskBoard(agent) {
    // (R17) 与 /task 命令共享 agent 级实例 —— 此前 HTTP/MCP 各自懒建,
    // 落盘同文件但内存双份 (操作互相覆盖); 现在三方 (命令/REST/MCP) 同源。
    if (typeof agent.getTaskBoard === "function") return agent.getTaskBoard();
    if (!this._taskBoardInst) this._taskBoardInst = createTaskBoard(path.resolve(agent.root));
    return this._taskBoardInst;
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
    // POST /api/review/run — 审查按钮打真 API (与 review_code 工具同一 runReview 收口)
    if (req.method === "POST" && reqPath === "/api/review/run") {
      const body = await this._readBody(req, res);
      if (body === null) return true;
      try {
        const p = JSON.parse(body || "{}");
        const out = runReview({ files: Array.isArray(p.files) ? p.files : [], diff: p.diff || null });
        agent._lastReview = { issues: out.issues, report: out.report, ts: Date.now() };
        this._json(res, 200, { ok: true, total: out.issues.length, issues: out.issues, report: out.report });
      } catch (e) {
        this._fail(res, e);
      }
      return true;
    }
    // POST /api/goalboard — 目标看板可写 { op: "add" | "update", ... } (与 goal_board 工具同一 store)
    if (req.method === "POST" && reqPath === "/api/goalboard") {
      const body = await this._readBody(req, res);
      if (body === null) return true;
      const board = agent.goalBoard;
      if (!board) { this._json(res, 503, { ok: false, error: "目标看板未装配" }); return true; }
      try {
        const p = JSON.parse(body || "{}");
        let goal = null;
        if (p.op === "add") goal = board.addGoal({ id: p.id, title: p.title, priority: p.priority, status: p.status, budget: p.budget, spent: p.spent, nextReviewAt: p.next_review_at ?? p.nextReviewAt });
        else if (p.op === "update") goal = board.updateGoal(p.id, { title: p.title, priority: p.priority, status: p.status, budget: p.budget, spent: p.spent, nextReviewAt: p.next_review_at ?? p.nextReviewAt });
        else { this._json(res, 400, { ok: false, error: `未知 op: ${p.op}` }); return true; }
        if (!goal) { this._json(res, 404, { ok: false, error: "目标不存在" }); return true; }
        this._json(res, 200, { ok: true, goal, goals: board.list() });
      } catch (e) {
        this._json(res, 400, { ok: false, error: publicErrorMessage(e) }); // 非法优先级/状态 → 4xx (store 层校验)
      }
      return true;
    }
    // GET /api/tasks — 任务面板只读列表 (复用 MCP 同一份 TaskBoard)
    if (get && reqPath === "/api/tasks") {
      try {
        const { tasks, counts } = this._taskBoard(agent).list();
        this._json(res, 200, { ok: true, tasks, counts });
      } catch (e) { this._fail(res, e); }
      return true;
    }
    // POST /api/tasks — 任务面板写 { op: create | step | update | complete | delete, ... }
    if (req.method === "POST" && reqPath === "/api/tasks") {
      const body = await this._readBody(req, res);
      if (body === null) return true;
      const board = this._taskBoard(agent);
      try {
        const p = JSON.parse(body || "{}");
        let task = null;
        switch (p.op) {
          case "create": task = board.create({ title: p.title, description: p.description, steps: p.steps }); break;
          case "step": board.step({ id: p.id, index: p.index, status: p.status, detail: p.detail }); task = board.get(p.id); break;
          case "update": task = board.update({ id: p.id, status: p.status, title: p.title, description: p.description }); break;
          case "complete": task = board.complete(p.id, p.result); break;
          case "delete": board.delete({ id: p.id }); {
            const l = board.list();
            this._json(res, 200, { ok: true, task: null, tasks: l.tasks, counts: l.counts });
            return true;
          }
          default: this._json(res, 400, { ok: false, error: `未知 op: ${p.op}` }); return true;
        }
        const l = board.list();
        this._json(res, 200, { ok: true, task, tasks: l.tasks, counts: l.counts });
      } catch (e) {
        this._json(res, 400, { ok: false, error: publicErrorMessage(e) });
      }
      return true;
    }
    // POST /api/workspace/write — 写工作区文件 (Web UI 落盘; 越界路径 → 4xx)
    if (req.method === "POST" && reqPath === "/api/workspace/write") {
      const body = await this._readBody(req, res);
      if (body === null) return true;
      try {
        const p = JSON.parse(body || "{}");
        const out = writeWorkspaceFile(path.resolve(agent.root), p.path, p.content);
        this._json(res, 200, { ok: true, ...out });
      } catch (e) {
        this._json(res, 400, { ok: false, error: publicErrorMessage(e) });
      }
      return true;
    }
    // GET /api/workspace/search — 工作区文件/内容搜索 (Web UI 文件定位)
    if (get && reqPath === "/api/workspace/search") {
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        const out = searchWorkspace(path.resolve(agent.root), u.searchParams.get("q") || "");
        this._json(res, 200, { ok: true, ...out });
      } catch (e) {
        this._fail(res, e);
      }
      return true;
    }
    // GET /api/permissions — 读取当前权限状态 (2026-10-09 补)
    // 此前只有 POST(写), 前端设置面板想显示"当前审批模式/沙箱"只能去 /api/bootstrap 里找,
    // 而 bootstrap 根本没有这两个字段 → 下拉框恒空。补一个 GET 让读取有正规来源。
    if (req.method === "GET" && reqPath === "/api/permissions") {
      if (!agent.permissions) { this._json(res, 200, { ok: false, reason: "权限引擎未装配" }); return true; }
      this._json(res, 200, {
        ok: true,
        approvalMode: agent.permissions.approvalMode,
        sandbox: agent.permissions.sandbox,
        networkAccess: agent.permissions.networkAccess,
        planEnabled: agent.permissions.planEnabled,
        planSessions: agent.planModeSessions(),
      });
      return true;
    }

    // POST /api/permissions — 权限热更新 { approvalMode?, sandbox?, networkAccess?, planEnabled?, sessionKey?, confirm_token? }
    // 2026-10-31 安全收紧: 放宽类变更 (审批模式放宽 / 沙箱升档 / 打开网络) 需要**二次确认**。
    //   第一次请求返回 { ok:false, need_confirm:true } 并把一次性确认码打到**服务端控制台**;
    //   60 秒内携带 confirm_token 重新提交才生效。确认码只进控制台、不进 HTTP 响应 ——
    //   即使 bearer token 被提示注入的 agent 偷到, 它也无法自行完成提权闭环 (必须有人在场)。
    //   收紧类变更 (降档) 与 plan 会话态切换不受影响; 生效全部只动内存引擎, 不写配置文件 (重启还原)。
    if (req.method === "POST" && reqPath === "/api/permissions") {
      const body = await this._readBody(req, res);
      if (body === null) return true;
      if (!agent.permissions) { this._json(res, 200, { ok: false, reason: "权限引擎未装配" }); return true; }
      let cfg = {};
      try { cfg = JSON.parse(body || "{}"); } catch {}

      // 值合法性先卡 (此前任意字符串直写引擎, 打错字=静默无效果): fail-closed
      // 2026-10-31: rank 表与放宽识别抽到 permissions/index.js —— /api/bot.manage 的
      //   permission 动作必须共用同一套判定, 否则它就是双门的旁路。
      if (cfg.approvalMode != null && APPROVAL_RANK[cfg.approvalMode] == null) {
        this._json(res, 400, { ok: false, error: `approvalMode 非法: ${cfg.approvalMode} (合法: ${Object.keys(APPROVAL_RANK).join("/")})` });
        return true;
      }
      if (cfg.sandbox != null && SANDBOX_RANK[cfg.sandbox] == null) {
        this._json(res, 400, { ok: false, error: `sandbox 非法: ${cfg.sandbox} (合法: ${Object.keys(SANDBOX_RANK).join("/")})` });
        return true;
      }

      // 凭码路径优先: 确认请求携带的可能是**收紧值** (确认的是"最初发起的放宽", 而非本次字段),
      //   因此必须先查确认码, 再谈放宽识别 —— 否则凭码请求被当成即时收紧绕过暂存变更。
      const pending = this._permConfirm;
      const supplied = String(cfg.confirm_token || "").trim();
      if (supplied) {
        if (pending && pending.expires > Date.now()
          && pending.token.length === supplied.length
          && crypto.timingSafeEqual(Buffer.from(pending.token), Buffer.from(supplied))) {
          this._permConfirm = null;
          try { agent.tracer?.event?.("security/permission-escalated", { changes: pending.escalations, via: "http" }); } catch { /* 可观测失败不阻断 */ }
          // 落地用最初暂存的变更 (确认对象 = 发起时的请求, 防确认间隙偷换参数)
          const apply = pending.cfg;
          if (apply.approvalMode) agent.permissions.approvalMode = apply.approvalMode;
          if (apply.sandbox) agent.permissions.sandbox = apply.sandbox;
          if (apply.networkAccess != null) agent.permissions.networkAccess = !!apply.networkAccess;
          if (apply.planEnabled != null && !apply.sessionKey) agent.permissions.planEnabled = !!apply.planEnabled;
          this._json(res, 200, {
            ok: true,
            confirmed: true,
            approvalMode: agent.permissions.approvalMode,
            sandbox: agent.permissions.sandbox,
            networkAccess: agent.permissions.networkAccess,
            planEnabled: agent.permissions.planEnabled,
            planSessions: agent.planModeSessions(),
          });
          return true;
        }
        // 带码但错误/过期/无暂存: 不提示具体原因 (防枚举), 让发起方重新走一遍
        this._json(res, 403, { ok: false, error: "确认码无效或已过期, 请重新发起放宽请求" });
        return true;
      }

      // 识别放宽类变更 (新档位 rank 高于当前 = 更放任)
      const escalations = detectEscalations(agent.permissions, cfg);

      if (escalations.length) {
        // 首次请求: 出码 + 打控制台 (唯一可信信道), 不进 HTTP 响应
        const token = crypto.randomBytes(3).toString("hex"); // 6 位, 24bit 熵, 60s 窗口足够
        this._permConfirm = { token, cfg, escalations, expires: Date.now() + 60000 };
        console.log([
          "",
          "⚠️  [权限放宽确认] 检测到提权请求:",
          ...escalations.map((e) => "     " + e),
          `     确认码: ${token}  (60 秒内有效, 一次性)`,
          '     生效方式: POST /api/permissions 携带 { ...原字段, confirm_token: "<确认码>" }',
          "     (收紧类变更无需确认; 放宽只动内存引擎不写配置文件, 重启还原)",
          "",
        ].join("\n"));
        this._json(res, 200, {
          ok: false,
          need_confirm: true,
          escalations,
          expires_in: 60,
          hint: "确认码已输出到服务端控制台, 凭码重新提交方可生效",
        });
        return true;
      }

      // 非放宽变更 (收紧/持平/plan 会话态): 立即生效, 行为与既有完全一致
      if (cfg.approvalMode) agent.permissions.approvalMode = cfg.approvalMode;
      if (cfg.sandbox) agent.permissions.sandbox = cfg.sandbox;
      if (cfg.networkAccess != null) agent.permissions.networkAccess = !!cfg.networkAccess;
      // plan 模式: 带 sessionKey 只动会话态 (与 /plan /do 同一条状态轨道), 不带则动引擎级兜底开关
      if (cfg.planEnabled != null) {
        if (cfg.sessionKey) agent.setPlanMode(cfg.sessionKey, !!cfg.planEnabled);
        else agent.permissions.planEnabled = !!cfg.planEnabled;
      }
      this._json(res, 200, {
        ok: true,
        approvalMode: agent.permissions.approvalMode,
        sandbox: agent.permissions.sandbox,
        networkAccess: agent.permissions.networkAccess,
        planEnabled: agent.permissions.planEnabled,
        planSessions: agent.planModeSessions(),
      });
      return true;
    }
    // GET /api/health/summary — 运行健康聚合 (轨迹成功率/失败/心跳/工具可用性/待审批/用量)
    // 数据源均为现成 (traces.stats + usageStats + lifecycle + tools), 供 Web hero 状态条直读。
    if (get && reqPath === "/api/health/summary") {
      const t = agent.traces && typeof agent.traces.stats === "function" ? agent.traces.stats() : {};
      const u = agent.usageStats || {};
      const tools = agent.tools && typeof agent.tools.listDetailed === "function" ? agent.tools.listDetailed() : [];
      const lc = agent.lifecycleStatus ? agent.lifecycleStatus() : {};
      this._json(res, 200, {
        ok: true,
        uptime_ms: Math.round(process.uptime() * 1000),
        heartbeat_at: new Date().toISOString(),
        traces: { count: t.count || 0, failed: t.failed || 0, failRate: t.failRate || "0%", slowTools: t.slowTools || [] },
        usage: { calls: u.calls || 0, tokens: u.tokens || 0, cost: u.cost || 0 },
        tools: { total: tools.length, enabled: tools.filter((x) => x.enabled).length },
        pending_approvals: agent.pendingApprovals ? agent.pendingApprovals().length : 0,
        lifecycle: lc,
        policy_guard: agent.tools && typeof agent.tools.policyStatus === "function"
          ? agent.tools.policyStatus().filter((s) => s.state && s.state !== "closed") : [],
      });
      return true;
    }
    // GET /api/verify/records — 验收记录: 已验证账本 (Auditor) + 最近任务执行证据 (命令/退出码/耗时)
    // 兑现「执行/验证分离」的可观测: 用户能翻到"测试到底跑没跑、退出码多少、耗时多少"。
    if (get && reqPath === "/api/verify/records") {
      const auditor = agent.auditor;
      const aStats = auditor && typeof auditor.stats === "function" ? auditor.stats() : { total: 0, byKind: {} };
      const ledger = auditor && Array.isArray(auditor.ledger) ? auditor.ledger.slice(-20) : [];
      const traces = agent.traces && typeof agent.traces.read === "function" ? agent.traces.read(undefined, 200) : [];
      const executions = (Array.isArray(traces) ? traces : [])
        .filter((t) => t && /run_command|test|apply_patch|write_file|code_act|review_code/.test(String(t.tool || "")))
        .slice(-40)
        .map((t) => ({
          tool: t.tool, ok: !!t.ok, durationMs: t.durationMs || 0, ts: t.ts || null,
          args: String(t.args || "").slice(0, 160), error: t.error ? String(t.error).slice(0, 160) : null,
        }));
      this._json(res, 200, { ok: true, verification: { total: aStats.total, byKind: aStats.byKind, ledger }, executions });
      return true;
    }
    // GET /api/evolve/status — 自我进化可观测: 进化引擎状态 + 已验证账本 + playbook 现状 (只读)
    // 让「证据不够不出提案」的进化过程不再黑盒 (对照 TheOne 自我进化入口)。
    if (get && reqPath === "/api/evolve/status") {
      const ev = agent.evolve;
      const pb = agent.playbook ? agent.playbook.playbook : null;
      const bullets = pb && Array.isArray(pb.bullets) ? pb.bullets.slice(0, 30).map((b) => ({
        id: b.id, kind: b.kind, content: b.content, counters: b.counters || {}, createdAt: b.createdAt,
      })) : [];
      const auditor = agent.auditor;
      // 2026-10-30: 补 EvolutionLoop (每日编排/代码迭代) 视图 —— 此前只报行为层,
      //   夜间循环跑了什么/闸门状态/适应度规模 全是黑盒
      const loop = agent._evolutionLoop;
      const loopCfg = agent.config?.agent?.evolution_loop || {};
      const iterCfg = agent.config?.agent?.self_iteration || {};
      this._json(res, 200, {
        ok: true,
        evolve: ev ? { enabled: ev.enabled, everyCalls: ev.everyCalls, calls: ev._calls, lastAt: ev._lastAt, minIntervalMs: ev.minIntervalMs } : null,
        evolution_loop: loop ? {
          enabled: !!loopCfg.enabled,
          cron: loopCfg.cron || "03:30",
          running: !!loop.running,
          lastRunAt: loop.lastRunAt || 0,
          rotationCursor: loop._rot || 0,
          fitnessFiles: Array.isArray(iterCfg.target_files) ? iterCfg.target_files.length : 0,
          mode: iterCfg.mode === "apply" ? "apply" : "propose",
          self_code_mode: agent.config?.agent?.self_code?.mode || "propose",
          journal: typeof loop.journalTail === "function" ? loop.journalTail(5) : [],
        } : null,
        verified: auditor && typeof auditor.stats === "function" ? auditor.stats() : { total: 0, byKind: {} },
        playbook: { version: pb ? pb.version : null, total: pb && Array.isArray(pb.bullets) ? pb.bullets.length : 0, bullets },
        experience: agent.experience ? { lessons: (agent.experience.lessons || []).length } : {},
      });
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

  // ---- 2026-10-24 (R16): 分层路由 API ----
  // GET  → { providers: [{id, model, usable}], routing: { aux, preference } }
  // PUT  → { aux: id|null, preference: "local"|"cloud" } 写盘 + 热重载 (config + providers + auxLLM)
  async _apiRouting(req, res) {
    if (!this._requireAuth(req, res)) return true;
    const root = this.agent.root;
    if (req.method === "GET") {
      const provs = readConfig(root).providers.map((p) => ({
        id: p.id, model: p.model, usable: (() => { try { return isUsableProvider(p); } catch { return false; } })(),
      }));
      this._json(res, 200, { providers: provs, routing: readRouting(root) });
      return true;
    }
    if (req.method !== "PUT") return false;
    const body = await this._readBody(req, res);
    if (body === null) return true;
    try {
      const data = JSON.parse(body || "{}");
      const routing = writeRouting(root, { aux: data.aux, preference: data.preference });
      // 热重载: 重建 provider 客户端 (model_preference 影响排序) + 刷新 aux 指针
      this.agent.reloadProviders();
      this.agent._refreshAuxRouting?.();
      this._json(res, 200, { ok: true, routing });
    } catch (e) {
      this._fail(res, e, /不存在|只能是/.test(e.message) ? 400 : 500);
    }
    return true;
  }

  // ---- 2026-10-24 (R16): per-provider 用量 (内存账本 usageStats.byModel 按模型归属聚合) ----
  _apiProviderUsage(req, res) {
    if (!this._requireAuth(req, res)) return true;
    const u = this.agent.usageStats || {};
    const byModel = u.byModel || {};
    const usage = readConfig(this.agent.root).providers.map((p) => {
      const m = byModel[p.model] || {};
      return { id: p.id, model: p.model, calls: m.calls || 0, tokens: m.tokens || 0, cost: m.cost || 0 };
    });
    this._json(res, 200, { usage, total: { calls: u.calls || 0, tokens: u.tokens || 0, cost: u.cost || 0 } });
    return true;
  }

  // 2026-10-30: 最近一次生成运行态 + 用量快照 + 累计用量 (Web 底部状态条常驻数据源)
  //   run  = agent.lastRun { rounds, steps, tokps, at } (本轮生成统计, 见 agent._llmWithTools)
  //   usage = _usageSnapshot() { prompt, completion, total, cacheHit, cacheHitPct } (最近一次 LLM 调用)
  //   context_window = 当前模型上下文窗口 (前端算"上下文占用 %"用, 不依赖 /api/llm 先加载)
  //   totals = 累计用量 { calls, tokens, cacheHitPct } (跑进程被 kill 前已落盘, 重启可恢复)
  _apiRunState(req, res) {
    if (!this._requireAuth(req, res)) return true;
    const run = this.agent?.lastRun || null;
    const usage = this._usageSnapshot();
    const context_window = Number(this.agent?.llm?.context_window) || 0;
    const us = this.agent?.usageStats || {};
    const pt = us.promptTokens || 0;
    const ch = us.cacheHitTokens || 0;
    const cacheHitPct = pt > 0 ? Math.round((ch / pt) * 100) : null;
    const totals = { calls: us.calls || 0, tokens: us.tokens || 0, cost: us.cost || 0, cacheHitPct };
    this._json(res, 200, { run, usage, context_window, totals });
    return true;
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

  // ---- LLM 运行时切换 (模型 / 思考强度) ----
  // 状态视图: 当前实际生效的 provider+model、显式选择、候选列表 (含可用性)、语音能力
  // 当前 provider 的上下文窗口 (表单可配, 兜底 8192) — 供前端算上下文占用百分比
  _llmCtx(provs, providerId) {
    const p = provs.find((x) => x && x.id === providerId);
    return Number(p && p.context_window) || 0;
  }
  _llmState() {
    const cfg = this.agent.config || {};
    const cur = this.agent.llm || null;
    const provs = Array.isArray(cfg.providers) ? cfg.providers : [];
    return {
      provider: cfg.llm?.provider || "",
      reasoning: cfg.llm?.reasoning || "auto",
      reasoning_levels: REASONING_LEVELS,
      current: cur ? { id: cur.providerId, model: cur.model, vision: !!cur.vision, context_window: this._llmCtx(provs, cur.providerId) } : null,
      providers: provs.map((p) => ({
        id: p.id,
        model: p.model || "",
        vision: !!p.vision,
        context_window: Number(p.context_window) || 0,
        usable: isUsableProvider(p),
        current: !!(cur && cur.providerId === p.id),
      })),
      voice: voiceStatus(cfg),
    };
  }

  async _apiLlm(req, res) {
    if (req.method === "GET") {
      this._json(res, 200, { ok: true, ...this._llmState() });
      return true;
    }
    if (req.method !== "POST") { this._json(res, 405, { error: "方法不允许 (GET / POST)" }); return true; }
    const body = await this._readBody(req, res);
    if (body === null) return true;
    try {
      const p = JSON.parse(body || "{}");
      const patch = {};
      if (p.provider !== undefined) patch.provider = String(p.provider || "");
      if (p.reasoning !== undefined) patch.reasoning = String(p.reasoning || "auto");
      if (!Object.keys(patch).length) {
        this._json(res, 400, { error: "缺少可更新字段 (provider / reasoning)" });
        return true;
      }
      updateSettings(this.agent.root, { llm: patch });
      this.agent.reloadProviders(); // 重建 LLM 客户端 (新 provider/思考强度立即生效)
      this._json(res, 200, { ok: true, ...this._llmState() });
    } catch (e) { this._fail(res, e, 400); }
    return true;
  }

  // ---- 语音输入 (Web UI 麦克风): 录音 → 云端 ASR 转写 ----
  // 请求体 JSON { name, data(base64), language? }; 体积上限放宽到 20MB (音频比图片大)
  async _apiVoiceTranscribe(req, res) {
    const raw = await readBody(req, { maxBytes: 20 * 1024 * 1024 });
    if (raw === null) { this._json(res, 413, { error: "音频过大 (上限 20MB)" }); return true; }
    const cfg = this.agent.config || {};
    let tmpPath = "";
    try {
      const p = JSON.parse(raw || "{}");
      const name = String(p.name || "audio.wav").replace(/[^\w.-]+/g, "_").slice(-60) || "audio.wav";
      const ext = (path.extname(name) || ".wav").toLowerCase();
      if (![".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg", ".opus", ".flac"].includes(ext)) {
        this._json(res, 400, { error: "不支持的音频格式 (wav/mp3/m4a/webm/ogg/flac)" });
        return true;
      }
      const buf = Buffer.from(String(p.data || "").replace(/^data:[^,]*,/, ""), "base64");
      if (!buf.length) { this._json(res, 400, { error: "音频为空" }); return true; }

      const cloud = resolveVoice(cfg, "asr");
      if (!cloud) {
        const local = resolveLocalAsr(cfg);
        this._json(res, 400, {
          error: local
            ? "本地 ASR 需外部 whisper 二进制, 未内置; 请改配 config.voice.asr 云端端点"
            : "ASR 未配置: 需在 config/ppx.json 的 voice.asr 设 base_url + api_key (OpenAI 兼容 /audio/transcriptions)",
        });
        return true;
      }
      const dir = path.join(this.agent.root, "uploads");
      ensureDir(dir);
      tmpPath = path.join(dir, `asr-${Date.now()}-${name}`);
      fs.writeFileSync(tmpPath, buf);
      const text = await cloudTranscribe(cloud, tmpPath, p.language || "");
      this._json(res, 200, { ok: true, text: String(text || "").trim() });
    } catch (e) {
      this._fail(res, e, 502);
    } finally {
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* 临时音频清理失败不阻断 */ } }
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

  async send(to, text) {
    // 2026-10-10: send 不再 no-op —— 主动提醒经 SSE 广播到所有 /events 客户端
    this._broadcastSse("reminder", { text: String(text ?? "") });
    return text;
  } // HTTP 是请求-响应, 直接返回

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
    // 2026-10-10: 断开前先掐断所有 SSE 客户端连接 (否则 server.close 会等这些 keep-alive 连接, 卡死)
    for (const res of this._sseClients) { try { res.end(); } catch {} }
    this._sseClients.clear();
    if (this.server) { await new Promise((r) => this.server.close(r)); this.server = null; }
    this.connected = false;
  }
}
