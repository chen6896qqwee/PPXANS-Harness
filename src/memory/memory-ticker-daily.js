// src/memory/memory-ticker-daily.js - 记忆水位线 · 日终/滚动归档组 (2026-11-03 从 memory-ticker.js 拆出)
// 职责: longterm.md 的唯一追加入口 (_appendLongterm) + 两条追加路径:
//   · _compileDaily         跨天日终归档 (整日原文, 带"补齐"语义)
//   · _compileDaily_Rolling 每 TURNS_PER_SUMMARY 轮滚动归档 (滚动游标之后的新事件)
// 三个 longterm 写入点 (日终 / 滚动 / rollup 压缩) 共用同一个 seq 游标 (lastRolledDay/lastRolledSeq),
//   游标推进必须紧随成功追加并落盘, 否则同一段对话会被写第二遍。
// 共享的 session 事件投影 (_dayEvents/_lineOfEvent) 与落盘脱密 (_scrub) 也在这里导出,
//   供宿主 (_compactIfNeeded/context/stats) 与轮次归档组 (_archiveTurnContext) 复用 ——
//   宿主经 Object.assign 装配 (见 memory-ticker.js 末尾); 技能副本 (skills/ppx-memory/scripts/
//   memory-ticker.js) 仍为单文件同源, 由 test/skill-memory-drift.test.js 按组守卫。
import path from "node:path";
import { appendText, writeText, logicalDay, withFileLock } from "../utils/store.js";
import { scrubPII } from "../utils/pii.js";
import { noteCatch } from "../utils/catch-log.js";

// 归档写入专用: 带 seq 的当天事件 (eventsByDay 的投影没有 seq, 无法做游标)
// 三处 longterm 写入 (日终归档 / 滚动 / rollup 压缩) 共用同一个 seq 游标,
// 否则同一段对话会被写第二遍 —— 旧实现 _compileDaily 无视滚动游标, 每次跨天把
// 上一日**全文**再追加一遍, longterm.md 因此成倍膨胀并把重复内容回灌进每轮 context。
export function _dayEvents(sessionStore, day) {
  if (!sessionStore || typeof sessionStore.replayDay !== "function") return [];
  try { return sessionStore.replayDay(day) || []; } catch (e) { noteCatch(e); return []; }
}

export function _lineOfEvent(e) {
  const who = e.type === "user/message" ? "用户" : "皮皮虾";
  return `- [${new Date(e.ts).toISOString()}] ${who}: ${String(e.data?.content || "").slice(0, 200)}`;
}

// P0 (2026-10-04): 落盘前脱密。longterm.md / daily/*.md 是原文归档, 会长期驻留、
//   逐日增长并回灌进每轮 context (还会发给云端 provider) —— 凭证/密钥绝不能进。
//   保留 email/phone: 用户主动要求记住的联系方式是记忆的正常用途; 其余 PII 一律 REDACTED。
export function _scrub(text) {
  return scrubPII(String(text ?? ""), { keep: ["email", "phone"] }).cleaned;
}

export const memoryTickerDailyMethods = {
  // 跨天: 把上一日事件归档到 daily/ 并滚入 longterm (从 session 派生, 非 today.md)
  // longterm 段只追加"滚动游标之后"的事件 —— 已经由 _compileDaily_Rolling 写过的不再写第二遍
  _compileDaily() {
    const day = this.state.day;
    const evs = _dayEvents(this.sessionStore, day);
    const lines = evs.map(_lineOfEvent);
    writeText(path.join(this.dir, "daily", `${day}.md`), `# ${day}

${_scrub(lines.join("\n"))}\n`);
    if (!lines.length) return;
    const afterSeq = this.state.lastRolledDay === day ? (this.state.lastRolledSeq || 0) : 0;
    const pending = evs.filter((e) => e.seq > afterSeq);
    if (pending.length) {
      // v3.2.3 (P2#10): 追加写替代全量重写 (readText 拼接 writeText 在 longterm 增长后
      // 每次归档都 O(N) 全文件读写); 语义等价 —— 内容与格式逐字节一致, 仅写方式不同
      this._appendLongterm(pending.length === evs.length
        ? `\n## ${day}\n${_scrub(lines.join("\n"))}\n`
        : `\n## ${day} (补齐)\n${_scrub(pending.map(_lineOfEvent).join("\n"))}\n`);
    }
    this.state.lastRolledDay = day;
    this.state.lastRolledSeq = evs[evs.length - 1].seq;
    this._saveState();
  },

  // longterm.md 的唯一追加入口 (2026-10-04): 加跨进程文件锁 —— 军团多进程共用 dataDir 时
  // 裸 appendFileSync 在 Windows 上可能交错写坏行; 游标推进必须紧随成功追加, 防重复写。
  _appendLongterm(chunk) {
    withFileLock(this.longtermMd, () => appendText(this.longtermMd, chunk));
  },

  // 每 N 轮: 把今日新增事件滚动归档进 longterm (从 session 派生)
  // v1.2.0 fix: 用游标(lastRolledDay/lastRolledSeq)只追加"本次滚动之后"的新事件,
  // 不再每次把今日全文重复追加 —— 否则同一段对话会在 longterm 中反复出现, 加剧重复回话。
  _compileDaily_Rolling() {
    const today = logicalDay();
    const st = this.state;
    if (st.lastRolledDay !== today) { st.lastRolledDay = today; st.lastRolledSeq = 0; } // 跨天重置游标
    const afterSeq = st.lastRolledSeq || 0;
    const rows = [];
    let maxSeq = afterSeq;
    for (const e of _dayEvents(this.sessionStore, today)) {
      if (e.seq <= afterSeq) continue;
      rows.push(_lineOfEvent(e));
      if (e.seq > maxSeq) maxSeq = e.seq;
    }
    if (rows.length) this._appendLongterm(`\n## ${today} (滚动)\n${_scrub(rows.join("\n"))}\n`);
    st.lastRolledSeq = maxSeq;
    this._saveState();
  },
};
