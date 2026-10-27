// src/web/bot-store.js - 本体档案 (bot profile) 持久化
//
// 2026-10-27: 前端改为 bot 形态后, 需要一份「本体自己是谁」的档案 —— 名字/类型/
// 头像/置顶/暂停/工作区, 以及设置页上的规则·限额·自主时间·晨间简报·日程。
// 这些数据 agent 内核里没有对应字段 (它们是界面层概念), 又不能塞进 config/ppx.json
// (那份是运行时配置, 手改会覆盖), 所以单独落在 data/bots/profile.json。
//
// 设计取舍:
// - 单文件 JSON, 不做数据库。理由: 体量小 (几 KB)、要人肉可编辑、要能跟着工作区一起搬。
// - 读时补默认值、写时整体原子替换。不做「部分字段继承内置默认」的复杂合并 ——
//   那种合并最容易在升级后出现「老档案缺新字段 → 界面崩」的隐性坑。
// - 写盘走 utils/store.js 的 atomicWrite, 断电/中断不会留半截 JSON。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, atomicWrite, readText } from "../utils/store.js";

// 内置本体类型。用户可再建自定义类型, 自定义的追加在后, 不覆盖内置。
export const BUILTIN_TYPES = [
  { id: "companion", name: "伴侣", blurb: "记得你的偏好和情绪，会主动关心", builtin: true },
  { id: "assistant", name: "助手", blurb: "干活为主，少废话，直接给结果", builtin: true },
  { id: "researcher", name: "研究员", blurb: "查证、对比、给证据链，不确定就说不确定", builtin: true },
  { id: "scribe", name: "记录员", blurb: "把过程记下来，沉淀成可复用的笔记", builtin: true },
];

// 自主模式: read 只读观察 / review 可动手但每步审查 / full 完全权限
export const AUTONOMY_MODES = ["read", "review", "full"];

const DEFAULTS = {
  version: 1,
  bots: [],
  types: [],
  agenda: [],
  settings: {
    rules: { background: "ask", outbound: "ask" },
    worker: { enabled: false, pollSeconds: 30, concurrency: 1, todayRuns: 0, day: "" },
    limits: {
      maxTaskMinutes: 30,
      dailyMinutes: 240,
      maxToolCalls: 120,
      queueKeep: 50,
      replayKeep: 20,
      panelLimit: 100,
    },
    autonomy: { enabled: false, idleMinutes: 20, maxPerHour: 3, mode: "read", model: null },
    briefing: { enabled: false, time: "08:30", lastAt: null },
  },
};

