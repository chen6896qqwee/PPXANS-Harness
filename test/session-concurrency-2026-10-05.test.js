// test/session-concurrency-2026-10-05.test.js — 会话日志三个跨进程窗口的双进程回归 (W1/W2/W3)
// 2026-10-05 修掉的三处 (都在 src/memory/session.js, 同步镜像到 skills/ppx-memory/scripts/session.js):
//   W1 set/rename/fork/delete 的 unlink 发生在文件锁**外** → 清盘与整批写入现在同一把锁内完成
//   W2 _flushDaily 整批只重排一次 (锚在"今天/最新分片"的末行) → 跨天批次会撞别的日分片已有的号
//      → 现在每个被写分片的末行都参与游标计算, 外加共同的锚分片
//   W3 压缩事件的 data.upToSeq 不参与重排 → 锁内重排后同一批里出现两个 seq 世界 (被压缩的原文
//      回到上下文, 未被压缩的后续消息被吞) → 现在按 remap 修正并钳制"游标不得追平自身"
// 判据一律是"两个真实 OS 进程写同一个 dataDir": 跨进程不变量只能跨进程证。每个窗口都跑两遍:
// 一遍现行实现, 一遍用 env 开关把该窗口退回修复前的形状 (证明测试真的抓得到旧 bug)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionStore } from "../src/memory/session.js";
import { EVENTS } from "../src/memory/session.js";
import { logicalDay } from "../src/utils/store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESS_URL = pathToFileURL(path.join(ROOT, "src", "memory", "session.js")).href;
const STORE_URL = pathToFileURL(path.join(ROOT, "src", "utils", "store.js")).href;
const DAY = 86400000;

function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${name}-`)); }

// 子进程公共头部: 导入被测 store (与主代码同一份实现), 就绪标记 + 等 go 文件齐步
const PRELUDE = `
import fs from "node:fs";
import path from "node:path";
const { SessionStore, EVENTS } = await import(${JSON.stringify(SESS_URL)});
const D = process.env.PPX_C_DIR;
const GO = path.join(D, "go");
const ROLE = process.env.PPX_C_ROLE;
const DAY = 86400000;
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) {} }
};
const mark = (n) => fs.writeFileSync(path.join(D, n + "." + ROLE), String(process.pid));
const waitMark = (n, limit = 25000) => {
  const t0 = Date.now();
  while (!fs.existsSync(path.join(D, n))) {
    if (Date.now() - t0 > limit) throw new Error("等标记超时: " + n);
    sleepSync(5);
  }
};
`;

// 起两个子进程: 全部就绪后由父进程写 go 放行, 收集 stderr 供断言失败时定位
async function runKids(dir, scripts, envBase = {}) {
  const kids = scripts.map(({ code, role, env }) => spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, ...envBase, ...(env || {}), PPX_C_DIR: dir, PPX_C_ROLE: role },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  let stderr = "";
  for (const k of kids) { k.stderr.on("data", (d) => { stderr += d; }); k.stdout.on("data", (d) => { stderr += d; }); }
  const started = Date.now();
  while (!kids.every((k, i) => k.__exited || fs.existsSync(path.join(dir, `ready.${scripts[i].role}`)))) {
    if (Date.now() - started > 25000) { for (const k of kids) k.kill(); assert.fail(`子进程 25s 未就绪: ${stderr}`); }
    await new Promise((r) => setTimeout(r, 20));
  }
  fs.writeFileSync(path.join(dir, "go"), "go");
  const codes = await Promise.all(kids.map((k) => new Promise((resolve, reject) => {
    k.on("exit", (c) => { k.__exited = true; resolve(c); });
    k.on("error", reject);
  })));
  assert.deepEqual(codes, [0, 0], `子进程应正常退出 (代码 ${codes}), 输出: ${stderr}`);
  return stderr;
}

// 读某文件的事件行 (不存在返回空)
function linesOf(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
const seqsOf = (evs) => evs.map((e) => e.seq);

// ===========================================================================
// W1: set() 的清盘 (unlink) 与整批写入现在在同一把锁里 —— 强制"刚删完文件、尚未写新行"
//     这个窗口出现 (重建方在窗口里停住等父进程放行), 看并发写者落进来的行怎么处理:
//       修复前: 删文件在锁外 -> 写者的行落进空文件里当上首行, 重建方随后把整批挪到它上面
//               (会话文件以旧行开头、seq 不从 1 起 = 半重建态, 磁盘游标不再是删除后的事实)
//       修复后: 删+写在同一把锁内 -> 写者被锁排到重建之后, 盘上 = 重建整批 1..n + 写者 n+1..m
// ===========================================================================
const W1_WINDOW_WAIT = `
  const t0 = Date.now();
  while (!fs.existsSync(path.join(D, "window-go"))) { if (Date.now() - t0 > 12000) break; sleepSync(5); }
