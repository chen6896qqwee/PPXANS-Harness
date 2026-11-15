// src/memory/session-meta.js - 会话元数据: 归档标记 / 标题覆盖 / 自动命名 / 列表与检索 (mixin, 从 session.js 拆出)
// 元数据字段与事件日志完全解耦 (独立的 _archive.json / _titles.json), 只读写 this._archived / this._titles;
// list/search 是事件日志的读投影, 只是把元数据一并拼进结果。
// 依赖约束: 不得 import session.js (宿主), 否则成环。
import { noteCatch } from "../utils/catch-log.js";
import { atomicWrite, withFileLock } from "../utils/store.js";
import { EVENTS } from "./session-events.js";
import fs from "node:fs";
import path from "node:path";

// 三组元数据的统一落盘/加载 (2026-11-12):
//  旧实现固定写 `${file}.tmp` 且无锁 —— web/CLI 两个进程共用 dataDir 同时保存时,
//  后来的进程会覆盖前者的临时文件, 且整表覆盖导致另一边刚写的键丢失。
//  现在: 唯一临时名原子写 + 文件锁, 锁内以磁盘现状为底, 只叠加本实例自加载以来的变更
//  (base → current 的 diff), 删除通过 base 中消失的键传播, 双写互不吞键。
function _applyDiff(base, current, disk) {
  const out = { ...disk };
  for (const k of Object.keys(current)) {
    if (!(k in base) || base[k] !== current[k]) out[k] = current[k];
  }
  for (const k of Object.keys(base)) if (!(k in current)) delete out[k];
  return out;
}
function _resetTo(obj, next) {
  for (const k of Object.keys(obj)) delete obj[k];
  Object.assign(obj, next);
}