const AVATAR_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// 只接受白名单键, 且类型不对就用默认值 —— 防止手改档案把人写崩
function num(v, dflt, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(v, dflt) {
  return typeof v === "boolean" ? v : dflt;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export class BotStore {
  constructor({ root, dataDir } = {}) {
    this.root = path.resolve(root || process.cwd());
    this.dir = path.join(dataDir || path.join(this.root, "data"), "bots");
    this.file = path.join(this.dir, "profile.json");
  }

  // ---- 磁盘 ----
  readRaw() {
    try {
      const txt = readText(this.file);
      if (!txt) return null;
      const j = JSON.parse(txt);
      return j && typeof j === "object" ? j : null;
    } catch {
      // 档案坏了不能让整个界面挂: 退回默认, 保留损坏文件副本供排查
      try {
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + ".broken");
      } catch { /* 备份失败也不阻塞 */ }
      return null;
    }
  }

  writeRaw(obj) {
    ensureDir(this.dir);
    atomicWrite(this.file, JSON.stringify(obj, null, 2) + "\n");
  }

  // ---- 归一整份档案 ----
  // 缺字段补默认, 类型不对纠正。返回的对象可直接给前端, 也可直接落盘。
  normalize(raw, { name, root } = {}) {
    const base = clone(DEFAULTS);
    const src = raw && typeof raw === "object" ? raw : {};

    const types = [
      ...BUILTIN_TYPES,
      ...(Array.isArray(src.types) ? src.types : [])
        .filter((t) => t && t.id && t.name && !BUILTIN_TYPES.some((b) => b.id === t.id))
        .map((t) => ({ id: String(t.id), name: String(t.name), blurb: String(t.blurb || ""), builtin: false })),
    ];

    // 本体清单: 空档案时自动派生一个「默认本体」= 当前工作区这个皮皮虾
    let bots = Array.isArray(src.bots) ? src.bots.filter((b) => b && b.id) : [];
    if (!bots.length) {
      bots = [{
        id: "default",
        name: name || "皮皮虾",
        type: "assistant",
        blurb: "",
        pinned: true,
        paused: false,
        workspace: root || this.root,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }];
    }
    bots = bots.map((b) => ({
      id: String(b.id),
      name: String(b.name || "皮皮虾"),
      type: String(b.type || "assistant"),
      blurb: String(b.blurb || ""),
      pinned: bool(b.pinned, false),
      paused: bool(b.paused, false),
      workspace: String(b.workspace || this.root),
      createdAt: b.createdAt || new Date().toISOString(),
      updatedAt: b.updatedAt || new Date().toISOString(),
    }));

    const s = src.settings && typeof src.settings === "object" ? src.settings : {};
    const rules = s.rules && typeof s.rules === "object" ? s.rules : {};
    const worker = s.worker && typeof s.worker === "object" ? s.worker : {};
    const limits = s.limits && typeof s.limits === "object" ? s.limits : {};
    const autonomy = s.autonomy && typeof s.autonomy === "object" ? s.autonomy : {};
    const briefing = s.briefing && typeof s.briefing === "object" ? s.briefing : {};

    const agenda = (Array.isArray(src.agenda) ? src.agenda : [])
      .filter((a) => a && a.text)
      .map((a) => ({
        id: String(a.id || crypto.randomUUID().slice(0, 8)),
        text: String(a.text),
        at: a.at || null,
        done: bool(a.done, false),
        createdAt: a.createdAt || new Date().toISOString(),
      }));

    const current = src.current && bots.some((b) => b.id === src.current) ? src.current : bots[0].id;

    return {
      version: 1,
      current,
      bots,
      types,
      agenda,
      settings: {
        rules: {
          background: ["auto", "preapproved", "ask", "handoff"].includes(rules.background) ? rules.background : base.settings.rules.background,
          outbound: ["auto", "preapproved", "ask", "handoff"].includes(rules.outbound) ? rules.outbound : base.settings.rules.outbound,
        },
        worker: {
          enabled: bool(worker.enabled, base.settings.worker.enabled),
          pollSeconds: num(worker.pollSeconds, 30, 5, 3600),
          concurrency: num(worker.concurrency, 1, 1, 8),
          // 今日计数跨天自动归零 —— 否则昨天的数字会一直挂到今天
          day: worker.day === todayKey() ? worker.day : todayKey(),
          todayRuns: worker.day === todayKey() ? num(worker.todayRuns, 0, 0) : 0,
        },
        limits: {
          maxTaskMinutes: num(limits.maxTaskMinutes, base.settings.limits.maxTaskMinutes, 0, 1440),
          dailyMinutes: num(limits.dailyMinutes, base.settings.limits.dailyMinutes, 0, 1440),
          maxToolCalls: num(limits.maxToolCalls, base.settings.limits.maxToolCalls, 0, 10000),
          queueKeep: num(limits.queueKeep, base.settings.limits.queueKeep, 0, 10000),
          replayKeep: num(limits.replayKeep, base.settings.limits.replayKeep, 0, 10000),
          panelLimit: num(limits.panelLimit, base.settings.limits.panelLimit, 0, 1000),
        },
        autonomy: {
          enabled: bool(autonomy.enabled, false),
          idleMinutes: num(autonomy.idleMinutes, 20, 1, 1440),
          maxPerHour: num(autonomy.maxPerHour, 3, 1, 120),
          mode: AUTONOMY_MODES.includes(autonomy.mode) ? autonomy.mode : "read",
          model: autonomy.model && typeof autonomy.model === "object" ? { provider: String(autonomy.model.provider || ""), model: String(autonomy.model.model || "") } : null,
        },
        briefing: {
          enabled: bool(briefing.enabled, false),
          time: /^\d{2}:\d{2}$/.test(String(briefing.time || "")) ? briefing.time : "08:30",
          lastAt: briefing.lastAt || null,
        },
      },
    };
  }

  // 读一份可用档案 (不落盘)
  load({ name, root } = {}) {
    return this.normalize(this.readRaw(), { name, root });
  }

  // 读 + 落盘 (补全缺失字段)。首次启动会把默认档案写出来, 之后人是可编辑的。
  ensure({ name, root } = {}) {
    const prof = this.load({ name, root });
    try { this.writeRaw(prof); } catch { /* 只读文件系统下不阻塞启动 */ }
    return prof;
  }

  save(prof) {
    const norm = this.normalize(prof, {});
    this.writeRaw(norm);
    return norm;
  }

  // ---- 动作 ----
  // 应用一次写操作。action 由 /api/bot.manage 传入, 这里只管档案层的语义,
  // 涉及 agent 运行时的部分 (权限/模型) 由调用方 (bot-api) 处理。
  apply(action, payload = {}) {
    const prof = this.ensure({});
    const bot = prof.bots.find((b) => b.id === (payload.id || prof.current)) || prof.bots[0];

    switch (action) {
      case "rename": {
        const name = String(payload.name || "").trim();
        if (!name) throw new Error("名字不能为空");
        bot.name = name.slice(0, 40);
        break;
      }
      case "type": {
        const t = prof.types.find((x) => x.id === payload.typeId);
        if (!t) throw new Error(`未知类型: ${payload.typeId}`);
        bot.type = t.id;
        break;
      }
      case "blurb": {
        bot.blurb = String(payload.blurb || "").slice(0, 200);
        break;
      }
      case "pin": {
        bot.pinned = !!payload.pinned;
        break;
      }
      case "pause": {
        bot.paused = !!payload.paused;
        break;
      }
      case "workspace": {
        const p = String(payload.workspace || "").trim();
        if (!p) throw new Error("工作区路径不能为空");
        bot.workspace = path.resolve(p);
        break;
      }
      case "settings": {
        // 白名单合并: 只认识 rules / worker / limits / autonomy / briefing
        const patch = payload.patch && typeof payload.patch === "object" ? payload.patch : {};
        for (const k of Object.keys(patch)) {
          if (!(k in prof.settings)) continue;
          if (k === "rules" || k === "worker" || k === "limits" || k === "autonomy" || k === "briefing") {
            prof.settings[k] = { ...prof.settings[k], ...patch[k] };
          }
        }
        break;
      }
      case "agendaAdd": {
        const text = String(payload.text || "").trim();
        if (!text) throw new Error("日程内容不能为空");
        prof.agenda.unshift({
          id: crypto.randomUUID().slice(0, 8),
          text: text.slice(0, 200),
          at: payload.at ? String(payload.at) : null,
          done: false,
          createdAt: new Date().toISOString(),
        });
        break;
      }
      case "agendaDone": {
        const it = prof.agenda.find((a) => a.id === payload.agendaId);
        if (!it) throw new Error("日程不存在");
        it.done = payload.done === false ? false : true;
        break;
      }
      case "agendaRemove": {
        const i = prof.agenda.findIndex((a) => a.id === payload.agendaId);
        if (i < 0) throw new Error("日程不存在");
        prof.agenda.splice(i, 1);
        break;
      }
      case "typeAdd": {
        const name = String(payload.name || "").trim();
        if (!name) throw new Error("类型名不能为空");
        const id = "u-" + crypto.randomUUID().slice(0, 6);
        prof.types.push({ id, name: name.slice(0, 20), blurb: String(payload.blurb || "").slice(0, 80), builtin: false });
        break;
      }
      case "typeRemove": {
        const t = prof.types.find((x) => x.id === payload.typeId);
        if (!t) throw new Error("类型不存在");
        if (t.builtin) throw new Error("内置类型不可删除");
        prof.types = prof.types.filter((x) => x.id !== t.id);
        // 用着这个类型的本体回落到助手, 不留悬空引用
        for (const b of prof.bots) if (b.type === t.id) b.type = "assistant";
        break;
      }
      case "briefingNow": {
        prof.settings.briefing.lastAt = new Date().toISOString();
        break;
      }
      default:
        throw new Error(`未知动作: ${action}`);
    }

    bot.updatedAt = new Date().toISOString();
    return this.save(prof);
  }

  // ---- 头像 ----
  avatarPath(id = "default") {
    for (const ext of AVATAR_EXT) {
      const p = path.join(this.dir, `avatar-${id}${ext}`);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  saveAvatar(id, buf, ext) {
    const e = String(ext || "").toLowerCase();
    if (!AVATAR_EXT.includes(e)) throw new Error("仅支持 png / jpg / webp / gif");
    if (!buf || !buf.length) throw new Error("空文件");
    if (buf.length > MAX_AVATAR_BYTES) throw new Error("头像不能超过 4MB");
    ensureDir(this.dir);
    // 换格式时把旧文件清掉, 否则 avatarPath 会先命中旧扩展名
    for (const old of AVATAR_EXT) {
      if (old === e) continue;
      const p = path.join(this.dir, `avatar-${id}${old}`);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* 删不掉不影响新图 */ }
    }
    const p = path.join(this.dir, `avatar-${id}${e}`);
    fs.writeFileSync(p, buf);
    return p;
  }

  removeAvatar(id) {
    for (const ext of AVATAR_EXT) {
      const p = path.join(this.dir, `avatar-${id}${ext}`);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* 忽略 */ }
    }
  }
}
