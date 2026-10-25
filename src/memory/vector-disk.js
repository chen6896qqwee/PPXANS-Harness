// src/memory/vector-disk.js - 事实向量落盘缓存 (2026-10-24)
// 此前 _embedCache 只在内存: 重启即清零, 配云端 embedder 时每次启动全量重算 (真金白银)。
// 本模块把 id -> {内容哈希, 向量} 落到 <dataDir>/memory/vectors.json:
//   · 读: 内存 → 磁盘 (内容哈希一致才命中, 内容改了自动失效) → embedder 重算
//   · 写: 防抖 2s 合并落盘, withFileLock 内"锁内重读 + 按 id 并集"再原子写
//     (与 failure-episode 同款并发语义, 多进程/CLI 共写不互吞)
// 容量上限淘汰最旧; embedder 指纹不符 (换模型/换实现) 全量作废。
import path from "node:path";
import fs from "node:fs";
import { ensureDir, readJson, withFileLock } from "../utils/store.js";

export class VectorDiskCache {
  constructor(dir, { fingerprint = "unknown", maxEntries = 5000, flushDelayMs = 2000 } = {}) {
    this.file = path.join(dir, "vectors.json");
    this.fingerprint = String(fingerprint);
    this.maxEntries = maxEntries;
    this.flushDelayMs = flushDelayMs;
    this._vectors = new Map(); // id -> { h, v }
    this._timer = null;
    this._load();
  }

  _load() {
    try {
      const d = readJson(this.file, null);
      if (d && d.fingerprint === this.fingerprint && d.vectors && typeof d.vectors === "object") {
        for (const [id, e] of Object.entries(d.vectors)) {
          if (e && Array.isArray(e.v)) this._vectors.set(id, { h: String(e.h || ""), v: e.v });
        }
      }
      // 指纹不符 = embedder 换代, 旧向量全部作废 (不加载, 下次 flush 覆盖)
    } catch { /* 空缓存起步 */ }
  }

  // 命中条件: id 存在且内容哈希一致 (内容改了 = 失效重算)
  get(id, contentHash) {
    const e = this._vectors.get(id);
    if (e && e.h === contentHash) return e.v;
    return null;
  }

  set(id, contentHash, vec) {
    if (!Array.isArray(vec) || !vec.length) return;
    this._vectors.delete(id);
    this._vectors.set(id, { h: String(contentHash || ""), v: vec });
    // 容量上限: Map 迭代序 = 插入序, 淘汰最旧
    while (this._vectors.size > this.maxEntries) {
      const oldest = this._vectors.keys().next();
      if (oldest.done) break;
      this._vectors.delete(oldest.value);
    }
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.flushDelayMs);
    // Node 进程退出前尽力落盘 (unref: 不阻止进程自然退出)
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  // 锁内重读盘 → 与内存态按 id 并集 (他进程新写的向量不丢) → 原子写回
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._vectors.size) return;
    try {
      withFileLock(this.file, () => {
        let disk = {};
        try {
          const d = readJson(this.file, null);
          if (d && d.fingerprint === this.fingerprint && d.vectors) disk = d.vectors;
        } catch { /* 无盘上数据 */ }
        const merged = { ...disk };
        for (const [id, e] of this._vectors) merged[id] = e;
        // 容量裁剪 (磁盘侧): 保留内存态 + 其余按插入序取最新
        const keys = Object.keys(merged);
        const overflow = keys.length - this.maxEntries;
        if (overflow > 0) {
          for (const k of keys.slice(0, overflow)) {
            if (!this._vectors.has(k)) delete merged[k];
          }
        }
        ensureDir(path.dirname(this.file));
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ fingerprint: this.fingerprint, vectors: merged }));
        fs.renameSync(tmp, this.file);
      });
    } catch { /* 落盘失败不阻断检索 (内存缓存仍在), 下次 set 重试 */ }
  }

  get size() { return this._vectors.size; }
}

export default VectorDiskCache;
