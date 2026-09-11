// src/channels/http.js - HTTP 通道 (零依赖)
// 起一个本地 HTTP server, 接收 POST /message 消息, 调 agent 回复
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Channel } from "./base.js";
import {
  listProviders, addProvider, updateProvider, removeProvider, reorderProviders,
} from "../config/providers.js";
import { getSettings, updateSettings } from "../config/settings.js";
import { suggestProactive } from "../ans/proactive.js";
import { ensureDir, atomicWrite, readText } from "../utils/store.js";

const MAX_BODY = 1024 * 1024;          // 请求体上限 1MB
const RATE_PER_MIN = 60;               // 每 IP 每分钟最大请求数 (令牌桶)
const RATE_WINDOW_MS = 60_000;
const MAX_INFLIGHT = 4;                // 同时处理的最大对话请求数 (超出立即 429, 防单 agent 被并发压垮)

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
    this._buckets = new Map(); // ip -> {tokens, last}
    // v1.0.8: webhook 路由注册表 (feishu/wechat 通道挂载), 单一 request handler 分发, 无多 listener 竞态
    this.webhookRoutes = new Map(); // path -> async (req, res) => void
    // CORS 来源白名单 (v1.0.7): channels.http.cors_origin 数组; 未配置默认 * (向后兼容)
    // 配置后仅放行白名单 origin, 其余跨域请求 403 (token 泄露时降低任意跨站读取风险)
    this.corsOrigins = this._corsFromConfig();
    this._inFlight = 0; // 当前处理中的对话请求数
  }

  // 简单并发护栏: 用计数信号量限制同时处理的对话请求, 超出立即 429
  // 防止多个慢请求无限叠加占用单线程主 agent (可选的背压层, 区别于每 IP 令牌桶限流)
  _acquire(res) {
    if (this._inFlight >= MAX_INFLIGHT) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "5" });
      res.end(JSON.stringify({ error: "too many concurrent requests, retry shortly" }));
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
    return h === "Bearer " + this.authToken;
  }

  // 简单令牌桶限流: 每 IP 60 req/min
  _rateLimit(req, res) {
    const ip = req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    let b = this._buckets.get(ip);
    if (!b) {
      b = { tokens: RATE_PER_MIN, last: now };
      this._buckets.set(ip, b);
    }
    const refill = Math.floor((now - b.last) / RATE_WINDOW_MS);
    if (refill > 0) {
      b.tokens = Math.min(RATE_PER_MIN, b.tokens + refill * RATE_PER_MIN);
      b.last = now;
    }
    if (b.tokens <= 0) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "rate limited" }));
      return false;
    }
    b.tokens -= 1;
    return true;
  }

  // 读取请求体, 限制大小
  async _readBody(req, res) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "request too large" }));
        return null;
      }
    }
    return body;
  }

  async connect() {
    this._ensureToken(); // 启动时确保有 token
    this.server = http.createServer(async (req, res) => {
      // v1.0.8: webhook 路由分发 (feishu/wechat 等): 匹配路径交给对应通道, 不走主逻辑
      const reqPath0 = (req.url || "/").split("?")[0];
      const wh = this.webhookRoutes.get(reqPath0);
      if (wh) {
        try { await wh(req, res); } catch (e) {
          try { if (!res.writableEnded) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); } } catch {}
        }
        return;
      }
      // CORS (v1.0.7): 默认 * (兼容); 配置 cors_origin 白名单时校验浏览器来源 (无 Origin 的非浏览器请求不受 CORS 约束)
      const origin = req.headers.origin;
      let allowOrigin = "*";
      if (this.corsOrigins.length) {
        allowOrigin = !origin ? "*" : (this.corsOrigins.includes(origin) ? origin : null);
      }
      if (!allowOrigin) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "origin not allowed" }));
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", allowOrigin);
      if (allowOrigin !== "*") res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      // 静态页面与 /health 不设限, 其余 API 限流
      const reqPath = (req.url || "/").split("?")[0];
      if (!(req.method === "GET" && (reqPath === "/" || reqPath === "/index.html" || reqPath === "/health"))) {
        if (!this._rateLimit(req, res)) return;
      }

      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", agent: this.agent.config.agent?.name || "ppx" }));
        return;
      }

      if (req.method === "POST" && req.url === "/message") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        try {
          const data = JSON.parse(body);
          const text = data.message || data.text || "";
          if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: "missing message" })); return; }
          const sessionKey = data.sessionId || "default";
          if (!this._acquire(res)) return;
          try {
            const reply = await this.agent.chat(String(text), { sessionKey });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ reply, sessionId: sessionKey, agent: this.agent.config.agent?.name || "ppx" }));
          } finally { this._release(); }
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // SSE 流式对话
      if (req.method === "POST" && (req.url === "/message/stream" || req.url === "/chat")) {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        try {
          const data = JSON.parse(body);
          const text = data.message || data.text || "";
          if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: "missing message" })); return; }
          const sessionKey = data.sessionId || "default";
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          });
          if (!this._acquire(res)) { try { res.end(); } catch {} return; }
          try {
            const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
            let full = "";
            const reply = await this.agent.chatStream(String(text), {
              sessionKey,
              onDelta: (d) => { full += d; try { send({ type: "delta", content: d }); } catch {} },
              onTool: (ev) => { try { send({ type: "tool", tool: ev.tool, status: ev.type, args: ev.args, ok: ev.ok, durationMs: ev.durationMs }); } catch {} }, // 工具调用可视化
              onStep: (ev) => { try { send({ type: "step", round: ev.round, maxRounds: ev.maxRounds }); } catch {} }, // turn/step 推理轮次进度
            });
            const finalContent = full || reply;
            send({ type: "done", content: finalContent, sessionId: sessionKey });
            res.end();
          } finally { this._release(); }
        } catch (e) {
          try { res.write("data: " + JSON.stringify({ type: "error", error: e.message }) + "\n\n"); } catch {}
          try { res.end(); } catch {}
        }
        return;
      }

      // 会话列表 (Web UI 多会话管理) [P1#6]
      if (req.method === "GET" && req.url === "/sessions") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const list = (this.agent.sessionStore && this.agent.sessionStore.list) ? this.agent.sessionStore.list() : [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions: list }));
        return;
      }

      // 会话历史 (Web UI 切换会话时恢复消息显示): GET /sessions/:key/history
      if (req.method === "GET" && /^\/sessions\/[^/]+\/history$/.test(reqPath)) {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const key = decodeURIComponent(reqPath.split("/")[2]);
        const msgs = this.agent.sessionStore && typeof this.agent.sessionStore.deriveMessages === "function"
          ? this.agent.sessionStore.deriveMessages(key)
          : [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessionId: key, messages: msgs }));
        return;
      }

      // 会话重命名 [P1#6]
      if (req.method === "POST" && req.url === "/sessions/rename") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        const ok = this.agent.sessionStore && typeof this.agent.sessionStore.rename === "function"
          ? this.agent.sessionStore.rename(body.from, body.to) : false;
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
        return;
      }
      // 会话删除 [P1#6]
      if (req.method === "POST" && req.url === "/sessions/delete") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        if (this.agent.sessionStore) this.agent.sessionStore.delete(body.key || "default");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // 会话重置
      if (req.method === "POST" && req.url === "/reset") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        try {
          const data = JSON.parse(body || "{}");
          this.agent.resetSession(data.sessionId || "default");
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ---- 静态界面 + 可观测 API ----
      // 通用静态文件服务 (public/ 下任意文件, 含 vendor/ 资源, 防路径穿越)
      if (req.method === "GET" && !reqPath.startsWith("/api/") && !["/message","/message/stream","/chat","/reset"].some(p=>reqPath===p)) {
        const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\//, "");
        const file = path.resolve(this.publicDir, rel);
        if (file.startsWith(this.publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file).toLowerCase();
          const mime = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css", ".json":"application/json", ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".ico":"image/x-icon" }[ext] || "application/octet-stream";
          res.writeHead(200, { "Content-Type": mime });
          res.end(fs.readFileSync(file));
          return;
        }
        if (reqPath !== "/") { res.writeHead(404); res.end("not found"); return; }
      }
      // 静态页面
      if (req.method === "GET" && (reqPath === "/" || reqPath === "/index.html")) {
        const html = path.join(this.publicDir, "index.html");
        if (fs.existsSync(html)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(fs.readFileSync(html, "utf8"));
        } else {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("皮皮虾服务已启动。public/index.html 未找到。");
        }
        return;
      }
      // API 端点认证
      const protectedApi = reqPath.startsWith("/api/");
      if (protectedApi && !this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
      // 轨迹 API
      if (req.method === "GET" && reqPath === "/api/traces") {
        const limit = Number((req.url.split("limit=")[1] || "").split("&")[0] || 50);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.agent.traces.read(undefined, limit)));
        return;
      }
      // 统计 API (聚合记忆/轨迹/工具/经验/自愈)
      if (req.method === "GET" && reqPath === "/api/stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.agent.stats ? this.agent.stats() : this.agent.traces.stats()));
        return;
      }
      // 记忆 API
      if (req.method === "GET" && reqPath === "/api/memory") {
        res.writeHead(200, { "Content-Type": "application/json" });
        const facts = this.agent.facts ? this.agent.facts.list().slice(0, 20).map((f) => ({ content: f.content, score: f.score, type: f.type })) : [];
        const scenes = this.agent.scenes ? this.agent.scenes.listWithDesc().slice(-10) : [];
        res.end(JSON.stringify({ facts, scenes }));
        return;
      }
      // 主动任务生成 API (ANS 自主性): 扫描记忆待办/偏好, 返回主动提醒 + 结构化 items (含 id)
      if (req.method === "GET" && reqPath === "/api/proactive") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          const out = await suggestProactive(this.agent);
          res.end(JSON.stringify({ message: out ? out.text : null, items: out ? out.items : [] }));
        } catch (e) {
          res.end(JSON.stringify({ message: null, items: [], error: e.message }));
        }
        return;
      }
      // 标记待办完成 (ANS): POST /api/proactive/done { id } → 之后不再主动提醒
      if (req.method === "POST" && reqPath === "/api/proactive/done") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        try {
          const data = JSON.parse(body || "{}");
          const ok = this.agent.proactiveMarkDone(data.id);
          res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      // 生命周期状态 API (ANS): 阶段/年龄/进化/繁衍
      if (req.method === "GET" && reqPath === "/api/lifecycle") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.agent.lifecycleStatus ? this.agent.lifecycleStatus() : {}));
        return;
      }

      // 提供方 API [本轮新增] - 模型配置 Web UI 后端
      // GET    /api/providers        列出全部提供方 (key 抹掉, 只返 api_key_set 标志)
      // POST   /api/providers        新增 (body: { provider: {...} })
      // PUT    /api/providers        更新 (body: { id, patch: {...} })
      // DELETE /api/providers        删除 (body: { id })
      // POST   /api/providers/test   健康探测 (body: { id }), 复用 LLMClient.health()
      // POST   /api/providers/reorder 重排 (body: { order: [id1, id2, ...] })
      if (req.method === "GET" && reqPath === "/api/providers") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const providers = listProviders(this.agent.root);
        const defaultId = providers[0] ? providers[0].id : null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ providers, default_id: defaultId }));
        return;
      }
      if (req.method === "POST" && reqPath === "/api/providers") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        try {
          const data = JSON.parse(body || "{}");
          const raw = data.provider || data;
          const created = addProvider(this.agent.root, raw);
          // 热重载 (新增默认时让 agent 立即可用)
          this.agent.reloadProviders();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, provider: created }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "PUT" && reqPath === "/api/providers") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        try {
          const data = JSON.parse(body || "{}");
          if (!data.id) throw new Error("缺少 id");
          const updated = updateProvider(this.agent.root, data.id, data.patch || {});
          this.agent.reloadProviders();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, provider: updated }));
        } catch (e) {
          const code = /不存在|缺少/.test(e.message) ? 404 : 400;
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "DELETE" && reqPath === "/api/providers") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        try {
          const data = JSON.parse(body || "{}");
          if (!data.id) throw new Error("缺少 id");
          const removed = removeProvider(this.agent.root, data.id);
          this.agent.reloadProviders();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, provider: removed }));
        } catch (e) {
          const code = /不存在|缺少/.test(e.message) ? 404 : 400;
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "POST" && reqPath === "/api/providers/test") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        try {
          const data = JSON.parse(body || "{}");
          if (!data.id) throw new Error("缺少 id");
          // 优先复用 agent 已有的 LLM 客户端 (含测试注入的 stub), 避免对磁盘配置的真实网络探测
          // 兜底顺序: allProviders → agent.llm → 磁盘临时构造
          let client = (this.agent.allProviders || []).find((c) => c.providerId === data.id);
          let fromCache = !!client;
          if (!client && this.agent.llm && this.agent.llm.providerId === data.id) {
            client = this.agent.llm;
            fromCache = true;
          }
          if (!client) {
            const { readConfig } = await import("../config/providers.js");
            const { providers } = readConfig(this.agent.root);
            const p = providers.find((x) => x.id === data.id);
            if (!p) throw new Error("提供方不存在");
            const { LLMClient } = await import("../llm/client.js");
            client = new LLMClient(p);
          }
          const healthy = await client.health();
          const detail = healthy
            ? `${client.backend === "openclaw" ? "openclaw 后端: Node 版本满足" : client.backend === "deepseek" ? "dsh 源码就绪" : fromCache ? "复用 agent 客户端, 探测通过" : "API 端点可达"}`
            : "探测失败, 请检查 key/base_url/engine 路径/Node 版本";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, healthy, detail, source: fromCache ? "agent-cache" : "disk-config" }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "POST" && reqPath === "/api/providers/reorder") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        try {
          const data = JSON.parse(body || "{}");
          const providers = reorderProviders(this.agent.root, data.order || []);
          this.agent.reloadProviders();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, providers }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // 通用设置 API: 用户名 / HTTP 端口 / 安全 / agent 预设
      // GET /api/settings    返回可编辑设置 (敏感字段只回 set 标志)
      // PUT /api/settings    更新 (body: { patch: { user?, http?, security?, agent? } })
      if (req.method === "GET" && reqPath === "/api/settings") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ settings: getSettings(this.agent.root) }));
        return;
      }
      if (req.method === "PUT" && reqPath === "/api/settings") {
        if (!this._authed(req, res)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        const body = await this._readBody(req, res);
        if (body === null) return;
        try {
          const data = JSON.parse(body || "{}");
          const settings = updateSettings(this.agent.root, data.patch || {});
          // 热重载: 用户名/安全/agent 预设立即生效
          this.agent.reloadSettings();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, settings }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      res.writeHead(404); res.end("not found");

    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.connected = true;
    return this;
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
