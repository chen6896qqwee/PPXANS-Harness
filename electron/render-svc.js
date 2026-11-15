// electron/render-svc.js - 桌面壳内部渲染服务 (v5.0 P2.3, browse 工具的桌面通道)
// 内核侧 browse 工具在桌面形态下经此用真实 Chromium 渲染网页: offscreen BrowserWindow
// 加载目标页 → 提取渲染后 DOM 文本 (title + body innerText) → 可选整页截图 (PNG base64)。
//
// 安全: 只绑 127.0.0.1 随机端口; 每个请求必须带 HMAC-SHA256 签名 (密钥 = PPX_DESKTOP_SECRET,
// 与内核子进程共享, 不经网络下发), 时戳 ±60s 防重放 —— 与 server-proc 的 /health 挑战应答
// 同一威胁模型。仅接受 http/https 目标, 不渲染 file:// (防本地文件外读)。
import http from "node:http";
import crypto from "node:crypto";
import { BrowserWindow } from "electron";
import { log } from "./app-log.js";

const MAX_TEXT = 120000; // 渲染后文本上限 (字符)
const LOAD_TIMEOUT = 20000;

function verifySig(secret, headers, body) {
  const ts = Number(headers["x-ppx-ts"]);
  const sig = String(headers["x-ppx-sig"] || "");
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 60000) return false;
  const expect = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  } catch {
    return false;
  }
}

export function startRenderService({ secret } = {}) {
  if (!secret) return null;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/render") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    let over = false;
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) { over = true; req.destroy(); }
    });
    req.on("end", async () => {
      if (over) return;
      if (!verifySig(secret, req.headers, body)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "signature" }));
        return;
      }
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
      const url = String(payload.url || "");
      if (!/^https?:\/\//i.test(url)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "url must be http(s)" }));
        return;
      }
      try {
        const out = await renderPage(url, { screenshot: payload.screenshot === true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...out }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 200) }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      log(`[render] 桌面渲染服务就绪 (127.0.0.1:${port})`);
      resolve({
        port,
        close: () => { try { server.close(); } catch { /* 已关 */ } },
      });
    });
  });
}

async function renderPage(url, { screenshot } = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      javascript: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const timer = setTimeout(() => { try { win.webContents.stop(); } catch { /* 已销毁 */ } }, LOAD_TIMEOUT);
  try {
    await win.loadURL(url, { userAgent: "Mozilla/5.0 (PPXANS-Harness desktop render; +local) Chrome/Chromium" });
    // 渲染后 DOM 提取 (页面上下文内执行; 沙箱隔离, 只取文本与标题)
    const data = await win.webContents.executeJavaScript(`(() => {
      const doc = document;
      const clone = doc.body ? doc.body.cloneNode(true) : null;
      if (clone) {
        clone.querySelectorAll('script,style,noscript,svg').forEach((n) => n.remove());
      }
      const text = clone ? (clone.innerText || clone.textContent || '') : '';
      return { title: doc.title || '', text: String(text).slice(0, ${MAX_TEXT}) };
    })()`);
    let shot = null;
    if (screenshot) {
      try {
        const img = win.webContents.capturePage();
        // capturePage 在 offscreen 模式下需要一帧时间; 上面 loadURL/executeJS 已让帧渲染
        shot = (await img).toPNG().toString("base64");
      } catch { /* 截图失败不阻断正文 */ }
    }
    return { url, title: String(data?.title || ""), text: String(data?.text || ""), screenshot: shot };
  } finally {
    clearTimeout(timer);
    try { win.destroy(); } catch { /* 已销毁 */ }
  }
}
