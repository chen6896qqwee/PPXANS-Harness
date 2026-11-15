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
import { catchStats } from "../utils/catch-log.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Channel } from "./base.js";
import { readBody, sendJson } from "../utils/http.js";
import { TokenBucket } from "../utils/rate-limit.js";
import { createMcpEndpoint } from "../mcp/http.js";
import { createAdminTools } from "../mcp/admin.js";
import { buildFileRefBlock } from "./workspace.js";
// 2026-11-02: 路由域拆分 (2077 → ~950 行), 行为与对外接口不变。
import { eventsHttpMethods } from "./http-events.js";
import { chatHttpMethods } from "./http-chat.js";
import { staticHttpMethods } from "./http-static.js";
import { apiV3HttpMethods } from "./http-api-v3.js";
import { apiSettingsHttpMethods } from "./http-api-settings.js";
// 2026-11-03: 安全基线与鉴权/引导从 http.js 外移 (mixin + 纯函数), 对外导出保持不变。
import { httpSecurityMethods } from "./http-security.js";
import { httpAuthMethods } from "./http-auth.js";
import { httpApiCoreMethods } from "./http-api-core.js";
export { SECURITY_CSP } from "./http-security.js";
export { resolveAuthToken } from "./http-auth.js";

const MAX_BODY = 1024 * 1024;          // 请求体上限 1MB
const RATE_PER_MIN = 240;              // 每 IP 每分钟最大请求数 (令牌桶; 本地面板轮询 + 突发放量)
const MAX_INFLIGHT = 4;                // 同时处理的最大对话请求数 (超出立即 429, 防单 agent 被并发压垮)

// 共享常量/纯函数 (2026-11-02 路由拆分): 放在 http-shared.js, 避免 mixin 反向 import 本文件成环。
export { safeEqual, publicErrorMessage } from "./http-shared.js";
import { safeEqual, publicErrorMessage, LEGACY_REST_PATHS } from "./http-shared.js";

export class HttpChannel extends Channel {
  constructor(agent, { port = 8899, host = "127.0.0.1" } = {}) {
    super("http", agent);
    this.port = port;
    this.host = host;
    this.server = null;
    this.agent = agent;
    // v5.0 (2026-11-07): 前端重铸为 Vue3+Vite, 构建产物在 webapp/dist —— 存在则优先;
    //   回退 public/ (旧版零构建界面, 仅历史兜底; 该目录已随 v5.0 删除)。
    const webappDist = path.join(this.agent.root, "webapp", "dist");
    this.publicDir = fs.existsSync(path.join(webappDist, "index.html"))
      ? webappDist
      : path.join(this.agent.root, "public");
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
    // 2026-11-02: 静态资源内容缓存 (mtime+size 签名校验)。前端每次启动要拉 10+ 个
    //   js/css, 原先每个请求都 readFileSync 再全量回传; 现在进程内复用 + ETag/304。
    this._staticCache = new Map(); // 绝对路径 -> { sig, body }
    this._staticCacheBytes = 0;
    // 2026-10-24: SSE 一次性 ticket (POST /events-ticket 换发, 60s 过期, 用后即焚)
    this._eventsTickets = new Map(); // ticket -> 过期时间戳
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
    // REST 兼容开关 (v2.6.0 引入; 2026-11-08 口径修正: v5.0 Vue 前端聊天走 /message/stream,
    //   会话面板走 /sessions*, 停止按钮走 /interrupt —— "前端已全走 MCP" 只对 v2.x 成立)。
    //   默认保留 REST; 纯 MCP 形态部署可显式 legacy_rest=false → 该组端点统一 410。
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

  // 2026-11-02 (吸收 DeepSeek-Bot ask_user_question): 提问 sink 注册表 + 广播接线。
  //   事件形状: { type:"question", id, questions, sessionKey } / { type:"question.close", id, reason }
  _ensureQuestionSinks() {
    if (!this._questionSinks) this._questionSinks = new Set();
    if (!this.agent._onQuestionEvent) {
      this.agent._onQuestionEvent = (ev) => {
        for (const fn of this._questionSinks) { try { fn(ev); } catch { /* 单个 sink 异常不断流 */ } }
      };
    }
    return this._questionSinks;
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
    // 2026-11-03: @ 文件引用 (前端选择器传来的工作区相对路径)。
    //   在这里读成资料块并随本轮 user wire 注入 (不进记忆抽取); 路径越界/不存在直接 400,
    //   不静默丢引用 —— 用户以为模型看到了文件, 其实没看到, 是最难排查的一类失败。
    let fileRefs = "";
    if (data.files != null) {
      if (!Array.isArray(data.files)) { this._json(res, 400, { error: "files 必须是路径数组" }); return null; }
      try {
        fileRefs = buildFileRefBlock(this.agent.root, data.files.map((f) => (f && typeof f === "object" ? f.path : f)));
      } catch (e) {
        this._json(res, 400, { error: e.message || "引用文件读取失败" });
        return null;
      }
    }
    return { text, sessionKey: data.sessionId || "default", fileRefs };
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

      // REST 退役开关 (v2.6.0 引入; 2026-11-08 口径修正): v5.0 前端实际依赖 /message/stream
      //   (sse.js 聊天流) / /sessions* (会话面板) / /interrupt (停止按钮), 因此开关默认保持开启,
      //   退役目标只是无 UI 消费方的 Gen-1 非流式端点 (/message 单发, /chat 别名, /reset)。
      //   显式配置 legacy_rest: false → 整组 410 并引导 /mcp (纯 MCP 形态部署用)。
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

  // 业务路由。返回 true 表示已处理 (响应已写); false 交给 404 兜底。
  // 2026-09-18 重构: 原为一个 161 行的巨型分支链, 现按域拆成 4 个具名子路由 + 1 个 API 门禁,
  // 每个子路由「不匹配 → undefined/false, 匹配 → 已写响应并返回 true」。分支顺序与语义完全不变。
  async _route(req, res, reqPath) {
    const get = req.method === "GET";
    const post = req.method === "POST";

    if (this._routeHealth(req, res, get, reqPath)) return true;
    if (this._routeDesktopShutdown(req, res, post, reqPath)) return true;
    if (this._routeEvents(req, res, get, reqPath)) return true;
    if (this._routeEventsTicket(req, res, post, reqPath)) return true;
    if (await this._routeChat(req, res, post, reqPath)) return true;
    if (await this._routeSessions(req, res, get, post, reqPath)) return true;

    // 静态界面三态: undefined = 不匹配, true/false = 已匹配且该值即路由结果
    // (2026-11-02: 改为 await —— 冷读大文件走异步 I/O, 不再阻塞事件循环)
    const stat = await this._routeStatic(req, res, get, reqPath);
    if (stat !== undefined) return stat;

    // API 门禁 (REST 退役开关 + 鉴权); 返回 true 表示已拦下并写响应
    if (this._gateApi(req, res, reqPath)) return true;
    return this._apiRoute(req, res, reqPath);
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
      // 关键路径异常留痕 (2026-11-03): 长跑进程不走 shutdown, /health 是另一条读取端。
      //   只给计数与位置, 不带错误文本 —— /health 免鉴权, 不能外泄内部报错。
      catch: (() => {
        const c = catchStats();
        return c.total ? { total: c.total, dropped: c.dropped, top: c.scopes.slice(0, 3).map((s) => `${s.scope}×${s.count}`) } : undefined;
      })(),
    }, headers);
    return true;
  }

