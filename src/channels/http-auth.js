// src/channels/http-auth.js - HTTP 通道的鉴权/限流/首屏引导 (mixin, 从 http.js 拆出)
// 职责: token 解析与持久化、Bearer 校验、按 IP 令牌桶、版本号读取、bootstrap 引导数据与首页注入。
// 挂回 HttpChannel.prototype 后对外接口不变; resolveAuthToken 仍在 http.js 再导出 (测试直接引用)。
// 依赖约束: 不得 import http.js (宿主), 否则成环。
import { info as logInfo } from "../utils/logger.js";
import { noteCatch } from "../utils/catch-log.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, atomicWrite, readText } from "../utils/store.js";
import { readPpxConfig } from "../utils/config-file.js";
import { safeEqual } from "./http-shared.js";

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
      try { fs.chmodSync(persistedFile, 0o600); } catch (e) { noteCatch("src/channels/http.js#atomicWrite", e); /* 非 POSIX 或已受限: 忽略 */ }
    } catch (e) {
      // token 已生成但在内存可用; 落盘失败仅丢失"跨重启复用", 不阻断启动 —— 但必须可复盘
      noteCatch("src/channels/http.js#atomicWrite", e);
    }
  }
  return { token, source: "generated", generated: true };
}

export const httpAuthMethods = {
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
  },

  // Web 前端引导数据 (注入首页 <head>, 本地零配置可用)
  // authToken 仅在"可信本地请求"时下发 (回环 + 来源可信, 见 _isTrustedLocal);
  // 非回环 / 跨站来源只给 token_required 标志, 不下发任何凭据
  bootstrapPayload(req) {
    const loopback = this._isLoopback(req);
    // 2026-11-13 (评测 P1-3a): 凭据只发给浏览器形态的本机请求。
    //   旧判据 _isTrustedLocal 把 Node/脚本客户端也当可信 —— agent 的 browse 兜底抓取
    //   (无 Origin/Fetch Metadata) 可以直接读走 authToken。真实 UI 导航/XHR 必带
    //   Sec-Fetch-* 或同源 Origin, 不受影响。
    const trusted = this._isTrustedLocal(req) && this._isBrowserLike(req);
    // 2026-10-10: 设置面板三项死绑定根因 —— 前端读 model/toolsCount/root 却从未下发, 补上。
    let model = "";
    try {
      model = (this.agent?.llm?.model) || (this.agent?.config?.providers?.[0]?.model) || "";
    } catch (e) { noteCatch("src/channels/http.js#bootstrapPayload", e); /* 取不到就留空 */ }
    let toolsCount = 0;
    try {
      toolsCount = typeof this.agent?.tools?.list === "function" ? this.agent.tools.list().length : 0;
    } catch (e) { noteCatch("src/channels/http.js#bootstrapPayload", e); /* 取不到就留 0 */ }
    // 首屏引导用: "有提供商"不等于"能用" —— 配了卡片但 Key 没填时, hero CTA 仍应出现。
    // 这里按与前端同一判据预先算好 (api_key 明文 / 环境变量已注入 / 本地地址), 避免首屏闪烁。
    let providersCount = 0;
    let modelConfigured = false;
    try {
      const provs = (this.agent?.config?.providers || []).filter((p) => p && p.enabled !== false);
      providersCount = provs.length;
      modelConfigured = provs.some((p) => p.api_key
        || (p.api_key_env && process.env[p.api_key_env])
        || /(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(String(p.base_url || "")));
    } catch (e) { noteCatch("src/channels/http.js#bootstrapPayload", e); /* 配置异常按未配置处理 */ }
    return {
      app: "ppxans-harness",
      version: this._pkgVersion(),
      agent: (this.agent?.config?.agent?.name) || "皮皮虾",
      user: (this.agent?.config?.user?.name) || "",
      model,
      providersCount,
      modelConfigured,
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
  },

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
  },

  _tokenFromConfig() {
    try {
      const cfg = readPpxConfig(this.agent.root, {});
      return (cfg.channels && cfg.channels.http && cfg.channels.http.auth_token) || "";
    } catch {}
    return "";
  },

  // 若未配置 token: 复用持久化文件(重启不变)或自动生成并原子落盘 (类似 Jupyter token)
  // 2026-10-30: 非 TTY (Electron/服务重定向日志) 不再把完整 token 打进日志 ——
  //   桌面壳会把子进程 stdout 落盘, 日志文件常被同步/上报, 长效凭据不该以明文扩散。
  //   交互式终端仍打印完整值 (否则用户没法复制); 需要脚本取值请直接读持久化文件。
  _ensureToken() {
    if (this.authToken) return this.authToken;
    const r = resolveAuthToken({ configured: process.env.PPX_AUTH_TOKEN || "", persistedFile: this._persistedTokenFile });
    this.authToken = r.token;
    if (r.source === "persisted") {
      logInfo("  ℹ  HTTP 认证 token 复用自持久化文件 (重启不更换, 前端无需重贴)");
    } else {
      const showFull = !!(process.stdout && process.stdout.isTTY) || process.env.PPX_SHOW_AUTH_TOKEN === "1";
      const shown = showFull ? this.authToken : `*** (已隐藏, 长度 ${this.authToken.length}; 完整值见持久化文件)`;
      logInfo("");
      logInfo("  ⚠️  HTTP 认证 token 未配置, 已自动生成并持久化 (重启复用):");
      logInfo(`       PPX_AUTH_TOKEN=${shown}`);
      logInfo(`     用法: Authorization: Bearer ${shown}`);
      logInfo(`     token 已保存到 ${this._persistedTokenFile}, 重启不再更换`);
      logInfo("      (或设置 config/ppx.json 的 channels.http.auth_token; 终端里需要直接查看可加 PPX_SHOW_AUTH_TOKEN=1)");
      logInfo("");
    }
    return this.authToken;
  },

  _authed(req, res) {
    if (!this.authToken) return true; // 兼容旧调用: _ensureToken 在 connect 时已执行
    const h = req.headers["authorization"] || "";
    return safeEqual(h, "Bearer " + this.authToken);
  },

  // 简单令牌桶限流: 每 IP 240 req/min (实现共用 utils/rate-limit, 含过期桶回收)
  // 2026-11-12: 60/min 时本地面板 (bot 5s 轮询 + 工单 5s 轮询 + 用户切页/刷新) 会打满,
  //   429 被前端渲染成"没数据/服务不可用"; 提高到 240 仍保留非本地来源的防洪作用。
  // 2026-09-17: 桶表原本只增不减 —— 长期运行 + 多变源地址会持续吃内存; 现由 TokenBucket.sweep 摊还回收。
  // this._buckets 仍指向限流器内部 Map, 保持可观测性 (测试据此注入过期桶)。
  _rateLimit(req, res) {
    const ip = req.socket?.remoteAddress || "unknown";
    if (this._rateLimiter.take(ip)) return true;
    this._json(res, 429, { error: "请求过于频繁, 请稍后重试" }, { "Retry-After": "60" });
    return false;
  },
};
