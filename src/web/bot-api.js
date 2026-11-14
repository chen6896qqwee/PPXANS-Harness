// src/web/bot-api.js - 本体 (bot) 形态的写操作与路由
//
// 2026-11-12 拆分: 只读聚合 (buildBotState / buildTraces / buildBodyState) 移到
// ./bot-view.js —— 两个文件各自回答一个问题: bot-view 是「现在是什么样」,
// 这里是「要改什么 / 从哪条路由进来」。前端拿到的快照结构不变。
//
// 两条硬规则:
// 1. 只读聚合不许编。取不到的值就是 null / 0, 不拿别处的数字凑。
// 2. 写操作全部走 /api/bot.manage 单入口, 动作白名单在 bot-store.apply 里,
//    越界的 key 直接丢弃 (前端传错字段不该把档案写成脏数据)。
import fs from "node:fs";
import path from "node:path";
import { BotStore } from "./bot-store.js";
import { applyPermissionUpdate } from "../permissions/index.js";
import { handleReadiness } from "./readiness.js";
import { buildBotState, buildBodyState, buildTraces } from "./bot-view.js";

const MAX_AVATAR_B64 = 6 * 1024 * 1024; // base64 后约 4.5MB 原图, 与 store 的上限对齐

function parseDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || ""));
  if (!m) throw new Error("头像必须是 data:image/(png|jpeg|webp|gif);base64,…");
  if (m[2].length > MAX_AVATAR_B64) throw new Error("头像不能超过 4MB");
  const ext = "." + m[1].toLowerCase().replace("jpeg", "jpg");
  return { buf: Buffer.from(m[2], "base64"), ext };
}

// 写操作。返回 { ok, ... } —— 前端凭 ok 决定是否刷新快照。
async function applyBotAction(channel, body) {
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
      // 2026-11-03: 确认码双门已拆, 放宽/收紧都即时生效。
      // 2026-11-14 (战役遗留项 #8): 校验/提权留痕/落字段收敛到 permissions.applyPermissionUpdate
      //   —— 与 POST /api/permissions 同一实现, 双轨靠注释自觉同步的时代结束。
      //   值合法性 fail-closed (throw → 上层 400), 提权留痕 (source=bot.manage)。
      // 评测-II P1-1: dir 显式传 agent.dataDir, flag 落本 agent 数据目录 (与 /api/permissions 同语义)。
      applyPermissionUpdate(agent.permissions, body, { agent, source: "bot.manage", dir: agent.dataDir });
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

  // GET /api/readiness — 首启就绪判定 (模型是否可用 / 工作区是否可写)
  if (handleReadiness(channel, req, res, reqPath)) return true;

  if (get && reqPath === "/api/body.state") {
    try {
      channel._json(res, 200, buildBodyState(channel), { "Cache-Control": "no-store" });
    } catch (e) {
      channel._json(res, 500, { ok: false, error: String(e?.message || e) });
    }
    return true;
  }

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
