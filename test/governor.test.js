// test/governor.test.js - 子智能体并发治理器 (2026-10-07)
// 钉住的不变量:
//   ① 全局上限是硬约束 (嵌套/并发 acquire 都不会突破)
//   ② acquire(n) 是批量原子语义 (否则 3 路各拿 2 个会把上限 4 撑到 6)
//   ③ release 幂等 (exit/error/kill 三路径都会调)
//   ④ 排队超时给出可行动错误, 不永久挂起
//   ⑤ setLimit 运行期可调 (用户要的"并发数可调"), 放宽立即放行排队者
//   ⑥ mapBounded 不超宽度
import test from "node:test";
import assert from "node:assert";
import { ConcurrencyGovernor, GOVERNOR_DEFAULTS } from "../src/orchestrator/governor.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("governor: 上限内直接发放, 状态统计正确", async () => {
  const g = new ConcurrencyGovernor({ limit: 4, perCallMax: 2, name: "t" });
  const r1 = await g.acquire(2, { tag: "a" });
  const r2 = await g.acquire(2, { tag: "b" });
  const st = g.stats();
  assert.equal(st.running, 4, "4 个槽位都在跑");
  assert.equal(st.idle, 0);
  assert.equal(st.peak, 4, "峰值记录");
  assert.equal(st.waiting, 0);
  r1();
  assert.equal(g.stats().running, 2, "归还 2 个");
  r2(); r2(); r2(); // 幂等: 重复归还不会把计数刷成负数
  assert.equal(g.stats().running, 0, "release 幂等");
  assert.ok(g.stats().completed >= 4);
});

test("governor: 超额 acquire 排队, 归还后按 FIFO 放行", async () => {
  const g = new ConcurrencyGovernor({ limit: 2, perCallMax: 2 });
  const r1 = await g.acquire(2);
  let secondGot = false;
  const p = g.acquire(2, { tag: "queued" }).then((r) => { secondGot = true; return r; });
  assert.equal(secondGot, false, "满额时排队而非立即发放");
  assert.equal(g.stats().waiting, 1);
  r1();
  const r2 = await p;
  assert.equal(secondGot, true, "归还后排队者进场");
  assert.equal(g.stats().running, 2);
  r2();
});

test("governor: acquire(n) 原子性 —— 多路并发不会把上限撑破", async () => {
  const g = new ConcurrencyGovernor({ limit: 4, perCallMax: 2 });
  // 3 路各要 2 个: 只有 2 路能同时拿到 (4 槽), 第 3 路必须等
  const holds = [];
  const pend = [0, 1, 2].map((i) => g.acquire(2, { tag: `p${i}` }).then((r) => { holds.push(r); return r; }));
  await sleep(20);
  assert.equal(g.stats().running, 4, "最多发放 4 个");
  assert.equal(g.stats().waiting, 1, "第三路在排队 (原子语义, 不会各拿半个)");
  assert.equal(holds.length, 2, "只有 2 路拿到了槽位");
  holds.forEach((r) => r());
  const all = await Promise.all(pend);
  assert.equal(g.stats().running, 2, "第三路进场后占 2 个槽");
  all.forEach((r) => r());
  assert.equal(g.stats().running, 0, "全部归还");
});

test("governor: 排队超时给出可行动错误", async () => {
  const g = new ConcurrencyGovernor({ limit: 1, perCallMax: 1, queueTimeoutMs: 60 });
  const r1 = await g.acquire(1);
  await assert.rejects(() => g.acquire(1, { tag: "慢" }), /等待 1 个子 agent 槽位超时/);
  assert.equal(g.stats().timeouts, 1, "超时计数");
  r1();
});

test("governor: setLimit 运行期调整 —— 放宽立即放行排队者, 收紧不影响在跑", async () => {
  const g = new ConcurrencyGovernor({ limit: 2, perCallMax: 2 });
  const r1 = await g.acquire(2);
  let got = false;
  const p = g.acquire(2).then((r) => { got = true; return r; });
  await sleep(10);
  assert.equal(got, false);
  g.setLimit(4); // 放宽
  const r2 = await p;
  assert.equal(got, true, "放宽后排队者立刻进场");
  r1();
  g.setLimit(1); // 收紧: 只影响后续, 不杀在跑的
  assert.equal(g.stats().running, 2, "收紧不杀在跑进程");
  r2();
});

test("governor: 超额请求钳到上限 (不报错), tryAcquire 满额返回 null 并计数", () => {
  const g = new ConcurrencyGovernor({ limit: 3, perCallMax: 2 });
  assert.equal(g.effPerCall(10), 2, "单次派发宽度受 perCallMax 约束");
  const r = g.tryAcquire(1);
  assert.ok(typeof r === "function");
  assert.equal(g.stats().ungoverned, 0);
  const r2 = g.tryAcquire(1);
  const r3 = g.tryAcquire(1);
  assert.ok(r2 && r3);
  assert.equal(g.tryAcquire(1), null, "满额时非阻塞拿不到");
  assert.equal(g.stats().ungoverned, 1, "未纳管计数 (诚实报告用)");
  r(); r2(); r3();
});

test("governor: mapBounded 不超宽度且保序", async () => {
  const g = new ConcurrencyGovernor({ limit: 8, perCallMax: 3 });
  let active = 0, peak = 0;
  const out = await g.mapBounded([1, 2, 3, 4, 5, 6, 7], async (n) => {
    active++; peak = Math.max(peak, active);
    await sleep(5);
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14], "结果保序");
  assert.ok(peak <= 3, `并发宽度不超过 3, 实测峰值 ${peak}`);
});

test("governor: run() 异常路径也归还槽位", async () => {
  const g = new ConcurrencyGovernor({ limit: 1, perCallMax: 1 });
  await assert.rejects(() => g.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(g.stats().running, 0, "异常不泄漏额度");
  const r = await g.acquire(1);
  r();
});

test("governor: 非法参数回落默认值而不是抛错", () => {
  const g = new ConcurrencyGovernor({ limit: -5, perCallMax: "x", queueTimeoutMs: NaN });
  assert.equal(g.limit, GOVERNOR_DEFAULTS.limit);
  assert.equal(g.perCallMax, GOVERNOR_DEFAULTS.perCallMax);
  assert.equal(g.queueTimeoutMs, GOVERNOR_DEFAULTS.queueTimeoutMs);
});

test("governor: drainWaiters 让排队者立即失败 (关机路径不留悬挂 promise)", async () => {
  const g = new ConcurrencyGovernor({ limit: 1, perCallMax: 1, queueTimeoutMs: 10000 });
  const r = await g.acquire(1);
  const p = g.acquire(1);
  assert.equal(g.drainWaiters("测试关机"), 1);
  await assert.rejects(() => p, /测试关机/);
  r();
});
