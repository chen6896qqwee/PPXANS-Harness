// test/perf-memory-hotpath.test.js — OPT-2/OPT-3 记忆写路径热开销的回归守卫
//
// OPT-2 (src/memory/session.js): append() 的磁盘尾读 (_diskMaxSeq: existsSync + open/fstat/
//   读末 8KB/close) 只是**乐观预读**, 权威在 _flush 锁内的 _ensureUniqueSeq 重排。因此同一批
//   未落盘事件 (skipFlush 批量写入序列) 只需每个 key 读一次盘; _flush 结束后缓存必须失效,
//   下一批重新读盘。本文件用 fs.readSync 计数桩把这条性质钉住, 并额外证明"缓存过期时锁内
//   重排仍然生效"—— 优化不得削弱跨进程 seq 唯一性。
//
// OPT-3 (src/memory/memory-ticker.js): recordTurn 的"纯 turnCount 递增"不再每轮落盘
//   (withFileLock + 全量原子写 ≈1.7ms/轮)。但跨天 _rollDay、_compileDaily_Rolling 的
//   lastRolledDay/lastRolledSeq 游标推进、_runRetention 清扫、以及 _saveState (agent.shutdown
//   的既有收口) 必须立即落盘。本文件逐条验证: 被节流的轮次不改盘, 强制时机立即改盘,
//   重启后游标不丢/不回退 (否则会重复归档原文)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, EVENTS } from "../src/memory/session.js";
import { MemoryTicker } from "../src/memory/memory-ticker.js";

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// 只读桩: 不写盘、不查语义, 让 recordTurn 的写路径开销归零 —— 被测的是 state 落盘时机
const quietFacts = { add() {}, addMemory() {}, query() { return []; } };

// 计数桩: 统计窗口内 fs.readSync 次数。session.js 里 readSync 只用于"读文件末行拿末 seq"
// (_tailMaxSeq), 所以这个计数就是"磁盘尾读次数"。
function countTailReads() {
  const orig = fs.readSync;
  let n = 0;
  fs.readSync = function (...args) { n += 1; return orig.apply(fs, args); };
  return {
    get count() { return n; },
    reset() { n = 0; },
    restore() { fs.readSync = orig; },
  };
}

