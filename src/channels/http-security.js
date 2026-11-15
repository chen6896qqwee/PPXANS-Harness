// src/channels/http-security.js - HTTP 通道的安全基线与来源可信判定 (mixin, 从 http.js 拆出)
// 职责: CSP/安全响应头 + CORS 策略 + 回环/Host/Origin 三道可信判据。
// 只读请求上下文 (socket/headers/config), 不写业务状态; 挂回 HttpChannel.prototype 后对外行为不变。
// 依赖约束: 不得 import http.js (宿主), 否则成环。

// 统一安全响应头 (2026-10-25 安全加固): 此前仅有 CORS 头, 无任何浏览器安全基线。
// Web UI 有 70+ innerHTML 拼接点, 编码纪律需要一道服务器侧护栏兜底 ——
// 注入的外域脚本/样式/资源一律被 CSP 拒绝, 页面也禁止被 iframe (frame-ancestors)。
// script-src 只放行 'self': 2026-10-30 起首屏主题脚本已外置为 webapp/public/theme.js,
// 页面不再有任何可执行内联脚本, 因此不再需要维护内容 sha256 白名单。
// 引导数据走 <script type="application/json" id="ppx-boot">, 不是可执行脚本, 不受 script-src 约束;
// style-src 需 'unsafe-inline': SVG sprite/输入框既有内联 style 属性是既有 UI 结构。
// connect-src 'self': 前端仅同源 fetch (实测无外域调用)。
// font-src 'self' data: (v5.0): Vue3+Vite 构建链引入 KaTeX 字体 CSS, 其中小字体以
//   data: URL 内联 (KaTeX_Size3) —— 无 font-src 时落回 default-src 'self' 被拦,
//   渲染进程 console error。data: 字体是纯数据非可执行面, 与 img-src data: 同级风险。
export const SECURITY_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const httpSecurityMethods = {
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
  },

  // 判断请求是否来自本机回环 (127.0.0.1/::1) —— 只有本机才允许把 token 注入首页
  // 安全边界: 服务默认只绑 127.0.0.1; 即使绑到 0.0.0.0, 局域网访问者拿不到注入的 token,
  // 前端会退化为"手填 token"形态, 而恶意网页因 CORS 读不到首页响应, 无法窃取 token。
  _isLoopback(req) {
    const a = (req.socket && req.socket.remoteAddress) || "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
  },

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
  },

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
  },

  _isTrustedLocal(req) {
    return this._isLoopback(req) && this._hostTrusted(req) && this._originTrusted(req);
  },

  // 浏览器形态判定 (2026-11-13, 评测 P1-3a):
  //   只靠回环 + Host + Origin 仍会把 Node/脚本客户端 (含 agent 的 browse 兜底抓取)
  //   当成"可信本地"并下发 authToken —— 模型读一次 /api/bootstrap 就能拿到 API 凭据。
  //   真实浏览器请求一定带 Fetch Metadata (Sec-Fetch-Site / Mode) 或同源 Origin/Referer;
  //   Node fetch 默认三者皆无。因此 token 下发再收紧一层: 必须是浏览器形态。
  //   兼容旧浏览器: 没有 Sec-Fetch-* 时退回 Origin/Referer 回环判定。
  //   注意: 这里不改变 _isTrustedLocal 的既有语义 (其它 API 仍按原判据), 只用于凭据下发。
  _isBrowserLike(req) {
    const sfs = String(req.headers?.["sec-fetch-site"] || "").toLowerCase();
    if (sfs) return sfs === "none" || sfs === "same-origin" || sfs === "same-site";
    const ref = req.headers?.origin || req.headers?.referer;
    if (!ref) return false;
    try {
      const host = new URL(ref).hostname.replace(/^\[|\]$/g, "");
      return host === "127.0.0.1" || host === "localhost" || host === "::1";
    } catch {
      return false;
    }
  },

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
  },

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
  },
};
