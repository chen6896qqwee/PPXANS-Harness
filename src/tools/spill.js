// src/tools/spill.js - 超长工具结果全文归档 (链式召回地基, 2026-11-01 v4.1 执行编排)
//
// 设计溯源 docs/PROVENANCE.md#dsh; 自研 spill/output-retention 语义:
//   工具输出超过预算时不丢弃原文 —— 全文落盘, 模型侧只保留"头尾预览 + locator 告示",
//   后续可用 context_read 工具按 spill_id 分页续读。原始内容永不删除 (对齐设计溯源 docs/PROVENANCE.md#dsh
//   "事件日志是唯一事实源, 投影可收缩但原文可按 seq 精确回放"的公理)。
//
// 之前皮皮虾的问题 (docs/SUPERAGENT-GAP.md 二期③): 被裁内容逐层截断后无任何找回途径 ——
//   traces 截 800 → 事件预览截 300 → 会话日志 digest 截 260, 除了"重跑工具"拿不回全文。
//
// 纯 Node 零依赖: 每条归档一个 JSON 文件 (data/spill/<id>.json), 同步 fs 与
// memory/session.js 同一口径。带 TTL 清扫 + 容量上限 (防长期运行无限增长)。
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TTL_DAYS = 14;
const DEFAULT_MAX_FILES = 500;

let _seq = 0;

export class SpillStore {
  constructor(dir, { ttlDays = DEFAULT_TTL_DAYS, maxFiles = DEFAULT_MAX_FILES } = {}) {
    this.dir = String(dir || "");
    this.ttlDays = Number(ttlDays) > 0 ? Number(ttlDays) : DEFAULT_TTL_DAYS;
    this.maxFiles = Number(maxFiles) > 0 ? Math.trunc(Number(maxFiles)) : DEFAULT_MAX_FILES;
    this._sweptOnce = false;
  }

  _ensureDir() {
    if (!this.dir) return false;
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    return true;
  }

  // 归档一段全文, 返回 { id, chars }。meta 仅留痕 ({tool, callId, sessionKey}), 不参与读取键。
  put(text, meta = {}) {
    const s = String(text ?? "");
    if (!this._ensureDir()) return null;
    _seq += 1;
    const id = `sp-${Date.now().toString(36)}-${_seq.toString(36)}`;
    return this._write(id, s, meta);
  }

  // 确定性 id 归档 (v5.0 P2.2 链式召回二期): 同一批被裁内容只归档一次 ——
  //   调用方以内容摘要派生 id (如 hs-<hash>), 已存在则不重写, created=false。
  //   _trimHistory 每轮投影都会重算裁剪, 没有确定性 id 会产生海量重复归档。
  putWithId(id, text, meta = {}) {
    const s = String(text ?? "");
    const clean = String(id || "").replace(/[^\w-]/g, "").slice(0, 64);
    if (!clean || !this._ensureDir()) return null;
    const file = path.join(this.dir, `${clean}.json`);
    const existed = fs.existsSync(file);
    if (!existed) this._write(clean, s, meta);
    return { id: clean, chars: s.length, created: !existed };
  }

  _write(id, s, meta = {}) {
    const rec = {
      id,
      ts: Date.now(),
      tool: String(meta.tool || "").slice(0, 200),
      callId: String(meta.callId || "").slice(0, 200),
      sessionKey: String(meta.sessionKey || "").slice(0, 200),
      chars: s.length,
      text: s,
    };
    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(rec), "utf8");
    // 容量守卫: 超上限按 mtime 淘汰最旧 (归档是"可续读的备份", 不是永久账本 ——
    // 永久账本是会话日志; 这里只保证"刚刚被裁的内容这一轮之内读得到")。
    // 归档只在"结果超预算"时发生 (低频), 每次 put 都做一次目录清点, 语义确定性优先。
    this._evictOverflow();
    return { id, chars: s.length };
  }

  // 按 id 读取一个窗口: { id, total, offset, text, nextOffset, done } | null (无此 id)
  read(id, { offset = 0, maxChars = 8000 } = {}) {
    if (!id || !this.dir) return null;
    const file = path.join(this.dir, `${String(id).replace(/[^\w-]/g, "")}.json`);
    if (!fs.existsSync(file)) return null;
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
    const total = Number(rec.chars) || String(rec.text || "").length;
    const off = Math.max(0, Math.min(Number(offset) || 0, total));
    // 显式传了正数 max_chars 就尊重调用方 (下限只挡非法值, 不覆盖合法小窗口)
    const cap = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
      ? Math.min(Math.trunc(Number(maxChars)), 32000)
      : 8000;
    const text = String(rec.text || "").slice(off, off + cap);
    const nextOffset = off + text.length;
    return {
      id: rec.id || id,
      tool: rec.tool || "",
      total,
      offset: off,
      text,
      nextOffset: nextOffset >= total ? null : nextOffset,
      done: nextOffset >= total,
    };
  }

  // TTL 清扫: 删除超过 ttlDays 的归档文件。返回清扫数 (调用方留痕)。
  sweep() {
    if (!this.dir || !fs.existsSync(this.dir)) return 0;
    const cutoff = Date.now() - this.ttlDays * 24 * 60 * 60 * 1000;
    let swept = 0;
    for (const f of this._listJson()) {
      try { if (fs.statSync(f).mtimeMs < cutoff) { fs.unlinkSync(f); swept++; } } catch { /* 单文件失败不阻断 */ }
    }
    return swept;
  }

  // 容量淘汰: 超过 maxFiles 时按 mtime 从旧到新删
  _evictOverflow() {
    const files = this._listJson();
    if (files.length <= this.maxFiles) return 0;
    const dated = [];
    for (const f of files) {
      try { dated.push({ f, m: fs.statSync(f).mtimeMs }); } catch { /* 跳过 */ }
    }
    dated.sort((a, b) => a.m - b.m);
    let evicted = 0;
    for (const d of dated) {
      if (dated.length - evicted <= this.maxFiles) break;
      try { fs.unlinkSync(d.f); evicted++; } catch { /* 跳过 */ }
    }
    return evicted;
  }

  _listJson() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(this.dir, f));
    } catch { return []; }
  }

  // 启动期清扫 (惰性, 每实例一次)
  sweepOnce() {
    if (this._sweptOnce) return 0;
    this._sweptOnce = true;
    return this.sweep();
  }
}
