// src/web/bot-api.js - 本体 (bot) 形态的 Web 接口
//
// 2026-10-27: 前端从「会话工作台」改为「常驻本体」。工作台那套接口 (/api/tasks、
// /api/memory、/api/lifecycle、/api/health/summary …) 一个都没废, 这里做的是把它们
// 捏成一份 /api/bot.state —— 前端首屏一次取完, 不用打七个请求、也不会出现
// 「一半面板有数、一半还在转」的观感。
//
// 两条硬规则:
// 1. 只读聚合不许编。取不到的值就是 null / 0, 不拿别处的数字凑。
// 2. 写操作全部走 /api/bot.manage 单入口, 动作白名单在 bot-store.apply 里,
//    越界的 key 直接丢弃 (前端传错字段不该把档案写成脏数据)。
import fs from "node:fs";
import path from "node:path";
import { BotStore } from "./bot-store.js";
import { logsDir, logicalDay } from "../utils/store.js";

const MAX_MEMORY_FILES = 200;
const MAX_AVATAR_B64 = 6 * 1024 * 1024; // base64 后约 4.5MB 原图, 与 store 的上限对齐

// 版本号: 不能只信 npm_package_version —— 文档里让人用 `node bin/ppx-web.js` 直接起,
// 那条路径下 npm_* 环境变量根本不存在, 设置页「关于」会显示成空。跟 bin/ppx-web.js 一样
// 直接读 package.json, 读不到才退回 0.0.0。
let PKG_VERSION = "0.0.0";
try {
  PKG_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || "0.0.0";
} catch {
  PKG_VERSION = process.env.npm_package_version || "0.0.0";
}

function safeName(s) {
  return String(s == null ? "" : s);
}

// 三态健康: ok = 测过并通过 / warn = 测过但有问题或未配置 / unknown = 没人看过
// dsh-bot 的原话是「没人看过」不能等同于「它没问题」, 这里照做。
function toneOf({ paused, pendingApprovals, failRate, lastError }) {
  if (lastError) return "error";
  if (pendingApprovals > 0) return "waiting";
  if (paused) return "quiet";
  const fr = Number(String(failRate || "0").replace("%", ""));
  if (Number.isFinite(fr) && fr > 30) return "warn";
  return "ok";
}

// 记忆文件树: 只扫 data/memory 下的文本类文件, 不递归进 node_modules 之类
function memoryFiles(agent) {
  const dir = path.join(agent.dataDir || path.join(agent.root, "data"), "memory");
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3 || out.length >= MAX_MEMORY_FILES) return;
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (out.length >= MAX_MEMORY_FILES) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(md|txt|json|jsonl)$/i.test(e.name)) continue;
      let st = null;
      try { st = fs.statSync(p); } catch { continue; }
      out.push({ path: path.relative(dir, p).replace(/\\/g, "/"), size: st.size, mtime: st.mtime.toISOString() });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// 会话/审批/工具等运行时事实