  // ---- 桌面壳优雅退出: POST /desktop/shutdown ----
  // 2026-11-02: Windows 桌面壳原先退出直接 taskkill /T /F, 内核拿不到 SIGTERM,
  //   agent.shutdown() (记忆落盘/军团回收/投递队列收口) 被整段跳过。现在桌面壳先打这个
  //   本机端点, 由 `ppx web` 入口注入的回调走与 Ctrl+C 相同的优雅退出链。
  // 安全: 仅 PPX_DESKTOP_SECRET 存在时启用 (普通 Web 部署不暴露), 回环 + 恒定时间比对。
  _routeDesktopShutdown(req, res, post, reqPath) {
    if (reqPath !== "/desktop/shutdown") return false;
    const secret = process.env.PPX_DESKTOP_SECRET;
    if (!secret) return false;
    if (!post) { this._json(res, 405, { error: "只接受 POST" }); return true; }
    if (!this._isLoopback(req) || !safeEqual(req.headers["x-ppx-desktop-secret"] || "", secret)) {
      this._json(res, 403, { error: "桌面密钥无效" });
      return true;
    }
    if (typeof this.onDesktopShutdown !== "function") {
      this._json(res, 503, { error: "当前进程未注册退出处理器" });
      return true;
    }
    // 幂等: 退出请求可能因重试/双击到达两次, 回调只触发一次
    if (!this._desktopShutdownRequested) {
      this._desktopShutdownRequested = true;
      setTimeout(() => { try { this.onDesktopShutdown(); } catch { /* 退出异常不阻塞响应 */ } }, 50).unref?.();
    }
    this._json(res, 202, { ok: true, stopping: true });
    return true;
  }

  // ---- 路由域 2: 对话 (POST /message 与 SSE 流式) ----

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
    // 2026-11-02: 先跑 cleanup 退订并停心跳, 再 end —— 服务关闭后不残留 EQ 订阅者。
    for (const res of this._sseClients) {
      try { res.__ppxSseCleanup?.(); } catch {}
      try { res.end(); } catch {}
    }
    this._sseClients.clear();
    if (this.server) { await new Promise((r) => this.server.close(r)); this.server = null; }
    this.connected = false;
  }
}

Object.assign(
  HttpChannel.prototype,
  eventsHttpMethods,
  chatHttpMethods,
  staticHttpMethods,
  apiV3HttpMethods,
  apiSettingsHttpMethods,
  httpSecurityMethods,
  httpAuthMethods,
  httpApiCoreMethods,
);
