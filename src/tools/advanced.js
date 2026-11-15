// src/tools/advanced.js - 进阶工具集 (搜索 / HTTP / 抓页 / 定时)
// 全部零依赖: 用 Node 原生 fetch + timers
// 2026-11-12 拆分: SSRF 防线 → net-guard.js; cron/Scheduler → scheduler.js。
//   本文件只保留"工具定义 + 搜索策略", 出站安全判据与调度基础设施各自独立。
import { proxiedFetch, getProxy } from "../security/http-proxy.js";
import { _fetchWithSsrSafe } from "./net-guard.js";
import { isCronExpr } from "./scheduler.js";

// ---------- 网页搜索 (零依赖, 多引擎兜底: tavily/brave[有key] -> DDG) ----------
// 有 TAVILY_API_KEY / BRAVE_API_KEY 时优先用官方 API, 否则回退加固后的 DDG 解析
function _stripTags(h) { return String(h || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim(); }
function _decodeDDGUrl(u) {
  // DDG 结果链接是 /duckduckgo.html?uddg=<encoded>&rut=...
  const m = String(u || "").match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch {} }
  return u;
}

async function searchWeb(query, proxy = "") {
  const q = encodeURIComponent(query);

  // 1. Tavily (官方 API, 需 TAVILY_API_KEY)
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    try {
      const r = await proxiedFetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: tavilyKey, query, max_results: 5 }),
        timeoutMs: 15000,
      }, proxy);
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
      const r = await proxiedFetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=5`, {
        headers: { "X-Subscription-Token": braveKey, "Accept": "application/json" },
        timeoutMs: 15000,
      }, proxy);
      if (r.ok) {
        const j = await r.json();
        const results = (j.web?.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.description }));
        if (results.length) return results;
      }
    } catch {}
  }

  // 3. DuckDuckGo HTML (免key兜底, 加固解析)
  try {
    const r = await proxiedFetch(`https://html.duckduckgo.com/html/?q=${q}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeoutMs: 15000,
    }, proxy);
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
    const r = await proxiedFetch(`https://lite.duckduckgo.com/lite/?q=${q}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeoutMs: 15000,
    }, proxy);
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

async function httpRequest({ url, method = "GET", headers = {}, body = null, timeout = 15000 }, proxy = "") {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await _fetchWithSsrSafe(url, {
      method,
      headers: { "User-Agent": "PPX-Agent/0.2", ...headers },
      body,
      signal: ctrl.signal,
    }, proxy);
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

// 注册进阶工具
export function registerAdvancedTools(catalog, { dataDir, scheduler, onMemoryNote }) {
  catalog.register({
    name: "web_search",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "搜索互联网, 返回网页标题+链接+摘要。",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async (args, ctx) => {
      try {
        // 优先: 当前模型的 API 自带联网搜索 (智谱 GLM 等; 不支持/失败则回退外部搜索)
        const agent = ctx && ctx.agent;
        const llm = agent && agent.llm;
        if (llm && typeof llm.nativeWebSearch === "function") {
          const ans = await llm.nativeWebSearch(args.query);
          if (ans) return ans;
        }
        const proxy = await getProxy(agent && agent.config);
        const results = await searchWeb(args.query, proxy);
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`).join("\n");
      } catch (e) {
        return JSON.stringify({ error: `搜索失败: ${e.message}` });
      }
    },
  });

  catalog.register({
    name: "http_request",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "network" },
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
    execute: async (args, ctx) => {
      try {
        const proxy = await getProxy(ctx && ctx.agent && ctx.agent.config);
        const r = await httpRequest(args, proxy);
        return JSON.stringify({ status: r.status, ok: r.ok, body: r.body.slice(0, 5000) });
      } catch (e) {
        return JSON.stringify({ error: `HTTP 请求失败: ${e.message}` });
      }
    },
  });

  catalog.register({
    name: "notify",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "system" },
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
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "添加定时任务。cron 支持 'HH:MM'(每日)、'after:秒数'(N秒后执行一次) 或 5 段 cron 表达式 (分 时 日 月 周, 如 '30 9 * * 1-5' 工作日 9:30)。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        cron: { type: "string", description: "'HH:MM' / 'after:60' / 5 段 cron ('*/15 * * * *' 每 15 分钟)" },
      },
      required: ["name", "cron"],
    },
    execute: async (args) => {
      if (!scheduler) return JSON.stringify({ error: "调度器未初始化" });
      const isDaily = /^\d{2}:\d{2}$/.test(args.cron);
      const isCron = isCronExpr(args.cron);
      const job = scheduler.add({ name: args.name, cron: args.cron, type: isCron ? "cron" : (isDaily ? "daily" : "once"), action: () => onMemoryNote?.(`定时任务触发: ${args.name}`) });
      return JSON.stringify({ ok: true, id: job.id, next: job.cron });
    },
  });

  catalog.register({
    name: "list_schedules",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "列出所有定时任务。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      if (!scheduler) return "调度器未初始化";
      return JSON.stringify(scheduler.list());
    },
  });


  catalog.register({
    name: "fetch_page",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "抓取一个网页的正文并转成纯文本 (截断到 20000 字符)。用于读文章/文档/新闻内容后回答问题。",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "要抓取的网页 URL" }, maxChars: { type: "number", description: "返回最大字符数, 默认 20000" } },
      required: ["url"],
    },
    execute: async (args, ctx) => {
      try {
        const timeout = 15000;
        const proxy = await getProxy(ctx && ctx.agent && ctx.agent.config);
        const r = await httpRequest({ url: args.url, timeout }, proxy);
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