function liveOf(channel, agent) {
  const traces = agent.traces && typeof agent.traces.stats === "function" ? agent.traces.stats() : {};
  const usage = agent.usageStats || {};
  const lc = agent.lifecycleStatus ? agent.lifecycleStatus() : {};
  const tools = agent.tools && typeof agent.tools.listDetailed === "function" ? agent.tools.listDetailed() : [];
  const approvals = agent.pendingApprovals ? agent.pendingApprovals() : [];

  let board = { counts: {} };
  try { board = channel._taskBoard(agent).list(); } catch { /* 任务板没装配就空着 */ }

  let model = "";
  try { model = agent.llm?.model || agent.config?.providers?.[0]?.model || ""; } catch { /* 取不到留空 */ }

  const providers = (() => {
    try {
      const list = agent.allProviders || [];
      if (list.length) return list.map((p) => ({
        id: safeName(p.id || p.provider || p.name || p.label),
        model: safeName(p.model),
        // 只报「有没有配置」, 不报「能不能连」—— 连不连得上要实测才知道
        configured: Boolean(p.apiKey || p.key || p.local),
      }));
      return (agent.config?.providers || []).map((p) => ({
        id: safeName(p.id || p.provider || p.name),
        model: safeName(p.model),
        configured: Boolean(p.api_key_set || p.apiKey || p.local),
      }));
    } catch { return []; }
  })();

  return {
    heartbeatAt: new Date().toISOString(),
    uptimeMs: Math.round(process.uptime() * 1000),
    stage: lc.stage || null,
    chats: lc.chats ?? null,
    evolved: lc.evolved ?? null,
    ageDays: lc.ageDays ?? null,
    usage: { calls: usage.calls || 0, tokens: usage.tokens || 0, cost: usage.cost || 0 },
    traces: {
      count: traces.count || 0,
      failed: traces.failed || 0,
      failRate: traces.failRate || "0%",
      slowTools: traces.slowTools || [],
    },
    pendingApprovals: approvals.length,
    tools: { total: tools.length, enabled: tools.filter((t) => t.enabled).length },
    tasks: { counts: board.counts || {}, recent: (board.tasks || []).slice(0, 12) },
    model,
    providers,
    // 对话轮数是「用户真的发了话」的次数, 不是模型调用次数 —— 两者差一个量级
    turns: (() => {
      try {
        const all = agent.traces.read(undefined, 5000);
        return all.filter((t) => t.evt === "turn_end" || t.evt === "turn_start").length;
      } catch { return null; }
    })(),
    lastError: agent.lastError ? String(agent.lastError).slice(0, 200) : null,
  };
}

// 拼一份完整快照
export function buildBotState(channel) {
  const agent = channel.agent;
  const store = new BotStore({ root: agent.root, dataDir: agent.dataDir });
  const prof = store.ensure({ name: agent.config?.agent?.name || "皮皮虾", root: agent.root });
  const bot = prof.bots.find((b) => b.id === prof.current) || prof.bots[0];
  const live = liveOf(channel, agent);
  const perm = agent.permissions || {};

  // 服务健康: 模型 / 通道 / 记忆库。state 只有「测过通过 / 测过有问题 / 没测过」三态。
  const services = [];
  for (const p of live.providers) {
    // 有的 provider 只配了 model 没起 id, 直接拼 "id · model" 会变成 " · deepseek-chat"
    // 这种开头带分隔符的怪名字。两段都在才拼, 缺一段就用另一段。
    services.push({
      kind: "model",
      name: p.id && p.model ? `${p.id} · ${p.model}` : p.id || p.model || "未命名",
      state: p.configured ? "ok" : "unknown",
      detail: p.configured ? "已配置凭据" : "未配置 Key",
    });
  }
  const chCfg = agent.config?.channels || {};
  for (const name of ["http", "feishu", "wechat"]) {
    const c = chCfg[name];
    if (!c) continue;
    services.push({
      kind: "channel",
      name,
      state: c.enabled ? "ok" : "quiet",
      detail: c.enabled ? "已启用" : "未启用",
    });
  }

  const facts = agent.facts ? (agent.facts.list() || []).slice(0, 20).map((f) => ({ content: f.content, type: f.type, score: f.score })) : [];
  const scenes = agent.scenes && typeof agent.scenes.listWithDesc === "function" ? agent.scenes.listWithDesc().slice(-10) : [];
  const files = memoryFiles(agent);

  return {
    ok: true,
    now: new Date().toISOString(),
    version: PKG_VERSION,
    bot: {
      ...bot,
      avatarUrl: store.avatarPath(bot.id) ? `/api/bot.avatar?id=${encodeURIComponent(bot.id)}&v=${Date.now().toString(36)}` : null,
      typeName: (prof.types.find((t) => t.id === bot.type) || {}).name || bot.type,
    },
    bots: prof.bots.map((b) => ({
      id: b.id, name: b.name, type: b.type, pinned: b.pinned, paused: b.paused, updatedAt: b.updatedAt,
      typeName: (prof.types.find((t) => t.id === b.type) || {}).name || b.type,
    })),
    types: prof.types,
    live: {
      ...live,
      tone: toneOf({
        paused: bot.paused,
        pendingApprovals: live.pendingApprovals,
        failRate: live.traces.failRate,
        lastError: live.lastError,
      }),
      // 审批与模型是运行时事实, 不是档案 —— 分开放, 前端不混
      approvalMode: perm.approvalMode || null,
      sandbox: perm.sandbox || null,
    },
    settings: prof.settings,
    agenda: prof.agenda,
    memory: { factCount: agent.facts?.count?.() ?? facts.length, sceneCount: scenes.length, facts, scenes, files },
    services,
    workspace: agent.root,
  };
}

