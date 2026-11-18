// test/lock-async-guard.test.js — F6: withFileLock / withFileLocks 必须拒绝异步临界区
// 缺陷本体: 这把锁是**同步**的 (锁文件在 fn() 返回的那一刻释放)。调用方传 async fn 时,
// fn() 立刻返回一个"刚开始执行"的 Promise, 于是 finally 在函数体内第一个 await 之前就把锁删了
// —— 临界区剩下的部分 (往往正是读-改-写的写那一段) 完全裸奔, 两个进程交错覆盖对方。
// 锁在这种地方静默变成 no-op, 而它看起来像是被持有了: 本仓库已因此真丢过用户数据
// (memory/l2.js:69-106 与 test/scene-id-backfill-2026-10-04.test.js 是同一类"锁外合并"事故)。
// 修法取舍: 不"宽容地照样跑", 而是当场拒绝。这里锁住的是拒绝本身:
//   ① async fn 在**取锁之前**抛错, 函数体一次都不执行 (不会留下半截写入);
//   ② 同步 fn 但返回 thenable 也抛错 (它的同步前半段已执行, 错误信息里说清互斥已失效);
//   ③ 抛错后 .lock 一定不存在 (没有残留锁把后来者卡到超时);
//   ④ 现有同步调用方的行为逐字节不变: 返回值透传 / 异常照常抛 / 锁照常释放。
// 真正的"两个 OS 进程并发读-改-写"证明在 test/lock-two-process-rmw.test.js (单进程里同步临界区
// 天然不可能交错, 断言它没有意义)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock, withFileLocks, readJson, writeJson } from "../src/utils/store.js";

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-lockguard-${tag}-`));
const leftoverLocks = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".lock"));

test("async 回调: 抛错, 且函数体一次都没执行, 也不创建锁文件", () => {
  const dir = tmp("async");
  const file = path.join(dir, "state.json");
  writeJson(file, { n: 0 });
  let ran = false;
  assert.throws(
    () => withFileLock(file, async () => { ran = true; writeJson(file, { n: 1 }); }),
    (e) => e instanceof TypeError && /只能同步持有/.test(e.message) && /withFileLock/.test(e.message)
  );
  assert.equal(ran, false, "async fn 必须一次都不被执行 (否则半截写入已经发生才抛错)");
  assert.deepEqual(readJson(file), { n: 0 }, "文件必须还是原样");
  assert.deepEqual(leftoverLocks(dir), [], "不得留下 .lock 残留 (否则后来者会白等到超时)");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("同步回调返回 Promise: 同样抛错并释放锁", () => {
  const dir = tmp("thenable");
  const file = path.join(dir, "state.json");
  let settled = false;
  assert.throws(
    () => withFileLock(file, () => Promise.resolve().then(() => { settled = true; })),
    (e) => e instanceof TypeError && /返回了.?一个 Promise/.test(e.message)
  );
  assert.deepEqual(leftoverLocks(dir), [], "抛错路径也要走 finally 释放锁");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("带 .then 的非 Promise 返回值也被当作异步拒绝; 普通对象不误伤", () => {
  const dir = tmp("quasi");
  const file = path.join(dir, "state.json");
  assert.throws(() => withFileLock(file, () => ({ then() {} })), TypeError);
  const obj = { ok: 1 };
  assert.equal(withFileLock(file, () => obj), obj, "无 .then 的普通对象必须原样透传");
  assert.equal(withFileLock(file, () => 0), 0, "falsy 返回值不得被当成 thenable");
  assert.equal(withFileLock(file, () => null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fn 不是函数: 抛 TypeError 且不创建锁文件", () => {
  const dir = tmp("notfn");
  const file = path.join(dir, "state.json");
  assert.throws(() => withFileLock(file, undefined), TypeError);
  assert.throws(() => withFileLock(file, { n: 1 }), TypeError);
  assert.deepEqual(leftoverLocks(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withFileLocks: 单文件与多文件都拒绝异步, 且不留下任何一把锁", () => {
  const dir = tmp("multi");
  const a = path.join(dir, "a.json");
  const b = path.join(dir, "b.json");
  for (const f of [a, b]) writeJson(f, {});
  let ran = 0;
  assert.throws(() => withFileLocks([a, b], async () => { ran++; }),
    (e) => e instanceof TypeError && /只能同步持有/.test(e.message));
  assert.equal(ran, 0, "async fn 不得执行");
  assert.deepEqual(leftoverLocks(dir), [], "两把锁都不得残留");
  assert.throws(() => withFileLocks([a], () => Promise.resolve(1)), TypeError);
  assert.deepEqual(leftoverLocks(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("withFileLocks: 空文件列表 (无锁执行) 同样拒绝异步 —— 拒绝与文件个数无关", () => {
  const dir = tmp("empty");
  let ran = false;
  assert.throws(() => withFileLocks([], async () => { ran = true; }),
    (e) => e instanceof TypeError && /只能同步持有/.test(e.message));
  assert.equal(ran, false);
  assert.throws(() => withFileLocks(null, () => Promise.resolve()), TypeError);
  assert.deepEqual(leftoverLocks(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("同步调用方行为不变: 返回值透传 / 异常照常抛 / 锁释放 / 嵌套顺序为路径升序", () => {
  const dir = tmp("sync");
  const file = path.join(dir, "counter.json");
  writeJson(file, 0);
  const out = withFileLock(file, () => { writeJson(file, readJson(file, 0) + 1); return "透传值"; });
  assert.equal(out, "透传值");
  assert.equal(readJson(file), 1);
  assert.throws(() => withFileLock(file, () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(leftoverLocks(dir), [], "异常路径照常释放");

  // 去重 + 升序嵌套 (单文件常见情形必须与单次 withFileLock 完全一致)
  const z = path.join(dir, "z.json");
  const m = path.join(dir, "m.json");
  writeJson(z, {}); writeJson(m, {});
  const seen = withFileLocks([z, m, z], () => fs.readdirSync(dir).filter((f) => f.endsWith(".lock")).sort());
  assert.deepEqual(seen, ["m.json.lock", "z.json.lock"], "两把锁同时持有 (去重后按升序嵌套)");
  const single = withFileLocks([m], () => fs.readdirSync(dir).filter((f) => f.endsWith(".lock")));
  assert.deepEqual(single, ["m.json.lock"], "单文件列表 = 与 withFileLock 同一把锁, 不多不少");
  assert.deepEqual(leftoverLocks(dir), [], "多把锁全部释放");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("同步回调里的 await 关键字不影响判定 (只有真返回 thenable 才算异步)", () => {
  const dir = tmp("wordasync");
  const file = path.join(dir, "s.json");
  writeJson(file, { v: 1 });
  // 普通函数 (非 async), 同步完成读-改-写; "await" 只出现在字符串/注释里
  const r = withFileLock(file, () => {
    const cur = readJson(file, {});
    writeJson(file, { ...cur, awaitNote: "锁内不得 await" });
    return cur.v;
  });
  assert.equal(r, 1);
  assert.equal(readJson(file).awaitNote, "锁内不得 await");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("不扩大打击面: 非 thenable 的惰性对象 (生成器对象) 照常透传, 不被误判为异步", () => {
  const dir = tmp("gen");
  const file = path.join(dir, "g.json");
  writeJson(file, {});
  function* gen() { yield 1; }
  const g = withFileLock(file, () => gen()); // 返回值不是 thenable: 生成器对象照常返回
  assert.equal(typeof g.next, "function", "非 thenable 的惰性对象不在拒绝范围 (不扩大打击面)");
  assert.deepEqual(leftoverLocks(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