`;

function w1RebuildChild(legacy) {
  const patch = legacy
    // 修复前的形状: unlink 在锁外, 且每条消息一次独立全量落盘
    ? `
const o = SessionStore.prototype._removeFile;
void o;
SessionStore.prototype._removeFile = function (k) {
  fs.rmSync(this._file(k), { force: true });
  mark("wiped");${W1_WINDOW_WAIT}
};
SessionStore.prototype.set = function (key, history) {
  const k = this._safe(key);
  this._removeFile(k);
  this._logs.delete(k); this._nextSeq.set(k, 0); this._flushedSeq.delete(k);
  for (const m of (history || [])) this.append(k, m.role === "user" ? EVENTS.USER : EVENTS.ASSISTANT, { content: m.content });
  return history;
};
`
    // 现行实现: 清盘动作 (_rmSyncQuiet, 只在锁内被调用) 完成后打标记并停住 —— 锁仍然握着,
    // 把"刚删完、还没写新行"的窗口撑给并发写者, 看它能不能插进来
    : `
const o = SessionStore.prototype._rmSyncQuiet;
let fired = false;
SessionStore.prototype._rmSyncQuiet = function (file) {
  const r = o.call(this, file);
  if (!fired) { fired = true; mark("wiped");${W1_WINDOW_WAIT} }
  return r;
};
`;
  return PRELUDE + patch + `