// ---- 轨迹: 工具调用 (day.jsonl) + 事件流 (events-day.jsonl) 合并 ----
// 为什么不直接复用 /api/traces: 那个端点只读「工具调用」那一路。某天如果只做了
// 记忆提炼 / persona 加载这类事 (没有一次工具调用), 轨迹页就会是空白 ——
// 用户看到的是「今天什么都没发生」, 而实际上发生了, 只是不在那个文件里。
// 两个文件同在 logs/traces, 一个叫 2026-10-27.jsonl, 一个叫 events-2026-10-27.jsonl。
function readJsonl(file, max = 3000) {
  let txt = "";
  try { txt = fs.readFileSync(file, "utf8"); } catch { return []; }
  return txt.split("\n").filter(Boolean).slice(-max)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function traceDir(agent) {
  return logsDir(agent.dataDir || path.join(agent.root, "data"));
}

export function listTraceDays(agent, max = 14) {
  let names = [];
  try { names = fs.readdirSync(traceDir(agent)); } catch { return []; }
  const days = names
    .map((n) => {
      const m = /^(?:events-)?(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n);
      return m ? m[1] : null;
    })
    .filter(Boolean);
  return [...new Set(days)].sort().reverse().slice(0, max);
}

function clip(s, n) {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export function buildTraces(agent, day, limit = 200) {
  const dir = traceDir(agent);
  const d = day || logicalDay();

  const tools = readJsonl(path.join(dir, `${d}.jsonl`)).map((t) => {
    let arg = "";
    try {
      arg = typeof t.args === "string" ? t.args : JSON.stringify(t.args || {});
    } catch { arg = ""; }
    return {
      ts: t.ts || null,
      kind: "tool",
      name: t.tool || t.evt || "tool",
      detail: clip(arg, 160),
      ok: t.ok !== false,
      ms: Number(t.durationMs) || 0,
      error: t.error || null,
    };
  });

  const events = readJsonl(path.join(dir, `events-${d}.jsonl`)).map((e) => {
    let detail = "";
    if (e.skipped) detail = "跳过: " + e.skipped;
    else if (e.round != null) detail = "第 " + e.round + " 轮";
    else if (e.reason) detail = String(e.reason);
    return {
      ts: e.ts || null,
      kind: "note",
      name: e.type || e.evt || "event",
      detail: clip(detail, 160),
      ok: e.ok !== false,
      ms: Number(e.durationMs) || 0,
      error: e.error || null,
    };
  });

  const all = tools.concat(events).sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  return {
    ok: true,
    day: d,
    days: listTraceDays(agent),
    events: all.slice(0, limit),
    stats: {
      count: all.length,
      tools: tools.length,
      notes: events.length,
      failed: all.filter((x) => !x.ok).length,
      totalMs: all.reduce((sum, x) => sum + x.ms, 0),
    },
  };
}

function parseDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || ""));
  if (!m) throw new Error("头像必须是 data:image/(png|jpeg|webp|gif);base64,…");
  if (m[2].length > MAX_AVATAR_B64) throw new Error("头像不能超过 4MB");
  const ext = "." + m[1].toLowerCase().replace("jpeg", "jpg");
  return { buf: Buffer.from(m[2], "base64"), ext };
}