export const sessionMetaMethods = {
  _metaLoad(file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
    } catch (e) {
      if (e?.code === "ENOENT") return {}; // 不存在 → 空
      // 损坏: 改名留档 (不删不覆盖), 让上层从空表继续; 下次启动不再重复报同一份
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch (e2) { noteCatch(e2); }
      noteCatch("src/memory/session-meta.js#_metaLoad", e);
      return {};
    }
  },
  _metaSave(file, current, base) {
    try {
      withFileLock(file, () => {
        let disk = {};
        try {
          const raw = JSON.parse(fs.readFileSync(file, "utf8"));
          if (raw && typeof raw === "object" && !Array.isArray(raw)) disk = raw;
        } catch (e) { if (e?.code !== "ENOENT") noteCatch(e); }
        const merged = _applyDiff(base || {}, current, disk);
        atomicWrite(file, JSON.stringify(merged, null, 2));
        _resetTo(current, merged);
        if (base) _resetTo(base, merged);
      });
    } catch (e) { noteCatch("src/memory/session-meta.js#_metaSave", e); /* 标记落盘失败不阻塞主流程 */ }
  },

  // ---- 会话自动归档 (2026-10-11): 不删数据只打标记, 归档会话在列表收起、可随时恢复 ----
  //   误归档零成本恢复; 事件日志/派生消息不受任何影响, 归档会话点开仍能看完整历史。
  _archivePath() { return path.join(this.dir, "_archive.json"); },
  _loadArchive() { return this._metaLoad(this._archivePath()); },
  _saveArchive() { this._metaSave(this._archivePath(), this._archived, this._archivedBase); },
  archive(key) {
    const k = this._safe(key);
    const evs = this._logs.get(k);
    if (!evs || !evs.length) return false;
    this._archived[k] = Date.now();
    this._saveArchive();
    return true;
  },
  unarchive(key) {
    const k = this._safe(key);
    if (!(k in this._archived)) return false;
    delete this._archived[k];
    this._saveArchive();
    return true;
  },
  // 自动归档: lastTs 超过 days 天未活跃的会话打归档标记 (default 主会话与 keep 名单豁免)。
  // 返回本次新归档的 key 列表。0/负 days = 关闭自动归档。
  autoArchive({ days = 7, keep = [] } = {}) {
    if (!(days > 0)) return [];
    const cutoff = Date.now() - days * 86400000;
    const keepSet = new Set([...keep, "default"].map((k) => this._safe(k)));
    const done = [];
    for (const [key, events] of this._logs) {
      if (keepSet.has(key) || this._archived[key]) continue;
      const lastTs = events.length ? events[events.length - 1].ts : 0;
      if (lastTs && lastTs < cutoff) { this._archived[key] = Date.now(); done.push(key); }
    }
    if (done.length) this._saveArchive();
    return done;
  },

  // ---- 会话置顶 (2026-11-03): 只影响 list() 排序 ----
  // 独立落盘 data/sessions/_pinned.json ({ key: pinnedAt }); 不碰事件日志/标题/归档。
  // 与归档的关系: 置顶优先于"按最近活跃排序", 但归档分组仍单独处理 —— 置顶一个已归档会话
  // 不会把它从归档组里拽出来, 避免"置顶 = 悄悄取消归档"的隐性副作用。
  _pinnedPath() { return path.join(this.dir, "_pinned.json"); },
  _loadPinned() { return this._metaLoad(this._pinnedPath()); },
  _savePinned() { this._metaSave(this._pinnedPath(), this._pinned, this._pinnedBase); },
  pin(key) {
    const k = this._safe(key);
    const evs = this._logs.get(k);
    if (!evs || !evs.length) return false;
    this._pinned[k] = Date.now();
    this._savePinned();
    return true;
  },
  unpin(key) {
    const k = this._safe(key);
    if (!(k in this._pinned)) return false;
    delete this._pinned[k];
    this._savePinned();
    return true;
  },
  isPinned(key) { return !!this._pinned[this._safe(key)]; },

  // ---- 会话标题覆盖 (2026-10-11): 改名不改内容/归属/排序/归档 ----
  // 标题默认从第一条用户消息派生 (list 里 slice(0,20)); 本机制提供独立覆盖字段,
  // 存 data/sessions/_titles.json ({ key: title }), 与事件日志 append-only 完全解耦。
  _titlesPath() { return path.join(this.dir, "_titles.json"); },
  _loadTitles() { return this._metaLoad(this._titlesPath()); },
  _saveTitles() { this._metaSave(this._titlesPath(), this._titles, this._titlesBase); },
  // 设置自定义标题; title 为空串则清除覆盖、回退到派生标题。返回是否变更。
  setTitle(key, title) {
    const k = this._safe(key);
    if (!this._logs.has(k)) return false;
    const t = String(title || "").trim();
    if (t) { this._titles[k] = t; this._saveTitles(); return true; }
    if (k in this._titles) { delete this._titles[k]; this._saveTitles(); }
    return true;
  },
  getTitle(key) {
    const k = this._safe(key);
    return this._titles[k] || "";
  },

  // ---- 孤儿标题回收 (评测-II P2-3): 标题台账与正文文件的生命周期对齐 ----
  // 病根: delete(key)/pruneOld/rename 只删正文文件, _titles.json 的键永远留着 ——
  //   生产实测 (2026-11-14) 13 个标题只剩 5 份正文。11-14 已落地 delete 前归档
  //   (archive-before-delete), 本方法收尾历史存量: 构造时对 s_* 键做一次对账,
  //   正文文件缺失的标题移出台账, 移除项合并备份到 _titles.orphans.json (可追溯)。
  // 边界: 只对账 /^s_/ 会话键 —— default 按天分片 (default-YYYY-MM-DD.jsonl) 与
  //   ppx_cron_* 等非"键名直映文件名"的键解析规则不同, 不在本方法职责内。
  _reconcileOrphanTitles() {
    const orphans = [];
    for (const k of Object.keys(this._titles)) {
      if (!/^s_/.test(k)) continue;
      let exists = false;
      try { exists = fs.existsSync(this._file(this._safe(k))); } catch (e) {
        // 探测失败按"正文存在"处理 (宁可不回收, 不误删有正文会话的标题); 非 ENOENT 留痕
        if (e?.code !== "ENOENT") noteCatch("src/memory/session-meta.js#_reconcileOrphanTitles.exists", e);
        exists = true;
      }
      if (exists) continue;
      orphans.push([k, this._titles[k]]);
      delete this._titles[k];
    }
    if (!orphans.length) return 0;
    const backupPath = path.join(this.dir, "_titles.orphans.json");
    try {
      let prev = this._metaLoad(backupPath); // 损坏/缺失时 _metaLoad 自行留痕并返回 {}
      for (const [k, t] of orphans) if (!(k in prev)) prev[k] = t;
      atomicWrite(backupPath, JSON.stringify(prev, null, 2));
    } catch (e) { noteCatch("src/memory/session-meta.js#_reconcileOrphanTitles.backup", e); /* 备份失败不阻断回收 */ }
    this._saveTitles();
    return orphans.length;
  },

  // ---- 新会话自动命名 (2026-10-11): 首条用户消息落盘且无自定义标题时生成 "MMDD|类型|主题" ----
  // 纯规则、确定性、零 LLM 开销。日期取首条消息 ts 转 Asia/Shanghai (UTC+8)。
  _guessType(text) {
    const t = text.toLowerCase();
    const rules = [
      ["修复", /修复|bug|报错|错误|异常|坏了|闪退|崩溃|出问题|不好使|错乱/],
      ["发布", /发布|上线|部署|打包|release|deploy/],
      ["优化", /优化|改进|提速|加速|性能|变慢|卡顿|精简/],
      ["设计", /设计|界面|ui|样式|配色|布局|交互|美化|好看/],
      ["文档", /文档|readme|说明|注释|教程/],
      ["研究", /研究|调研|分析|对比|评估|测评|比较/],
      ["功能", /功能|实现|开发|新增|添加|做一个|写一个|写个|支持|接入|集成|安装/],
    ];
    for (const [name, re] of rules) if (re.test(t)) return name;
    return "探索";
  },
  _autoTitleRule(content, ts) {
    const raw = String(content || "").trim();
    if (!raw) return "";
    // MMDD: 首条消息时间 + 8h → UTC 字段即上海本地月/日
    const sh = new Date((Number.isFinite(ts) ? ts : Date.now()) + 8 * 3600000);
    const mmdd = String(sh.getUTCMonth() + 1).padStart(2, "0") + String(sh.getUTCDate()).padStart(2, "0");
    const type = this._guessType(raw);
    // 主题: 去 URL / 图片路径 / 附件路径, 折叠空白, 去礼貌前缀, 截断到 14 字
    let topic = raw
      .replace(/https?:\/\/\S+/g, "")
      .replace(/uploads?\/\S+/g, "")
      .replace(/\b[\w./-]+\.(png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|zip)\b/gi, "")
      .replace(/\s+/g, " ")
      .replace(/^(请|帮我|帮忙)[，,。:：\s]+/, "")
      .trim();
    if (!topic) topic = "新会话";
    if (topic.length > 14) topic = topic.slice(0, 14);
    return `${mmdd}|${type}|${topic}`;
  },

  // ---- 会话列表 / 全文检索 (读投影; 归档/置顶/标题都参与展示) ----
  _deriveTitle(events, key) {
    const firstUser = events.find((e) => e.type === EVENTS.USER);
    return firstUser?.data?.content ? String(firstUser.data.content).slice(0, 20) : key;
  },
  // 列出所有会话: {key, count, lastTs, title, archived, pinned}
  // 排序: 置顶优先, 其余按最近活跃倒序 (置顶只是排序, 不改归属/标题/归档)
  // 供 Web UI 多会话管理 (P1#6)
  list() {
    const out = [];
    for (const [key, events] of this._logs) {
      if (!events.length) continue;
      // 2026-10-11: 自定义标题覆盖优先 (改名不改内容), 否则回退派生标题
      const title = this._titles[key] || this._deriveTitle(events, key);
      out.push({
        key,
        count: events.length,
        lastTs: events[events.length - 1].ts,
        title,
        archived: !!this._archived[key], // 2026-10-11: 归档标记随列表下发 (前端分组收起)
        pinned: !!this._pinned[key],     // 2026-11-03: 置顶标记随列表下发 (前端排序/图标)
      });
    }
    out.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || ((b.lastTs || 0) - (a.lastTs || 0)));
    return out;
  },

  // 全文检索 (2026-11-03): 在 user/assistant 消息正文里找关键词, 每会话取最新一条命中。
  // 返回 [{ key, title, ts, role, snippet }], 按命中时间倒序。纯本地扫描, 不建索引 ——
  // 会话事件本来就在内存里, 再加一套倒排索引只会多一份一致性负担。
  search(query, { limit = 20 } = {}) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const [key, events] of this._logs) {
      if (!events.length) continue;
      let found = null;
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        const isUser = e.type === EVENTS.USER;
        if (!isUser && e.type !== EVENTS.ASSISTANT) continue;
        const text = String(e.data?.content ?? "");
        const idx = text.toLowerCase().indexOf(q);
        if (idx === -1) continue;
        // 命中片段: 前后各留 24 字, 折叠换行, 两端用省略号标出截断
        const start = Math.max(0, idx - 24);
        const end = Math.min(text.length, idx + q.length + 24);
        const snip = (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
        found = { ts: e.ts, role: isUser ? "user" : "assistant", snippet: snip };
        break;
      }
      if (!found) continue;
      hits.push({
        key,
        title: this._titles[key] || this._deriveTitle(events, key),
        ts: found.ts,
        role: found.role,
        snippet: found.snippet,
      });
    }
    hits.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return hits.slice(0, Math.max(1, Number(limit) || 20));
  },
};
