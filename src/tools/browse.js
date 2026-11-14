// src/tools/browse.js - browse 工具 (v5.0 P2.3): 抓取并阅读网页
// 两种形态, 自动择优:
//   1. 桌面渲染模式 (Electron 运行中): POST 到桌面壳的内部渲染端点 (PPX_DESKTOP_RENDER_PORT,
//      HMAC 鉴权), 用真实 Chromium 渲染后取 DOM 文本 + 可选截图 —— JS 动态页 (SPA) 可读;
//   2. 零依赖直抓模式 (兜底, 任何环境可用): HTTP GET + 结构化提取 (标题/正文/链接),
//      沿用 fetch_page 同源的 html→text 管线并补链接清单与表格行保序。
// 截图落 uploads/ 回显 (桌面模式), 与附件回显同一静态通道。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProxy } from "../security/http-proxy.js";
import { TOOL_ERROR_PREFIX } from "./seam.js";
import { _fetchWithSsrSafe } from "./net-guard.js";
import { noteCatch } from "../utils/catch-log.js";

// ---------- HTML → 结构化提取 (零依赖直抓模式) ----------
function _stripNoise(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|footer|header|aside|iframe|form|button|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ");
}

function _extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? _decodeEntities(m[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

function _decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ""; }
    });
}

function _htmlToText(html) {
  let out = _stripNoise(html);
  out = out.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>|<\/tr>|<\/table>/gi, "\n");
  out = out.replace(/<[^>]+>/g, " ");
  out = _decodeEntities(out);
  // 压缩空白但保留换行结构 (表格/列表的行边界是信息)
  out = out.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter((l) => l).join("\n");
  return out.trim();
}

function _extractLinks(html, base) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || "").matchAll(/<a\s[^>]*href=["']([^"'#\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = _decodeEntities(m[1]).trim();
    if (!/^https?:/i.test(href)) {
      try { href = new URL(href, base).href; } catch { continue; }
    }
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const label = _decodeEntities(String(m[2] || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 120);
    out.push({ href, label });
    if (out.length >= 30) break;
  }
  return out;
}

// ---------- 桌面渲染端点客户端 (Electron 内部通道, HMAC 鉴权) ----------
function renderEndpoint() {
  const port = Number(process.env.PPX_DESKTOP_RENDER_PORT) || 0;
  const secret = String(process.env.PPX_DESKTOP_SECRET || "");
  if (!port || !secret) return null;
  return { port, secret };
}

async function tryRender(url, { screenshot, uploadsDir } = {}) {
  const ep = renderEndpoint();
  if (!ep) return null;
  const body = JSON.stringify({ url, screenshot: !!screenshot });
  const ts = Date.now();
  const sig = crypto.createHmac("sha256", ep.secret).update(`${ts}.${body}`).digest("hex");
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`http://127.0.0.1:${ep.port}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ppx-ts": String(ts), "x-ppx-sig": sig },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || j.ok !== true || typeof j.text !== "string") return null;
    // 截图落 uploads/ (与附件同一静态回显通道), 返回相对路径供消息内嵌
    let shotPath = null;
    if (j.screenshot && uploadsDir) {
      try {
        const name = `browse-${Date.now().toString(36)}.png`;
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        fs.writeFileSync(path.join(uploadsDir, name), Buffer.from(j.screenshot, "base64"));
        shotPath = `uploads/${name}`;
      } catch (e) { noteCatch(e); /* 截图落盘失败不阻断正文 */ }
    }
    return { url: j.url || url, title: j.title || "", text: j.text, shotPath, rendered: true };
  } catch (e) {
    noteCatch(e); // 渲染通道不可用 (壳未就绪/已退出) → 回退直抓
    return null;
  } finally {
    clearTimeout(kill);
  }
}

export function registerBrowseTools(catalog, { uploadsDir } = {}) {
  catalog.register({
    name: "browse",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none", mcpTrusted: false },
    description: "打开一个网页并阅读: 返回标题 + 正文文本 + 页内链接清单。桌面端运行时用真实浏览器渲染 (JS 动态页/SPA 可读, 可附截图); 否则 HTTP 直抓。需要看网页内容、读文档、查资料时优先用它, 比 fetch_page 多链接清单与渲染能力。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要打开的网页 URL (http/https)" },
        max_chars: { type: "number", description: "返回正文最大字符数, 默认 16000" },
        links: { type: "boolean", description: "是否返回页内链接清单 (默认 true, 最多 30 条)" },
        screenshot: { type: "boolean", description: "桌面模式下是否附截图 (落 uploads/ 并返回路径)" },
      },
      required: ["url"],
    },
    execute: async (args, ctx) => {
      const url = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return `${TOOL_ERROR_PREFIX} browse: url 必须以 http(s):// 开头`;
      }
      const max = Math.min(Number(args.max_chars) || 16000, 40000);
      // 1) 桌面渲染通道优先 (真实 DOM)
      const rendered = await tryRender(url, { screenshot: args.screenshot === true, uploadsDir });
      if (rendered) {
        const text = rendered.text.length > max ? rendered.text.slice(0, max) + "\n...[已截断, 共 " + rendered.text.length + " 字符]" : rendered.text;
        return JSON.stringify({
          url: rendered.url, title: rendered.title, mode: "rendered",
          chars: rendered.text.length,
          screenshot: rendered.shotPath || undefined,
          content: text,
        });
      }
      // 2) 零依赖直抓兜底
      try {
        const proxy = await getProxy(ctx?.agent?.config || {});
        // 2026-11-08 安全收口: 兜底直抓与 fetch_page 同一 SSRF 防线 —— _fetchWithSsrSafe
        //   逐跳 (含首发) assertPublicUrl + redirect:"manual" 手动跟随, 堵住"公网 URL
        //   302→内网/云元数据"绕过。口径差异 (有意设计): 首跳放行回环 (firstHopAllowLoopback)
        //   —— browse 承担本地开发场景 (浏览本机服务/测试桩), 与桌面渲染通道一致; 重定向
        //   跳不豁免, 私网/链路/元数据任何一跳都拒。桌面渲染通道 (tryRender) 渲染发生在
        //   用户可见的本机 Chromium 里, 属设计内能力, 由 HMAC 内部端点鉴权约束。
        const r = await _fetchWithSsrSafe(url, { headers: { "User-Agent": "Mozilla/5.0 (PPXANS-Harness browse; +local)" }, firstHopAllowLoopback: true }, proxy);
        if (!r.ok) return JSON.stringify({ error: "抓取失败 HTTP " + r.status, url });
        const body = await r.text();
        const title = _extractTitle(body);
        const text = _htmlToText(body);
        const links = args.links === false ? [] : _extractLinks(body, url);
        const clipped = text.length > max ? text.slice(0, max) + "\n...[已截断, 共 " + text.length + " 字符]" : text;
        return JSON.stringify({
          url, title, mode: "fetch", chars: text.length,
          links: links.length ? links : undefined,
          content: clipped,
        });
      } catch (e) {
        return `${TOOL_ERROR_PREFIX} browse 失败: ${e.message}`;
      }
    },
  });
}