// 写操作。返回 { ok, ... } —— 前端凭 ok 决定是否刷新快照。
export async function applyBotAction(channel, body) {
  const agent = channel.agent;
  const store = new BotStore({ root: agent.root, dataDir: agent.dataDir });
  const action = String(body.action || "");
  const done = (extra = {}) => ({ ok: true, action, state: buildBotState(channel), ...extra });

  switch (action) {
    case "avatar": {
      if (!body.dataUrl) {
        store.removeAvatar(body.id || "default");
        return done();
      }
      const { buf, ext } = parseDataUrl(body.dataUrl);
      store.saveAvatar(body.id || "default", buf, ext);
      return done();
    }
    case "memoryRead": {
      const rel = String(body.path || "");
      const dir = path.join(agent.dataDir || path.join(agent.root, "data"), "memory");
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(dir + path.sep)) throw new Error("路径越界");
      if (!fs.existsSync(abs)) throw new Error("文件不存在");
      const txt = fs.readFileSync(abs, "utf8");
      return { ok: true, action, path: rel, text: txt.slice(0, 200000), truncated: txt.length > 200000 };
    }
    case "memoryWrite": {
      const rel = String(body.path || "");
      const dir = path.join(agent.dataDir || path.join(agent.root, "data"), "memory");
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(dir + path.sep)) throw new Error("路径越界");
      if (!/\.(md|txt)$/i.test(abs)) throw new Error("只能写 .md / .txt 记忆文件");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(body.text || ""), "utf8");
      return done();
    }
    case "permission": {
      const p = agent.permissions;
      if (!p) throw new Error("权限引擎未装配");
      if (body.approvalMode) p.approvalMode = String(body.approvalMode);
      if (body.sandbox) p.sandbox = String(body.sandbox);
      if (body.networkAccess != null) p.networkAccess = !!body.networkAccess;
      return done();
    }
    case "proactive": {
      // 「现在就去看一眼」: 直接跑一次主动提醒扫描, 把结果回给前端, 不落库
      const mod = await import("../ans/proactive.js");
      const out = await mod.suggestProactive(agent);
      return done({ message: out ? out.text : null, items: out ? out.items : [] });
    }
    default: {
      // 其余动作全在档案层
      store.apply(action, body);
      return done();
    }
  }
}

// 路由入口: 由 HttpChannel._apiRoute 首行调用, 返回 true 表示已处理
export async function handleBotApi(channel, req, res, reqPath) {
  const get = req.method === "GET";

  if (get && reqPath === "/api/bot.state") {
    try {
      channel._json(res, 200, buildBotState(channel), { "Cache-Control": "no-store" });
    } catch (e) {
      channel._json(res, 500, { ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  if (get && reqPath === "/api/bot.traces") {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      const day = (u.searchParams.get("day") || "").trim();
      const limit = Math.min(1000, Math.max(20, Number(u.searchParams.get("limit")) || 200));
      channel._json(res, 200, buildTraces(channel.agent, day || undefined, limit), { "Cache-Control": "no-store" });
    } catch (e) {
      channel._json(res, 500, { ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  if (get && reqPath === "/api/bot.avatar") {
    const id = decodeURIComponent((req.url.split("id=")[1] || "").split("&")[0] || "default");
    const store = new BotStore({ root: channel.agent.root, dataDir: channel.agent.dataDir });
    const p = store.avatarPath(id);
    if (!p) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("no avatar"); return true; }
    const ext = path.extname(p).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
    res.end(fs.readFileSync(p));
    return true;
  }

  if (req.method === "POST" && reqPath === "/api/bot.manage") {
    const raw = await channel._readBody(req, res);
    if (raw === null) return true;
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { channel._json(res, 400, { ok: false, error: "非法 JSON" }); return true; }
    try {
      const out = await applyBotAction(channel, body);
      channel._json(res, 200, out);
    } catch (e) {
      channel._json(res, 400, { ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  return false;
}