const s = new SessionStore(D);
mark("ready");
waitMark("go", 25000);
s.set("conv", [
  { role: "user", content: "R1" }, { role: "assistant", content: "R2" }, { role: "user", content: "R3" },
]);
mark("done");
`;
}

const W1_WRITER_CHILD = PRELUDE + `
const s = new SessionStore(D);
mark("ready");
waitMark("go");
for (let i = 1; i <= 3; i++) s.append("conv", EVENTS.USER, { content: "X" + i }, undefined, { skipFlush: true });
// 卡着"重建方刚删完文件"这一刻落盘: 修复前此处没有锁挡着, 修复后必须排队等锁释放
waitMark("wiped.a");
s.flush("conv");
mark("done");
`;

async function runW1(legacy) {
  const dir = tmp(legacy ? "w1-legacy" : "w1");
  try {
    // 两个进程都先看到 3 条已有历史 (seq 1..3), 再各自动手: 一个重建, 一个追加
    const seed = new SessionStore(dir);
    seed.set("conv", [
      { role: "user", content: "S1" }, { role: "user", content: "S2" }, { role: "user", content: "S3" },
    ]);
    const p = runKids(dir, [
      { role: "a", code: w1RebuildChild(legacy) },
      { role: "b", code: W1_WRITER_CHILD },
    ]);
    // 等重建方"已经删完文件"再放并发写者出去 (父进程这边只是延迟一下, 让写者撞进窗口)
    const t0 = Date.now();
    while (!fs.existsSync(path.join(dir, "wiped.a"))) {
      if (Date.now() - t0 > 25000) throw new Error("子进程没走到清盘点");
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 200)); // 让 b 的锁申请排上队 (修复后) / 落进缝隙 (修复前)
    fs.writeFileSync(path.join(dir, "window-go"), "go");
    await p;
    const lines = linesOf(path.join(dir, "sessions", "conv.jsonl"));
    return { dir, lines, seqs: seqsOf(lines), heads: lines.map((l) => l.data.content) };
  } finally { /* 调用方清理 */ }
}

test("W1: 重建会话时 unlink 在锁外 = 半重建态 (修复前形状, 两子进程复现)", { timeout: 60000 }, async () => {
  const r = await runW1(true);
  try {
    assert.equal(r.lines.length, 6, "两个进程的 6 条事件都在盘上 (一行都没丢)");
    assert.equal(new Set(r.seqs).size, 6, "锁内重排仍在, seq 不重复");
    // 这就是旧窗口留下的东西: 被"整批作废"的旧历史之外, 并发写者的旧号行占了文件头,
    // 重建出来的会话 seq 不是从 1 起 —— 磁盘末行已不再是"删除后的事实"
    assert.ok(r.seqs[0] !== 1, `旧形状: 盘上首行 seq 应为写者的旧号 (>1), 实到 ${r.seqs[0]}`);
    assert.equal(r.heads[0], "X1", "旧形状: 并发写者的行落在了刚被删空的文件最前面");
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test("W1: 清盘+整批写入同在一把锁内, 并发写者只能排在重建之后", { timeout: 60000 }, async () => {
  const r = await runW1(false);
  try {
    assert.equal(r.lines.length, 6, "两个进程的 6 条事件都在盘上 (一行都没丢)");
    assert.deepEqual(r.seqs, [1, 2, 3, 4, 5, 6], "重建整批从 1 起连续, 写者接在其后");
    assert.deepEqual(r.heads, ["R1", "R2", "R3", "X1", "X2", "X3"], "清盘对并发写者不可见: 没有半重建态");
    const reopened = new SessionStore(r.dir);
    assert.deepEqual(reopened.deriveMessages("conv").map((m) => m.content), r.heads, "重开实例与盘一致");
    assert.equal(reopened._nextSeq.get("conv"), 6);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

// ===========================================================================
// W2: default 的跨天批次 —— 旧实现整批只在**第一个分片的锁内**重排一次, 锚是
//     _diskMaxSeq("default") = 今天(或名字最新)分片的末行; 而 default 的 seq 是跨分片的
//     单一游标: 只要昨天那片已经被人写到更高的号, 锚就低估, 这批的号就与昨天片里已有的撞车。
//     现在: 每个被写分片的末行都参与游标 (外加共同的锚分片), 游标按日升序一条连续段走完。
// ===========================================================================
const W2_LEGACY_PATCH = `
const { withFileLock } = await import(${JSON.stringify(STORE_URL)});
SessionStore.prototype._flushDaily = function (k, pending) {
  let renumbered = false;
  const byDay = new Map();
  for (const e of pending) {
    const d = this._dayOf(e.ts);
    let g = byDay.get(d); if (!g) { g = []; byDay.set(d, g); } g.push(e);
  }
  for (const [d, group] of byDay) {
    const file = this._shardFile(d);
    withFileLock(file, () => {
      if (!renumbered) { this._ensureUniqueSeq(k, pending); renumbered = true; }
      const line = group.map((e) => JSON.stringify(e)).join("\\n") + "\\n";
      if (fs.existsSync(file)) fs.appendFileSync(file, line, "utf8");
      else fs.writeFileSync(file, line, "utf8");
    });
  }
};
`;

// 两个子进程共用一份脚本, 靠 PPX_C_ORDER 决定批次里"今天/昨天"谁在前:
//   tb: [今天, 昨天] —— 先落盘, 把昨天分片写到比今天分片末行更高的 seq (锚从此低估)
//   bt: [昨天, 今天] —— 等 tb 落完再落盘, 它的批次按锚起编, 昨天那半正好撞进已写的号
const W2_CHILD = PRELUDE + `
if (process.env.PPX_W2_LEGACY === "1") {${W2_LEGACY_PATCH}}
const s = new SessionStore(D);
const midnight = new Date(new Date().toDateString()).getTime(); // 今日 00:00 (本地)
const yestTs = midnight - 3600000;                              // 昨天 23:00
const pairs = process.env.PPX_C_ORDER === "tb"
  ? [["今天", Date.now()], ["昨天", yestTs]]
  : [["昨天", yestTs], ["今天", Date.now()]];