const sessionFile = (dir, key) => path.join(dir, "sessions", `${key}.jsonl`);
// default 会话按天分片 (default-YYYY-MM-DD.jsonl): 本测试只产生"今天"一个分片
const readEvents = (dir, key) => {
  const file = key === "default"
    ? path.join(dir, "sessions", fs.readdirSync(path.join(dir, "sessions"))
      .filter((f) => /^default-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().pop())
    : sessionFile(dir, key);
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

// ---- OPT-2: 同批只尾读一次 / flush 后失效 / 按 key 隔离 ----

test("OPT-2: 同一批 skipFlush append 每个 key 只读一次盘, _flush 后缓存失效 (下一批重新读盘)", () => {
  const dir = tmp("ppx-opt2-batch-");
  const s = new SessionStore(dir);
  try {
    // 先落一条, 让磁盘上有真实末行 (非空尾读)
    s.append("default", EVENTS.USER, { content: "u0" }, Date.now(), { skipFlush: true });
    s.flush("default");

    const c = countTailReads();
    try {
      // 同一批 4 条 append: 磁盘末行在本进程落盘前不会变, 只允许 1 次乐观尾读
      for (let i = 1; i <= 4; i++) {
        s.append("default", EVENTS.USER, { content: "u" + i }, Date.now(), { skipFlush: true });
      }
      assert.equal(c.count, 1, `同批 4 条 append 只允许 1 次磁盘尾读, 实际 ${c.count} 次`);

      c.reset();
      s.flush("default"); // flush 锁内的尾读是权威判定, 不属于"重复的乐观预读", 单独计
      c.reset();

      // flush 之后盘面已前进 (本批已写入) —— 下一批若复用旧缓存就会低估盘面, 所以必须重新读盘
      s.append("default", EVENTS.ASSISTANT, { content: "a1" }, Date.now(), { skipFlush: true });
      assert.equal(c.count, 1, "flush 之后的第一条 append 必须重新读盘 (缓存已失效)");
      s.flush("default");
    } finally {
      c.restore();
    }

    // 批量写入不改变落盘结果: 3 批 = 6 条, seq 连续唯一
    const seqs = readEvents(dir, "default").map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6], `落盘 seq 必须连续唯一, 实际 ${seqs}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OPT-2: 批次缓存按 key 隔离 (两个会话各读各的盘, 同批同 key 不重复读)", () => {
  const dir = tmp("ppx-opt2-keys-");
  const s = new SessionStore(dir);
  try {
    s.append("a", EVENTS.USER, { content: "a0" }, Date.now());
    s.append("b", EVENTS.USER, { content: "b0" }, Date.now());

    const c = countTailReads();
    try {
      s.append("a", EVENTS.USER, { content: "a1" }, Date.now(), { skipFlush: true });
      s.append("b", EVENTS.USER, { content: "b1" }, Date.now(), { skipFlush: true });
      assert.equal(c.count, 2, "两个 key 各读一次盘");
      s.append("a", EVENTS.ASSISTANT, { content: "a2" }, Date.now(), { skipFlush: true });
      s.append("b", EVENTS.ASSISTANT, { content: "b2" }, Date.now(), { skipFlush: true });
      assert.equal(c.count, 2, "同批同 key 的第二条 append 不再读盘");
      s.flush("a");
      s.flush("b");
    } finally {
      c.restore();
    }
    assert.deepEqual(readEvents(dir, "a").map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(readEvents(dir, "b").map((e) => e.seq), [1, 2, 3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OPT-2: 乐观预读过期 (期间别的进程已写) 时, 锁内 _ensureUniqueSeq 仍重排, seq 唯一不削弱", () => {
  const dir = tmp("ppx-opt2-collision-");
  try {
    const s1 = new SessionStore(dir);
    s1.append("k", EVENTS.USER, { content: "s1-first" }); // 落盘 seq=1
    // s1 开一个新批次: 本批缓存盘面 = 1, 乐观分配 seq=2
    s1.append("k", EVENTS.ASSISTANT, { content: "s1-batch-1" }, Date.now(), { skipFlush: true });

    // 模拟另一个进程 (另一个 SessionStore 实例 = 另一份内存计数) 在 s1 批次期间写入 2,3,4
    const s2 = new SessionStore(dir);
    s2.append("k", EVENTS.USER, { content: "s2-1" });
    s2.append("k", EVENTS.USER, { content: "s2-2" });
    s2.append("k", EVENTS.USER, { content: "s2-3" });

    // s1 继续用过期盘面 (diskMax=1) 分配 → 必然与磁盘 2,3,4 撞号
    s1.append("k", EVENTS.USER, { content: "s1-batch-2" }, Date.now(), { skipFlush: true });
    s1.flush("k"); // 权威兜底: 锁内重读盘面 → 整批重排到 5,6

    const seqs = readEvents(dir, "k").map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6], `缓存过期也不得产生重复 seq, 实际 ${seqs}`);
    // 内存事件与盘面一致 (锁内原地改 seq, 无需二次同步)
    assert.deepEqual(s1.replay("k").map((e) => e.seq), [1, 5, 6], "本进程事件 seq 与落盘一致");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- OPT-3: turnCount 节流 + 强制落盘时机 + 重启游标 ----

test("OPT-3: 纯 turnCount 递增被节流, 整数倍/强制时机立即落盘, 重启后游标不丢", async () => {
  const dir = tmp("ppx-opt3-state-");
  const stateFile = path.join(dir, "memory", "daily-state.json");
  const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const sessions = new SessionStore(dir);
  try {
    // 今日已有 2 条会话事件, 供滚动归档推进 lastRolledSeq 用
    sessions.append("default", EVENTS.USER, { content: "今日事件1" }, Date.now());
    sessions.append("default", EVENTS.ASSISTANT, { content: "今日事件2" }, Date.now());

    const ticker = new MemoryTicker(dir, quietFacts, null, sessions);
    const today = ticker.state.day;
    assert.equal(readState().turnCount, 0, "构造期只落 day/retention 游标 (turnCount 起点为 0)");

    // 1~9 轮: 纯计数递增, 不落盘 (turnCount 只是滚动归档节奏的计数器, 不是游标)
    for (let i = 1; i <= 9; i++) await ticker.recordTurn("第 " + i + " 轮", "好");
    assert.equal(ticker.state.turnCount, 9);
    assert.equal(readState().turnCount, 0, "1~9 轮 (非整数倍) 不应写 state 文件");

    // 第 10 轮 = TURNS_PER_SUMMARY 整数倍 → 强制落盘; 同一轮 _compileDaily_Rolling 也推进游标
    await ticker.recordTurn("第 10 轮", "好");
    const after10 = readState();
    assert.equal(after10.turnCount, 10, "整数倍轮次必须落盘");
    assert.equal(after10.lastRolledSeq, 2, "滚动归档游标推进必须立即落盘 (2 条今日事件)");
    assert.equal(after10.lastRolledDay, today, "滚动归档日游标同步落盘");

    // 11/12 轮再次被节流: 盘上仍是 10, 内存是 12
    await ticker.recordTurn("第 11 轮", "好");
    await ticker.recordTurn("第 12 轮", "好");
    assert.equal(ticker.state.turnCount, 12);
    assert.equal(readState().turnCount, 10, "11/12 轮被节流, 盘上仍为 10");

    // 收口 (agent.shutdown 调用的是同一个 _saveState): 立即把计数落盘
    ticker._saveState();
    assert.equal(readState().turnCount, 12, "_saveState 收口必须立即落盘");

    // 强制游标推进 (不靠节流路径): 新增今日事件 → 滚动归档把 lastRolledSeq 推到 3
    sessions.append("default", EVENTS.USER, { content: "今日事件3" }, Date.now());
    ticker._compileDaily_Rolling();
    const afterRoll = readState();
    assert.equal(afterRoll.lastRolledSeq, 3, "滚动游标推进必须立即落盘 (不等 1s/10 轮节流)");
    assert.equal(afterRoll.turnCount, 12, "强制落盘同时把被节流的 turnCount 一并持久化");

    // 重启: 游标不丢、不回退
    const t2 = new MemoryTicker(dir, quietFacts, null, sessions);
    assert.equal(t2.state.turnCount, 12, "重启后 turnCount 不丢");
    assert.equal(t2.state.lastRolledDay, today, "重启后 lastRolledDay 不回退");
    assert.equal(t2.state.lastRolledSeq, 3, "重启后 lastRolledSeq 不回退 (否则整日原文会重复归档)");

    // 不重复归档: 游标已推进到 3, 再滚动一次不应把"今日事件3"再写一遍
    const lt = path.join(dir, "memory", "longterm.md");
    const before = fs.readFileSync(lt, "utf8");
    t2._compileDaily_Rolling();
    assert.equal(fs.readFileSync(lt, "utf8"), before, "游标不丢 → 已归档事件不会被再次追加");
    assert.equal((fs.readFileSync(lt, "utf8").match(/今日事件3/g) || []).length, 1, "同一条事件只归档一次");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OPT-3: 跨天 _rollDay 与保留期清扫的状态变更强制落盘 (不等节流)", () => {
  const dir = tmp("ppx-opt3-roll-");
  const stateFile = path.join(dir, "memory", "daily-state.json");
  const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  try {
    const ticker = new MemoryTicker(dir, quietFacts);
    const today = ticker.state.day;

    // 模拟"昨天"→"今天"的跨天: day 变更必须立即落盘
    ticker.state.day = "2000-01-01";
    ticker._rollDay();
    assert.equal(ticker.state.day, today);
    assert.equal(readState().day, today, "跨天 day 变更必须强制落盘");

    // 保留期清扫游标变更必须立即落盘
    ticker.state.lastRetentionDay = "2000-01-01";
    ticker._rollDay();
    assert.equal(ticker.state.lastRetentionDay, today);
    assert.equal(readState().lastRetentionDay, today, "保留期清扫游标必须强制落盘");
    assert.ok(readState().retention && typeof readState().retention === "object", "清扫统计随状态一起落盘");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
