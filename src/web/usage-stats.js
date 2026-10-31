// src/web/usage-stats.js - 「使用统计」页的只读聚合
//
// 三条数据来源, 各管一件事, 互不冒充:
//   1. agent.usageStats.days  —— 按天 × 按模型的 token 账本 (趋势 / 热力 / 峰值)
//   2. data/sessions/*.jsonl  —— 会话事件流 (聊天时长 / 消息数 / 活跃日)
//   3. agent.usageStats 累计字段 —— 总 token / 调用数 / 模型占比
//
// 账本按天分桶是 2026-10-31 才加的, 之前的历史只有累计值 —— 不拿累计值去填某一天的
// 柱子假装那是当天用量。取不到就是空, 页面上写清楚从哪天开始有数。
import fs from "node:fs";
import path from "node:path";
import { logicalDay } from "../utils/store.js";

const MAX_SESSION_FILES = 300;
const MAX_SESSION_BYTES = 16 * 1024 * 1024; // 超过这个体积的会话只读头尾取首末时间戳
const SESSION_EDGE_BYTES = 1 * 1024 * 1024;
const IDLE_GAP_MS = 30 * 60 * 1000; // 超过 30 分钟的空档算「人走了」, 不计入聊天时长

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

function sessionsDir(agent) {
  return path.join(agent.dataDir || path.join(agent.root, "data"), "sessions");
}

function readTitles(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "_titles.json"), "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}

// 逐行取 ts: 整读小文件, 大文件只读头尾 (首末时间戳不需要中间内容)
function sessionEvents(file, size) {
  const parse = (text) => {
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (Number.isFinite(j.ts)) out.push({ ts: j.ts, type: String(j.type || "") });
      } catch { /* 半行 (进程被 kill 时常见) 跳过 */ }
    }
    return out;
  };
  if (size <= MAX_SESSION_BYTES) return { events: parse(fs.readFileSync(file, "utf8")), partial: false };
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(SESSION_EDGE_BYTES);
    const hn = fs.readSync(fd, buf, 0, SESSION_EDGE_BYTES, 0);
    const head = parse(buf.subarray(0, hn).toString("utf8"));
    const tailStart = Math.max(0, size - SESSION_EDGE_BYTES);
    const tn = fs.readSync(fd, buf, 0, SESSION_EDGE_BYTES, tailStart);
    const tailRaw = buf.subarray(0, tn).toString("utf8");
    // 尾部切片的第一行大概率是被截断的半行, 丢掉
    const tail = parse(tailRaw.slice(tailRaw.indexOf("\n") + 1));
    return { events: head.concat(tail), partial: true };
  } finally {
    fs.closeSync(fd);
  }
}

// 会话画像: 时长 (扣掉空档) + 消息数 + 活跃日
function scanSessions(agent) {
  const dir = sessionsDir(agent);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^s_\w+\.jsonl$/i.test(f));
  } catch { return { sessions: [], days: new Set(), messages: 0 }; }
  const titles = readTitles(dir);
  const sessions = [];
  const days = new Set();
  let messages = 0;
  for (const name of names.slice(0, MAX_SESSION_FILES)) {
    const file = path.join(dir, name);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { continue; }
    if (!size) continue;
    let events;
    try {
      events = sessionEvents(file, size).events;
    } catch { continue; }
    if (!events.length) continue;
    events.sort((a, b) => a.ts - b.ts);
    let activeMs = 0;
    for (let i = 1; i < events.length; i++) {
      const gap = events[i].ts - events[i - 1].ts;
      if (gap > 0 && gap <= IDLE_GAP_MS) activeMs += gap;
    }
    let userMsgs = 0;
    const sessionDays = new Set();
    for (const e of events) {
      sessionDays.add(logicalDay(new Date(e.ts)));
      if (e.type === "user/message") userMsgs++;
    }
    messages += userMsgs;
    for (const d of sessionDays) days.add(d);
    const id = name.replace(/\.jsonl$/i, "");
    sessions.push({
      id,
      title: String(titles[id] || "").slice(0, 60),
      startAt: new Date(events[0].ts).toISOString(),
      endAt: new Date(events[events.length - 1].ts).toISOString(),
      spanMs: events[events.length - 1].ts - events[0].ts,
      activeMs,
      events: events.length,
      messages: userMsgs,
      days: [...sessionDays].sort(),
    });
  }
  return { sessions, days, messages };
}