for (const [tag, ts] of pairs) {
  s.append("default", EVENTS.USER, { content: process.env.PPX_C_ORDER + "-" + tag }, ts, { skipFlush: true });
}
mark("ready");
if (process.env.PPX_C_ORDER === "tb") { waitMark("go"); }
else { waitMark("done.tb"); }
s.flush("default");
mark("done");
`;

async function runW2(legacy) {
  const dir = tmp(legacy ? "w2-legacy" : "w2");
  // 起始事实: 今天分片已有 2 条 (seq 1,2), 昨天分片还不存在
  const seed = new SessionStore(dir);
  seed.append("default", EVENTS.USER, { content: "seed1" });
  seed.append("default", EVENTS.USER, { content: "seed2" });
  const today = logicalDay(new Date());
  const yest = logicalDay(new Date(new Date(new Date().toDateString()).getTime() - 3600000));
  await runKids(dir, [
    { role: "tb", code: W2_CHILD, env: { PPX_C_ORDER: "tb" } },
    { role: "bt", code: W2_CHILD, env: { PPX_C_ORDER: "bt" } },
  ], { PPX_W2_LEGACY: legacy ? "1" : "0" });
  const tLines = linesOf(path.join(dir, "sessions", `default-${today}.jsonl`));
  const yLines = linesOf(path.join(dir, "sessions", `default-${yest}.jsonl`));
  return { dir, today, yest, tLines, yLines, all: [...tLines, ...yLines], seqs: seqsOf([...tLines, ...yLines]) };
}

test("W2: 跨天批次按单一锚重排 = 与别的日分片撞号 (修复前形状, 两子进程复现)", { timeout: 60000 }, async () => {
  const r = await runW2(true);
  try {
    assert.equal(r.all.length, 6, "两进程 6 条事件都落了盘");
    const dup = r.seqs.filter((x, i) => r.seqs.indexOf(x) !== i);
    assert.ok(dup.length > 0, `旧形状: 跨日分片 union 应出现重复 seq, 实到 ${[...r.seqs].sort((a, b) => a - b).join(",")}`);
    const ySeqs = seqsOf(r.yLines);
    assert.equal(new Set(ySeqs).size, ySeqs.length - 1,
      `旧形状: 第二进程按锚(今日末行)起编, 昨天那片里已有同号 -> ${ySeqs.join(",")}`);
    // 注意旧形状里"锚分片(今日)的末行"曾经低于盘上真实最大 (昨日片被先写到更高号),
    // 终态可能被后来者追平, 所以这里只钉住"跨分片撞号"这一件确定的事。
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test("W2: 每个被写日分片的末行都参与 seq 游标, 跨分片不撞号", { timeout: 60000 }, async () => {
  const r = await runW2(false);
  try {
    assert.equal(r.all.length, 6, "两进程 6 条事件都在盘上, 一行不丢");
    assert.equal(new Set(r.seqs).size, 6, `跨日分片 union seq 零重复, 实到 ${[...r.seqs].sort((a, b) => a - b).join(",")}`);
    for (const [tag, evs] of [["今天", r.tLines], ["昨天", r.yLines]]) {
      for (let i = 1; i < evs.length; i++) {
        assert.ok(evs[i].seq > evs[i - 1].seq, `${tag}分片内 seq 必须递增 (尾读拿末行才是真相)`);
      }
    }
    const tailToday = r.tLines[r.tLines.length - 1].seq;
    const tailYest = r.yLines[r.yLines.length - 1].seq;
    assert.ok(tailToday > tailYest, `锚分片(今天)的末行必须是全库最大: today=${tailToday} yest=${tailYest}`);
    let mx = 0;
    for (const e of new SessionStore(r.dir).replay("default")) if (e.seq > mx) mx = e.seq;
    assert.equal(mx, tailToday, "重开实例的游标与盘上最大 seq 对齐");
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

// ===========================================================================
// W3: 压缩事件写回的 data.upToSeq 现在也参与锁内重排。
//     它是"摘要覆盖到哪个 seq 为止"的游标, 但值是压缩方在**锁外按自己内存里的 seq**算的:
//     上面 _ensureUniqueSeq 一重排, 同一批次里就同时存在两个 seq 世界 —— 被压缩的原文回到
//     模型上下文 (历史重复), 而未被压缩的后续消息反而被吞掉 (投影缺消息)。
//     场景: w 攒了一批待写 (u1,a2,u3 + 压缩{upToSeq:3}), c 在这期间把一条事件直接落了盘,
//     于是 w 的整批必须整体上移 1 格; 压缩游标必须跟着走。
// ===========================================================================
const W3_WRITER = PRELUDE + `
if (process.env.PPX_W3_LEGACY === "1") SessionStore.prototype._repairCompactionCursors = () => {};
const s = new SessionStore(D);
mark("ready");
s.append("default", EVENTS.USER, { content: "u1" }, undefined, { skipFlush: true });        // 乐观 seq 1
s.append("default", EVENTS.ASSISTANT, { content: "a2" }, undefined, { skipFlush: true });   // 乐观 seq 2
s.append("default", EVENTS.USER, { content: "u3" }, undefined, { skipFlush: true });        // 乐观 seq 3
// 压缩掉上面三条: upToSeq 取的是"我内存里看到的最大 seq"
s.append("default", EVENTS.COMPACTION, { summary: "前三条的摘要", upToSeq: 3 }, undefined, { skipFlush: true });
mark("pending");
waitMark("done.c");   // 让 c 先落一条, 逼 w 整批上移
s.flush("default");
mark("done");
`;

const W3_OTHER = PRELUDE + `
const s = new SessionStore(D);
mark("ready");
waitMark("go");
waitMark("pending.w");                 // w 的批次还压在内存里 (盘上还是空的)
s.append("default", EVENTS.USER, { content: "c4" });  // 乐观 seq 1, 落盘即 seq 1
mark("done");
`;

async function runW3(legacy) {
  const dir = tmp(legacy ? "w3-legacy" : "w3");
  await runKids(dir, [
    { role: "w", code: W3_WRITER },
    { role: "c", code: W3_OTHER },
  ], { PPX_W3_LEGACY: legacy ? "1" : "0" });
  const lines = linesOf(path.join(dir, "sessions", `default-${logicalDay(new Date())}.jsonl`));
  const comp = lines.find((l) => l.type === EVENTS.COMPACTION);
  const u3 = lines.find((l) => l.data && l.data.content === "u3");
  return { dir, lines, comp, u3, seqs: seqsOf(lines) };
}

test("W3: 重排后压缩游标悬空 = 被压缩的原文重回上下文 (修复前形状, 两子进程复现)", { timeout: 60000 }, async () => {
  const r = await runW3(true);
  try {
    assert.deepEqual(r.seqs, [1, 2, 3, 4, 5], "seq 本身仍是唯一的 (旧实现缺的只是游标)");
    assert.equal(r.comp.data.upToSeq, 3, "旧形状: 游标停在被重排掉的旧 seq 上");
    assert.notEqual(r.u3.seq, 3, `u3 已被重排到 ${r.u3.seq}`);
    const msgs = new SessionStore(r.dir).deriveCompacted("default");
    assert.ok(msgs.some((m) => m.content === "u3"), "旧形状: 已被摘要替换的原文又回到模型可见历史");
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test("W3: 压缩游标跟着同批 seq 一起重排, 且永不追平自身", { timeout: 60000 }, async () => {
  const r = await runW3(false);
  try {
    assert.deepEqual(r.seqs, [1, 2, 3, 4, 5], "五个进程事件合起来 seq 连续无重复");
    assert.equal(r.comp.data.upToSeq, r.u3.seq, `游标指向它真正压掉的那条 (u3=${r.u3.seq})`);
    assert.ok(r.comp.data.upToSeq < r.comp.seq, "游标不得追平/越过压缩事件自身");
    const reopened = new SessionStore(r.dir);
    const msgs = reopened.deriveCompacted("default");
    assert.ok(!msgs.some((m) => m.content === "u3"), "被压缩的原文不再回到上下文");
    assert.deepEqual(msgs.map((m) => m.content), ["前三条的摘要"]);
    // 日志不可变: 游标重排只挪数字, 五条进程事件一条都没被删
    assert.deepEqual(
      reopened.replay("default").map((e) => e.data.content ?? e.data.summary).sort(),
      ["a2", "c4", "u1", "u3", "前三条的摘要"].sort(),
      "日志原文完整 (replay 仍能看到全部五条)"
    );
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test("W3: 锁外算出的越界游标在落盘前被钳制 (单进程兜底分支)", () => {
  const dir = tmp("w3clamp");
  try {
    const s = new SessionStore(dir);
    s.append("k", EVENTS.USER, { content: "m1" });
    // 越界: upToSeq 指向尚未存在的未来 seq (旧实现会一路吞掉后续所有消息)
    const ev = s.append("k", EVENTS.COMPACTION, { summary: "S", upToSeq: 99 });
    assert.equal(ev.data.upToSeq, ev.seq - 1, "落盘前钳到自身 seq 之前");
    const lines = linesOf(path.join(dir, "sessions", "k.jsonl"));
    assert.equal(lines[1].data.upToSeq, ev.seq - 1, "盘上的游标与内存一致");
    s.append("k", EVENTS.USER, { content: "m2" });
    assert.deepEqual(s.deriveCompacted("k").map((m) => m.content), ["S", "m2"], "游标之后的消息照常可见");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
