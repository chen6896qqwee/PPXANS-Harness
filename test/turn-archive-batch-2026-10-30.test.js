// test/turn-archive-batch-2026-10-30.test.js
// 两件事的守卫:
//  ① turns 归档合批 (L1, 2026-10-30): 归档由 session 事件可重建, 不必每轮加锁 append;
//     攒够 N 条 / 超时 / 强制点 (跨天·读取·进程收口) 才真写。守卫要锁的是"合批不能变成丢数据"。
//  ② 压缩检查节流修复 (同日): 原 _lastCompactAt 只在真压缩完成后更新, 当天事件没到阈值时
//     每轮 recordTurn 都会 replayDay 读一遍全天分片 —— 节流形同虚设, 并发压测里占 17%。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryTicker } from "../src/memory/memory-ticker.js";
import { PPXAgent } from "../src/agent/index.js";

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`));
const stubFacts = () => ({ add() {}, addMemory() {}, query() { return []; } });
const turnsFile = (dir, day) => path.join(dir, "memory", "turns", `${day}.jsonl`);
const lineCount = (file) => {
  try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; }
};

// 带证据的一轮 (只有带 evidence/drafts 的轮次才会写 turns 归档)
const turn = (t, i) => t.recordTurn(`问题 ${i}`, `回答 ${i}`, {
  sessionKey: "s1",
  drafts: [`草稿 ${i}`],
});

test("合批: 连续多轮不等于每轮一次落盘, flush 后一行不少", async () => {
  const dir = tmp("batch-count");
  try {
    const t = new MemoryTicker(dir, stubFacts());
    const day = new Date().toISOString().slice(0, 10);
    const file = turnsFile(dir, t.state.day || day);
    // 第 1 轮: _archiveFlushedAt 初值 0 → 超时条件立即成立, 直接落盘 1 行
    await turn(t, 1);
    assert.equal(lineCount(file), 1, "首轮应立刻落盘 (惰性超时对首次必然成立)");
    // 再写 3 轮: 队列 3 条, 未达阈值 5, 且距上次落盘 < 3s → 不落盘
    await turn(t, 2); await turn(t, 3); await turn(t, 4);
    assert.equal(t._archiveQueue.length, 3, `应攒了 3 条待落盘, 实际 ${t._archiveQueue.length}`);
    assert.equal(lineCount(file), 1, "合批期间文件不应增长");
    // 强制 flush: 3 条一次性写入
    const n = t.flushTurnArchive();
    assert.equal(n, 3, "一次 flush 应写入队列里的 3 行");
    assert.equal(lineCount(file), 4, "flush 后一行不少");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("合批: 达到阈值 (5 条) 自动落盘, 不等外部调用", async () => {
  const dir = tmp("batch-threshold");
  try {
    const t = new MemoryTicker(dir, stubFacts());
    const file = turnsFile(dir, t.state.day || new Date().toISOString().slice(0, 10));
    for (let i = 1; i <= 6; i++) await turn(t, i); // 1 落盘 + 5 达阈值落盘
    assert.equal(t._archiveQueue.length, 0, "第 6 轮时队列应因达阈值被清空");
    assert.equal(lineCount(file), 6, "6 轮 = 6 行");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("合批: 读接口 turnArchive() 会自动收口 (读得到刚发生的轮次)", async () => {
  const dir = tmp("batch-read");
  try {
    const t = new MemoryTicker(dir, stubFacts());
    await turn(t, 1); await turn(t, 2); await turn(t, 3);
    assert.ok(t._archiveQueue.length > 0, "前置条件: 队列里还有没落盘的行");
    const rows = t.turnArchive({ sessionKey: "s1" });
    assert.equal(t._archiveQueue.length, 0, "读取应触发 flush");
    assert.equal(rows.length, 3, `应读到 3 行, 实际 ${rows.length}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("合批: 进程收口 agent.shutdown() 会把队列写完", async () => {
  const dir = tmp("batch-shutdown");
  try {
    const a = new PPXAgent({ root: dir, configFile: null });
    a.allProviders = [];
    a.llm = null;
    // 直接打记忆层, 绕开 LLM 依赖 (合批是这一层的责任)
    await turn(a.memory, 1); await turn(a.memory, 2); await turn(a.memory, 3);
    const pendingBefore = a.memory._archiveQueue.length;
    assert.ok(pendingBefore > 0, "前置条件: 队列里还有待落盘行");
    await a.shutdown();
    assert.equal(a.memory._archiveQueue.length, 0, "shutdown 必须收口");
    // 目录以 memory.dir 为准 (agent 的 dataDir 未必等于 root)
    const file = path.join(a.memory.dir, "turns", `${a.memory.state.day}.jsonl`);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(raw.includes("草稿 3"), "最后一条草稿必须落盘 (优雅退出不该丢归档)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("压缩检查: 60s 内只读一次当天事件 (原实现每轮都 replayDay)", async () => {
  const dir = tmp("compact-throttle");
  try {
    const t = new MemoryTicker(dir, stubFacts());
    let reads = 0;
    t.sessionStore = {
      replayDay() { reads++; return []; },
      eventsByDay() { reads++; return []; },
    };
    for (let i = 1; i <= 6; i++) await turn(t, i);
    assert.equal(reads, 1, `6 轮里只应检查一次压缩 (实际读了 ${reads} 次当天事件)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("压缩检查: 节流到期后会重新检查 (不是永久跳过)", async () => {
  const dir = tmp("compact-recheck");
  try {
    const t = new MemoryTicker(dir, stubFacts());
    let reads = 0;
    t.sessionStore = { replayDay() { reads++; return []; }, eventsByDay() { reads++; return []; } };
    await turn(t, 1);
    assert.equal(reads, 1);
    // 把检查时间戳推到 61s 前, 模拟节流窗口过期
    t._lastCompactCheckAt = Date.now() - 61000;
    await turn(t, 2);
    assert.equal(reads, 2, "节流窗口过后必须重新检查 (否则压缩永远不会发生)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("合批: 队列为空时 flush 是空操作 (不建文件/不抛错)", async () => {
  const dir = tmp("batch-empty");
  try {
    const t = new MemoryTicker(dir, stubFacts());
    assert.equal(t.flushTurnArchive(), 0);
    assert.equal(t.flushTurnArchive(), 0, "重复 flush 幂等");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
