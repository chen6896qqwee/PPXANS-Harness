// src/services/desktop/kernel-client.js - 桌面壳 → 内核 HTTP 客户端 (2026-11-14, 战役遗留项 #8)
//
// 自 electron/server-proc.js 迁入 (行为逐字不变): 探活 (HMAC 挑战应答) 与优雅退出是
//   "桌面壳 ↔ 内核" 的私有协议, 与 electron 生命周期状态无关 —— 放进 services/desktop
//   与 prefs.js / diagnostics.js 同族, 纯 node 可测 (server-proc.js 只剩进程管理职责)。
// 零依赖 (node:http/crypto), secret 参数化: 不再耦合 electron 侧的一次性密钥常量,
//   任何调用方 (electron 主进程 / 测试 / 外部巡检) 用同一对函数说同一种协议。
import crypto from "node:crypto";
import http from "node:http";

// 探活: GET /health 携带一次性挑战; 应答带 x-ppx-desktop-proof 时做恒定时间 HMAC 比对。
// 2026-10-30 口径 (自 server-proc probe 迁入): 不只看 /health.app 字符串 —— 本机任何服务
//   都能返回同名 JSON, 端口上跑的是不是"我们拉起的那个内核"由 HMAC 证明回答。
// 返回 /health JSON (验证通过时带 __verified: true), 不可达/非 JSON → null。
export function probeKernel({ port, timeout = 1200, secret = null } = {}) {
  return new Promise((resolve) => {
    const challenge = crypto.randomBytes(16).toString("hex");
    const req = http.get({
      host: "127.0.0.1", port, path: "/health", timeout,
      // agent:false + Connection:close: 探测是一次性请求, 不留 keep-alive 句柄拖住退出
      agent: false,
      headers: { "x-ppx-desktop-challenge": challenge, Connection: "close" },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          if (secret && res.headers["x-ppx-desktop-proof"]) {
            const want = crypto.createHmac("sha256", secret).update(challenge).digest("hex");
            const got = String(res.headers["x-ppx-desktop-proof"]);
            const a = Buffer.from(want), b = Buffer.from(got);
            j.__verified = a.length === b.length && crypto.timingSafeEqual(a, b);
          }
          resolve(j);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// 优雅退出: POST /desktop/shutdown (与 Ctrl+C 同一条 shutdown 链)。返回是否被受理 (2xx)。
// 服务端契约 (src/channels/http.js _routeDesktopShutdown): 仅进程内 PPX_DESKTOP_SECRET
//   存在时启用; 密钥恒定时间比对; 首次 202, 重试幂等仍 202。
export function gracefulShutdown({ port, timeout = 1500, secret = null } = {}) {
  return new Promise((resolve) => {
    if (!port || !secret) { resolve(false); return; }
    const req = http.request({
      host: "127.0.0.1", port, path: "/desktop/shutdown", method: "POST", timeout,
      agent: false,
      headers: {
        "x-ppx-desktop-secret": String(secret),
        "content-length": 0,
        Connection: "close",
      },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      res.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}
