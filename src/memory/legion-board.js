// src/memory/legion-board.js - 军团共享记忆板 (2026-10-02)
// 跨 agent 实时共享知识: 主 agent 与所有 worker 子 agent 通过同一全局文件互通。
// 与 FactStore (内存快照, 私有) 不同: 每次读/写都走盘 + 文件锁, 保证多进程实时一致性。
// 并发模式对齐 Experience: 锁内「重读 → 改 → 写」, 防陈旧覆盖。
import path from "node:path";
import { ensureDir, readJson, writeJson, nowISO, withFileLock } from "../utils/store.js";

export class LegionBoard {
  constructor(globalDataDir, opts = {}) {
    this.dir = path.join(globalDataDir, "legion");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "board.json");
    this.opts = {
      maxEntries: 500, // 容量上限: 超限裁剪最旧 (FIFO, 记忆板是临时协作区不是档案库)
      ttlDays: 7,      // 条目存活期: 0/负 = 永不过期
      ...opts,
    };
  }

  // 发布一条共享知识 (topic 可选作频道, tags 可选作检索辅助)
  publish({ from, topic, content, tags = [] }) {
    if (!content || !String(content).trim()) throw new Error("board_publish: content 不能为空");
    return withFileLock(this.file, () => {
      const entries = readJson(this.file, []);
      const entry = {
        id: `bd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        from: String(from || "unknown").slice(0, 64),
        topic: String(topic || "general").slice(0, 64),
        content: String(content).slice(0, 2000),
        tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).slice(0, 32)).slice(0, 8),
        ts: nowISO(),
      };
      entries.push(entry);
      // 写入时统一裁剪: TTL 过滤 + 容量 FIFO
      const cutoff = this.opts.ttlDays > 0 ? Date.now() - this.opts.ttlDays * 86400000 : 0;
      const kept = entries
        .filter((x) => !cutoff || new Date(x.ts).getTime() >= cutoff)
        .slice(-this.opts.maxEntries);
      writeJson(this.file, kept);
      return entry;
    });
  }

  // 查询: 读时重读磁盘 → 实时可见其他 agent 刚发布的内容 (跨进程)
  query({ q, topic, from, limit = 10 } = {}) {
    let entries = readJson(this.file, []);
    if (topic) entries = entries.filter((x) => x.topic === topic);
    if (from) entries = entries.filter((x) => x.from === from);
    if (q) {
      const kw = String(q).toLowerCase();
      entries = entries.filter((x) =>
        x.content.toLowerCase().includes(kw) ||
        x.topic.toLowerCase().includes(kw) ||
        (x.tags || []).some((t) => t.toLowerCase().includes(kw))
      );
    }
    // 新的在前
    entries.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return entries.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
  }

  // 概况: 当前板上条数 + 参与过的 agent (可观测性)
  stats() {
    const entries = readJson(this.file, []);
    return {
      count: entries.length,
      agents: [...new Set(entries.map((x) => x.from))],
      topics: [...new Set(entries.map((x) => x.topic))],
    };
  }
}
