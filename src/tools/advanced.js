// src/tools/advanced.js - 进阶工具集 (搜索 / HTTP / 定时任务)
// 全部零依赖: 用 Node 原生 fetch + timers
import net from "node:net";
import dns from "node:dns/promises";
import path from "node:path";
import { ensureDir, readJson, writeJson } from "../utils/store.js";

// ---------- 网页搜索 (零依赖, 多引擎兜底: tavily/brave[有key] -> DDG) ----------
// 有 TAVILY_API_KEY / BRAVE_API_KEY 时优先用官方 API, 否则回退加固后的 DDG 解析
function _stripTags(h) { return String(h || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim(); }
function _decodeDDGUrl(u) {
  // DDG 结果链接是 /duckduckgo.html?uddg=<encoded>&rut=...
  const m = String(u || "").match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch {} }
  return u;
}

async function searchWeb(query) {
  const q = encodeURIComponent(query);

  // 1. Tavily (官方 API, 需 TAVILY_API_KEY)
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: tavilyKey, query, max_results: 5 }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const j = await r.json();
        const results = (j.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.content }));
        if (results.length) return results;
      }
    } catch {}
  }

  // 2. Brave (官方 API, 需 BRAVE_API_KEY)
  const braveKey = process.env.BRAVE_API_KEY;
  if (braveKey) {
    try {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=5`, {
        headers: { "X-Subscription-Token": braveKey, "Accept": "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const j = await r.json();
        const results = (j.web?.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.description }));
        if (results.length) return results;
      }
    } catch {}
  }

  // 3. DuckDuckGo HTML (免key兜底, 加固解析)
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await r.text();
    const results = [];
    // 每次抓一个 result 块: <a class="result__a" href="...">title<\/a> ... <a class="result__snippet"...>snippet<\/a>
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 5) {
      const title = _stripTags(m[2]);
      const snippet = _stripTags(m[3]);
      if (title) results.push({ title, url: _decodeDDGUrl(m[1]), snippet });
    }
    if (results.length) return results;
  } catch {}

  // 4. DuckDuckGo lite (最终兜底)
  try {
    const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${q}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await r.text();
    const results = [];
    const re = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 5) {
      const title = _stripTags(m[2]);
      if (title) results.push({ title, url: _decodeDDGUrl(m[1]), snippet: "" });
    }
    if (results.length) return results;
  } catch {}

  throw new Error("所有搜索源失败: 无结果");
}

// ---------- HTTP 请求 (含 SSRF 防护) ----------
// 2026-09-18 修复 (P1): 原实现只按 IPv4 点分十进制判断, IPv6 字面量 (parts.length !== 4)
//   直接返回 false → http://[::1]/ http://[fe80::x]/ http://[fc00::x]/ 全部被当"公网"放行,
//   可打本机回环与内网服务。现补齐 IPv6 判定 (回环/未指定/链路本地/唯一本地 fc00::/7),
//   并处理 IPv4-mapped IPv6 (::ffff:127.0.0.1 等)。导出供回归测试使用。
export function isPrivateIP(ip) {
  if (!ip) return false;
  let s = String(ip).trim().replace(/^\[|\]$/g, "");
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → 取回 IPv4 部分走 v4 逻辑
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) s = mapped[1];
  if (s.includes(":")) {
    const low = s.toLowerCase();
    if (low === "::" || low === "::1") return true;            // 未指定 / 回环
    if (low.startsWith("fe80")) return true;                   // 链路本地 fe80::/10
    if (/^f[cd][0-9a-f]{2}:/.test(low)) return true;           // 唯一本地 fc00::/7
    return false;
  }
  const parts = s.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

async function assertPublicUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("仅允许 http/https");
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) throw new Error("SSRF 拒绝: 内网地址 " + hostname);
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  for (const { address } of addrs) {
    if (isPrivateIP(address)) throw new Error("SSRF 拒绝: " + hostname + " 解析到内网 " + address);
  }
}

// 带 SSRF 校验的安全 fetch: 手动跟随重定向, 并对每一跳(含首发)都做 assertPublicUrl 校验。
// fetch 默认 redirect:"follow" 会在每次跳转时重新解析 DNS —— 攻击者用一个公网 URL 302→内网
// (如 http://127.0.0.1:x 或 http://169.254.169.254/)即可绕过单次 assertPublicUrl。
// 这里改用 redirect:"manual" 逐跳校验后再继续, 堵住"302 到内网/云元数据"的绕过。
async function _fetchWithSsrSafe(url, { method = "GET", headers = {}, body, signal, maxRedirects = 5 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);
    const resp = await fetch(current, {
      method,
      headers,
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      redirect: "manual",
      signal,
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.has("location")) {
      const loc = resp.headers.get("location");
      current = new URL(loc, current).toString(); // 相对 Location 基于 current 解析成绝对 URL
      method = "GET"; // 重定向后不再携带 body, 并退回 GET (302/303 语义)
      body = undefined;
      continue;
    }
    return resp;
  }
  throw new Error("SSRF 拒绝: 重定向次数超过 " + maxRedirects);
}

async function httpRequest({ url, method = "GET", headers = {}, body = null, timeout = 15000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await _fetchWithSsrSafe(url, {
      method,
      headers: { "User-Agent": "PPX-Agent/0.2", ...headers },
      body,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    return { status: resp.status, ok: resp.ok, body: text.slice(0, 20000) };
  } finally {
    clearTimeout(timer);
  }
}


// ---------- 网页正文提取 (fetch_page: 抓正文转纯文本, 配合 web_search 读网页) ----------
function _htmlToText(html) {
  const s0 = String(html || "");
  // 去掉 script/style/nav/footer/header 噪音
  let out = s0.replace(/<script[\s\S]*?<\/script>/gi, " ")
              .replace(/<style[\s\S]*?<\/style>/gi, " ")
              .replace(/<(script|style|nav|footer|header|iframe|form|button|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  out = out.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>|<\/tr>/gi, "\n");
  out = out.replace(/<[^>]+>/g, " ");                     // 去掉所有标签
  out = out.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
           .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
           .replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'");
  out = out.replace(/\s+/g, " ");                          // 压缩空白
  return out.trim();
}

// ---------- 定时任务 ----------
// 2026-09-18 修复 (P1): 原构造函数只从 jobs.json 恢复 jobs 数组、从不 _schedule(),
//   且 add() 传入的 action 是运行时闭包, JSON.stringify 落盘时被静默丢弃 ——
//   进程重启后所有持久化任务没有任何定时器在跑, 触发了也因无 action 空转。
//   现: ① 构造时重排每日 (HH:MM) 任务; 陈旧的 once (after:Ns) 任务跨重启丢弃不补触发;
//       ② _fire 对无 action 的恢复任务走 onFire 回调 (由注册方按 job.name 还原行为)。
export class Scheduler {
  constructor(dataDir, { onFire = null } = {}) {
    this.dir = path.join(dataDir, "scheduler");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "jobs.json");
    this.onFire = onFire;
    this.timers = new Map(); // 必须先于恢复重排初始化 (2026-09-18 回归测试抓出)
    const loaded = readJson(this.file, []);
    // 重启恢复: 重排每日任务; once (after:Ns) 任务视为陈旧丢弃 (语义 = "N秒后一次", 跨重启已失义)
    this.jobs = [];
    for (const job of loaded) {
      if (job && job.enabled === false) { this.jobs.push(job); continue; }
      if (typeof job?.cron === "string" && /^\d{2}:\d{2}$/.test(job.cron)) {
        this.jobs.push(job);
        this._schedule(job);
      }
    }
    if (this.jobs.length !== loaded.length) writeJson(this.file, this.jobs);
  }

  add({ name, cron, action, type = "once" }) {
    const job = {
      id: "j_" + Math.random().toString(36).slice(2, 8),
      name, cron, action, type, enabled: true, createdAt: new Date().toISOString(),
    };
    this.jobs.push(job);
    writeJson(this.file, this.jobs);
    this._schedule(job);
    return job;
  }

  _schedule(job) {
    if (this.timers.has(job.id)) clearTimeout(this.timers.get(job.id));
    // 简化 cron: 支持 "HH:MM" (每日) 或 "after:Ns" (N秒后)
    let delayMs = null;
    if (typeof job.cron === "string" && job.cron.startsWith("after:")) {
      delayMs = parseInt(job.cron.split(":")[1], 10) * 1000;
    } else if (typeof job.cron === "string" && /^\d{2}:\d{2}$/.test(job.cron)) {
      const [h, m] = job.cron.split(":").map(Number);
      const now = new Date();
      const target = new Date(now); target.setHours(h, m, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      delayMs = target - now;
    } else if (typeof job.cron === "number") {
      delayMs = job.cron * 1000;
    }
    if (delayMs === null) return;
    const timer = setTimeout(() => this._fire(job), delayMs);
    this.timers.set(job.id, timer);
  }

  async _fire(job) {
    if (job.type === "once") { this.remove(job.id); }
    else { this._schedule(job); } // 每日任务重新排
    try {
      if (typeof job.action === "function") await job.action();
      else if (this.onFire) await this.onFire(job); // 重启恢复的任务: action 闭包已丢, 走注册方回调
    } catch (e) { console.error("定时任务失败:", e); }
  }

  remove(id) {
    if (this.timers.has(id)) { clearTimeout(this.timers.get(id)); this.timers.delete(id); }
    this.jobs = this.jobs.filter((j) => j.id !== id);
    writeJson(this.file, this.jobs);
  }

  list() { return this.jobs.map(({ id, name, cron, enabled }) => ({ id, name, cron, enabled })); }

  // 清理所有定时器 (进程关停时调用, 防 daily/repeating 任务把事件循环挂住不退出)
  shutdown() {
    for (const [id, t] of this.timers) { try { clearTimeout(t); } catch {} }
    this.timers.clear();
  }
}

// 注册进阶工具
export function registerAdvancedTools(catalog, { dataDir, scheduler, onMemoryNote }) {
  catalog.register({
    name: "web_search",
    description: "搜索互联网, 返回网页标题+链接+摘要。",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async (args) => {
      try {
        const results = await searchWeb(args.query);
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`).join("\n");
      } catch (e) {
        return JSON.stringify({ error: `搜索失败: ${e.message}` });
      }
    },
  });

  catalog.register({
    name: "http_request",
    description: "发送 HTTP 请求 (GET/POST/PUT/DELETE), 返回状态码和响应体。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
        headers: { type: "object" },
        body: { type: "string" },
      },
      required: ["url"],
    },
    execute: async (args) => {
      try {
        const r = await httpRequest(args);
        return JSON.stringify({ status: r.status, ok: r.ok, body: r.body.slice(0, 5000) });
      } catch (e) {
        return JSON.stringify({ error: `HTTP 请求失败: ${e.message}` });
      }
    },
  });

  catalog.register({
    name: "notify",
    description: "主动向用户通道发送通知消息 (用于长任务或异步完成提醒)。",
    parameters: { type: "object", properties: { message: { type: "string", description: "要发送的通知内容" } }, required: ["message"] },
    execute: async (args, ctx) => {
      const agent = ctx && ctx.agent;
      if (agent && agent.notify) { agent.notify(args && args.message); return "notified"; }
      return "no notify sink registered";
    },
  });

  catalog.register({
    name: "add_schedule",
    description: "添加定时任务。cron 支持 'HH:MM'(每日) 或 'after:秒数'(N秒后执行一次)。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        cron: { type: "string", description: "'HH:MM' 或 'after:60'" },
      },
      required: ["name", "cron"],
    },
    execute: async (args) => {
      if (!scheduler) return JSON.stringify({ error: "调度器未初始化" });
      const job = scheduler.add({ name: args.name, cron: args.cron, type: /^\d{2}:\d{2}$/.test(args.cron) ? "daily" : "once", action: () => onMemoryNote?.(`定时任务触发: ${args.name}`) });
      return JSON.stringify({ ok: true, id: job.id, next: job.cron });
    },
  });

  catalog.register({
    name: "list_schedules",
    description: "列出所有定时任务。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      if (!scheduler) return "调度器未初始化";
      return JSON.stringify(scheduler.list());
    },
  });


  catalog.register({
    name: "fetch_page",
    description: "抓取一个网页的正文并转成纯文本 (截断到 20000 字符)。用于读文章/文档/新闻内容后回答问题。",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "要抓取的网页 URL" }, maxChars: { type: "number", description: "返回最大字符数, 默认 20000" } },
      required: ["url"],
    },
    execute: async (args) => {
      try {
        const timeout = 15000;
        const r = await httpRequest({ url: args.url, timeout });
        if (!r.ok) return JSON.stringify({ error: "抓取失败 HTTP " + r.status });
        const text = _htmlToText(r.body);
        const max = Math.min(args.maxChars || 20000, 40000);
        const truncated = text.length > max ? text.slice(0, max) + "\n...[已截断, 共 " + text.length + " 字符]" : text;
        return JSON.stringify({ url: args.url, status: r.status, chars: text.length, content: truncated });
      } catch (e) {
        return JSON.stringify({ error: "fetch_page 失败: " + e.message });
      }
    },
  });

  return catalog;
}