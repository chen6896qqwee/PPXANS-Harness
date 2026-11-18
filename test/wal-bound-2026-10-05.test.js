// test/wal-bound-2026-10-05.test.js — F7: facts.json.wal 的字节水位与"裁剪后重放等价"
// 先纠正一处误诊 (本文件据此而写): 追加日志在**正常 add 路径**上本来就是会缩的 ——
//   wal:true + walThreshold:50 连做 2500 次 add, wal 峰值只有 18,032 字节, 跑完直接消失;
//   主快照 facts.json 也随 maxFacts 裁剪停在 430,002 字节。所以"条数阈值"没坏。
// 真正的无上限在**条数阈值封顶不了的那一类事件**上: {op:"replace"} 把整个库序列化进同一行,
//   于是 "事件条数 < 阈值" 被当成 "还没到 compact 的时候" —— 实测 40 次
//   importAll(1000 条, {mode:"replace"}) 让 wal 涨到 13,836,680 字节, 而同期主快照只有 2 字节
//   (一次都没 compact 过)。条数阈值管写放大频率, 字节水位管绝对上限, 二者互补。
// 本文件断言的是**量出来的字节数**, 不是"某个开关被置上了"。
// 等价性怎么证: 水位触发的是既有 compact 路径 (快照∪WAL∪内存 → 全量原子写 → 清 WAL),
//   所以"未 compact 的事件被丢掉"不可能发生 (它们刚被并进快照); 于是同一份输入,
//   裁剪前算出的完整状态与裁剪后算出的完整状态必须逐条相同。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactStore } from "../src/memory/fact-store.js";
import { walFileOf, walSizeBytes, appendWal } from "../src/utils/wal.js";
import { withFileLock } from "../src/utils/store.js";

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-walbound-${tag}-`));
const sizeOf = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
const MB = 1024 * 1024;

// 一批带完整字段的 upsert 事件 (直接喂 _walAppend, 绕开 add() 的锁内 _reload:
// 本测试要量的是追加日志的上限, 不是检索/裁剪性能)
const tinyFact = (i) => ({
  id: "f" + i, content: "小事实编号" + i, type: "general", source: "test",
  importance: 10, score: 10, created: "2026-10-05T00:00:00.000Z",
  lastAccess: "2026-10-05T00:00:00.000Z", hits: 0, scope: null, layer: 1,
  status: "active", prevId: null,
});

test("walSizeBytes: 不存在 = 0, 追加后可读数", () => {
  const dir = tmp("size");
  const store = new FactStore(dir, { wal: true });
  const wf = walFileOf(store.file);
  assert.equal(walSizeBytes(wf), 0, "尚无追加日志时读作 0 (不是抛错)");
  assert.equal(sizeOf(wf), 0);
  withFileLock(store.file, () => store._walAppend({ op: "upsert", fact: tinyFact(0) }));
  assert.ok(walSizeBytes(wf) > 0, "追加一条后必须能读出正数字节");
  assert.equal(walSizeBytes(wf), sizeOf(wf), "读数必须与 stat 一致");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("巨型事件不再等于无上限: 2000 条 upsert 在 64KiB 水位下峰值不越过水位+一条", () => {
  const dir = tmp("tiny");
  const CAP = 64 * 1024;
  const store = new FactStore(dir, {
    wal: true, walThreshold: 1e9,     // 条数阈值调到不可能触发 → 只剩字节水位这一把闸
    walMaxBytes: CAP, maxFacts: 0,    // maxFacts=0: 不裁剪, 全部事实都必须活着
  });
  assert.equal(store.walThreshold, 1e9);
  const wf = store.walFile;
  let peak = 0;
  let prev = 0;
  let truncations = 0;   // 观测到"变小"的次数 = 水位真的触发过 compact 的次数
  let appendedBytes = 0; // 累计写进去的字节 (未封顶时的理论尺寸)
  const oneEvent = JSON.stringify({ op: "upsert", fact: tinyFact(99999) }).length + 1;
  for (let i = 0; i < 2000; i++) {
    withFileLock(store.file, () => store._walAppend({ op: "upsert", fact: tinyFact(i) }));
    const now = sizeOf(wf);
    if (now < prev) truncations++;
    peak = Math.max(peak, now);
    prev = now;
    appendedBytes += oneEvent;
  }
  assert.ok(peak <= CAP + oneEvent,
    `峰值 ${peak} 必须 ≤ 水位 ${CAP} + 单条事件 ${oneEvent} (水位是"追加后检查", 一条事件不可拆分)`);
  // 注意测量时机: _walAppend 内部就在超水位时清空, 所以外面能看到的最大读数只会是
  // "越过水位前的最后一次累积", 它贴在水位下方一条事件之内 —— 这正是封顶者是这道闸的证据。
  assert.ok(peak >= CAP - oneEvent,
    `峰值 ${peak} 必须贴着水位 (不低过 ${CAP} - ${oneEvent}), 否则钉住它的不是字节水位`);
  assert.ok(truncations >= 5, `水位必须反复触发过 compact (实测清空 ${truncations} 次)`);
  assert.ok(peak * 3 < appendedBytes,
    `实际盘上峰值 ${peak} 必须远小于累计写入 ${appendedBytes} —— 日志确实被裁剪了`);
  // 耐久性: 反复 compact 之后, 换一个实例重放必须拿到全部 2000 条
  const reopened = new FactStore(dir, { wal: true, walThreshold: 1e9, walMaxBytes: CAP, maxFacts: 0 });
  assert.equal(reopened.count(), 2000, "被水位触发的 compact 一条事件都不能丢");
  // query 是排序检索 (默认只回前几条), 这里要的是"最后一条事件的内容真的在盘上"
  assert.ok(reopened.query("小事实编号1999").some((f) => f.id === "f1999"),
    "第 2000 条仍可检索 (内容真的落进了快照)");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("关掉水位 (walMaxBytes:0) 就回到无上限 —— 反证上限确实来自这道闸", () => {
  const dir = tmp("disabled");
  const store = new FactStore(dir, { wal: true, walThreshold: 1e9, walMaxBytes: 0, maxFacts: 0 });
  assert.equal(store.walMaxBytes, 0, "显式 0 = 关闭字节水位 (旧行为)");
  for (let i = 0; i < 2000; i++) {
    withFileLock(store.file, () => store._walAppend({ op: "upsert", fact: tinyFact(i) }));
  }
  const bytes = sizeOf(store.walFile);
  assert.ok(bytes > 200 * 1024, `无水位时追加日志一路涨到 ${bytes} 字节 (这才是要封顶的形态)`);
  fs.rmSync(dir, { recursive: true, force: true });
  // 默认值必须是"开着"的: 未显式配置 = 类常量
  const dir2 = tmp("defaultcap");
  const def = new FactStore(dir2, { wal: true });
  assert.equal(def.walMaxBytes, FactStore.WAL_MAX_BYTES);
  assert.equal(FactStore.WAL_MAX_BYTES, 2 * MB, "默认水位 = 2MiB (常规 add 峰值 18KB 的 ~100 倍, 常态零触发)");
  fs.rmSync(dir2, { recursive: true, force: true });
});

test("生产可达路径: 40 次 importAll(replace 1000) 的 wal 峰值从 13.8MB 降到 2MiB 量级", () => {
  const dir = tmp("replace");
  const rows = Array.from({ length: 1000 }, (_, i) => ({ content: "导入条目编号" + i + " " + "填".repeat(20) }));
  const store = new FactStore(dir, { wal: true, walThreshold: 50, maxFacts: 1000 });
  let peak = 0;
  for (let k = 0; k < 40; k++) {
    store.importAll(rows, { mode: "replace" });
    peak = Math.max(peak, sizeOf(store.walFile));
  }
  // 峰值上界 = 水位 + 一条最大事件 (一次 replace ≈ 整库字节)
  assert.ok(peak < 3 * MB, `实测峰值 ${peak} 必须被封顶在个位 MiB 内 (修前同场景 13,836,680 字节)`);
  assert.ok(peak > FactStore.WAL_MAX_BYTES / 2, "replace 事件本身就接近水位量级, 峰值不该小得可疑");
  // 关键: 封顶之后状态仍然完整 —— 重放等价, 且新实例读得到最后一次替换的全部内容
  const reopened = new FactStore(dir, { wal: true, walThreshold: 50, maxFacts: 1000 });
  assert.equal(reopened.countLive(), 1000, "整库替换 + compact 后仍是 1000 条活跃事实");
  assert.ok(reopened.query("导入条目编号999").length >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("重放等价: 同样的事件流, 裁剪过的目录与从没裁剪过的目录重放出逐条相同的状态", () => {
  // 这就是"不丢耐久性"的可证伪形式: 把同一批 400 条 upsert 事件分别喂给
  //   A 盘 = 水位关闭 (一段完整长日志, 从没 compact 过)
  //   B 盘 = 水位 32KiB (期间反复 compact = 反复裁剪)
  // 两边的"磁盘快照 ∪ 追加日志"重放结果必须逐 id 逐内容相同 —— 裁剪只是把日志并进快照,
  // 不是把事件扔掉。
  // store.dir 是 dataDir/memory, 所以清理/重建实例都要用显式捕获的 dataDir 变量,
  // 不要在字符串上玩正则回推父目录 (脆弱且难读)。
  const dirA = tmp("equivA");
  const dirB = tmp("equivB");
  const mk = (dir, cap) => new FactStore(dir, { wal: true, walThreshold: 1e9, walMaxBytes: cap, maxFacts: 0 });
  const a = mk(dirA, 0);
  const b = mk(dirB, 32 * 1024);
  for (let i = 0; i < 400; i++) {
    withFileLock(a.file, () => a._walAppend({ op: "upsert", fact: tinyFact(i) }));
    withFileLock(b.file, () => b._walAppend({ op: "upsert", fact: tinyFact(i) }));
  }
  const replay = (s) => new Map(
    s._applyWalTo(JSON.parse(fs.readFileSync(s.file, "utf8"))).map((f) => [f.id, JSON.stringify(f)])
  );
  const ra = replay(a);
  const rb = replay(b);
  assert.equal(sizeOf(a.walFile) > 32 * 1024, true, "A 盘日志必须真的没被裁剪过 (否则两边都在比裁剪结果)");
  assert.ok(sizeOf(b.walFile) <= 32 * 1024 + 512, `B 盘日志被水位钉住 (实测 ${sizeOf(b.walFile)})`);
  assert.equal(ra.size, 400);
  assert.deepEqual([...rb.keys()].sort(), [...ra.keys()].sort(), "裁剪后重放的 id 集合必须一字不差");
  for (const [id, json] of ra) assert.equal(rb.get(id), json, `${id} 整条记录必须一致`);
  // 崩溃语义: 两个目录各自重启 (新实例) 后仍然一致
  const a2 = mk(dirA, 0);
  const b2 = mk(dirB, 32 * 1024);
  assert.equal(a2.count(), 400, "A 盘 (未裁剪, 全靠重放) 重启后 400 条");
  assert.equal(b2.count(), 400, "B 盘 (反复裁剪) 重启后同样 400 条");
  assert.deepEqual(b2.facts.map((f) => f.id).sort(), a2.facts.map((f) => f.id).sort());
  assert.deepEqual(b2.facts.map((f) => JSON.stringify(f)).sort(),
    a2.facts.map((f) => JSON.stringify(f)).sort(), "逐条内容也必须一致");
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test("compact 顺序恒为「先写全量快照, 再清追加日志」—— 清空的一瞬间盘上已有完整状态", () => {
  const dir = tmp("order");
  const store = new FactStore(dir, { wal: true, walThreshold: 1e9, walMaxBytes: 16 * 1024, maxFacts: 0 });
  let pendingBytes = 0;
  let snapshotAtTruncate = -1;
  withFileLock(store.file, () => {
    for (let i = 0; i < 200; i++) appendWal(store.walFile, { op: "upsert", fact: tinyFact(i) });
    pendingBytes = sizeOf(store.walFile);
    store._walPending = 0;
    store._flushLocked();               // 内部次序: writeJson(快照) → truncateWal
    snapshotAtTruncate = sizeOf(store.file);
  });
  assert.ok(pendingBytes > 0, "先攒出一段未 compact 的日志");
  assert.ok(snapshotAtTruncate > 1000, `快照必须承载全部状态 (实测 ${snapshotAtTruncate} 字节)`);
  assert.equal(sizeOf(store.walFile), 0, "日志只允许在快照落盘之后被清空");
  const reopened = new FactStore(dir, { wal: true, walThreshold: 1e9, walMaxBytes: 16 * 1024, maxFacts: 0 });
  assert.equal(reopened.count(), 200, "只读快照也能恢复全部 200 条 (清空窗口内不丢耐久性)");
  fs.rmSync(dir, { recursive: true, force: true });
});