// 连续天数: 从活跃日集合上数连续的自然日。
// 当前连续以「今天或昨天」为锚 —— 今天还没开工不该把昨天的坚持清零。
function streaks(daySet, today) {
  const days = [...daySet].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!days.length) return { current: 0, longest: 0, first: null, last: null };
  const ms = (d) => Date.parse(d + "T00:00:00Z");
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = Math.round((ms(days[i]) - ms(days[i - 1])) / 86400000);
    run = diff === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  const t = ms(today);
  const last = ms(days[days.length - 1]);
  if (t - last > 86400000) return { current: 0, longest, first: days[0], last: days[days.length - 1] };
  let current = 1;
  for (let i = days.length - 1; i > 0; i--) {
    if (Math.round((ms(days[i]) - ms(days[i - 1])) / 86400000) === 1) current++;
    else break;
  }
  return { current, longest, first: days[0], last: days[days.length - 1] };
}

export function buildUsageStats(agent) {
  const u = agent.usageStats || {};
  const days = (u.days && typeof u.days === "object") ? u.days : {};
  const today = logicalDay();

  // --- 按天序列 (升序, 只含有账的日期) ---
  const daily = Object.keys(days).sort().map((day) => {
    const b = days[day] || {};
    const byModel = {};
    for (const [m, v] of Object.entries((b.byModel && typeof b.byModel === "object") ? b.byModel : {})) {
      byModel[m] = num(v && v.tokens);
    }
    return { day, tokens: num(b.tokens), calls: num(b.calls), byModel };
  }).filter((d) => d.calls > 0);

  // --- 峰值日 ---
  const peak = daily.length
    ? daily.reduce((a, b) => (b.tokens > a.tokens ? b : a))
    : null;

  // --- 模型占比 (累计, 与按天账本无关, 升级前就有数) ---
  const byModelRaw = (u.byModel && typeof u.byModel === "object") ? u.byModel : {};
  const totalTokens = num(u.tokens);
  const models = Object.entries(byModelRaw)
    .map(([model, v]) => ({
      model,
      tokens: num(v && v.tokens),
      calls: num(v && v.calls),
      cost: num(v && v.cost),
      share: totalTokens > 0 ? num(v && v.tokens) / totalTokens : 0,
    }))
    .filter((m) => m.tokens > 0 || m.calls > 0)
    .sort((a, b) => b.tokens - a.tokens);

  // --- 会话 ---
  const chat = scanSessions(agent);
  const longest = chat.sessions.length
    ? chat.sessions.reduce((a, b) => (b.activeMs > a.activeMs ? b : a))
    : null;

  // --- 活跃日 = 有模型调用 ∪ 有会话消息 ---
  const activeDays = new Set(chat.days);
  for (const d of daily) if (d.calls > 0) activeDays.add(d.day);
  const st = streaks(activeDays, today);

  const pt = num(u.promptTokens);
  const ch = num(u.cacheHitTokens);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    today,
    totals: {
      tokens: totalTokens,
      calls: num(u.calls),
      cost: num(u.cost),
      promptTokens: pt,
      cacheHitTokens: ch,
      cacheHitPct: pt > 0 ? ch / pt : null,
      models,
    },
    peak: peak ? { day: peak.day, tokens: peak.tokens, calls: peak.calls } : null,
    streak: {
      current: st.current,
      longest: st.longest,
      activeDays: activeDays.size,
      firstDay: st.first,
      lastDay: st.last,
    },
    ledger: {
      // 按天账本的起点 —— 页面用它说明「趋势为什么从今天才有」, 不拿累计值补历史
      since: daily.length ? daily[0].day : null,
      days: daily.length,
    },
    chat: {
      sessions: chat.sessions.length,
      messages: chat.messages,
      longestMs: longest ? longest.activeMs : 0,
      longestSpanMs: longest ? longest.spanMs : 0,
      longestSession: longest ? { id: longest.id, title: longest.title, startAt: longest.startAt, days: longest.days } : null,
      recent: chat.sessions
        .slice()
        .sort((a, b) => (a.endAt < b.endAt ? 1 : -1))
        .slice(0, 12)
        .map((s) => ({ id: s.id, title: s.title, day: s.days[s.days.length - 1] || null, activeMs: s.activeMs, messages: s.messages })),
    },
    daily,
  };
}

export async function handleUsageStatsApi(channel, req, res, reqPath) {
  if (req.method !== "GET" || reqPath !== "/api/usage/stats") return false;
  if (!channel._requireAuth(req, res)) return true;
  try {
    channel._json(res, 200, buildUsageStats(channel.agent), { "Cache-Control": "no-store" });
  } catch (e) {
    channel._json(res, 500, { ok: false, error: String(e?.message || e) });
  }
  return true;
}
