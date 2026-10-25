// test/lock-two-process-rmw.test.js — F6: 两个真实 OS 进程并发读-改-写 (跨进程证伪)
// 为什么必须开子进程: 单进程里两个同步临界区物理上不可能交错, 断言"没丢更新"是空断言。
// 只有多进程共用一个 dataDir (军团 worker / CLI + Web 的真实形态) 才能证伪。
// 四组对照, 缺一个证明就不成立:
//   A 真锁 + 同步临界区 (临界区里还故意用 Atomics.wait 把窗口撑到 2ms) → 计数必须**精确**等于
//     两进程之和, 且不留 .lock 残骸 → 互斥是真的。
//   B 旧行为复刻 (子进程内一份"改前"的 withFileLock 克隆 + async 临界区) → 必然丢更新 →
//     证明 A 的窗口真的存在且够宽 (否则 A 的"精确"只是因为根本没并发)。
//   C 修复后的原语 + 同一个 async 临界区 → 子进程拿到清晰拒绝, 计数器一个都没被写坏,
//     也没有 .lock 残留 → 证明"宁可报错也不假装持锁", 且错误跨进程可见。
//   D 两个进程按相反顺序申请同一批文件 → 不死锁 (withFileLocks 的去重+升序只有真进程能验证)。
// 全程零网络零 LLM, 只用 node -e 子进程 + 临时目录 + 文件标记握手。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE_URL = pathToFileURL(path.join(ROOT, "src", "utils", "store.js")).href;

const ITER = 40;      // 每进程递增次数
const HOLD_MS = 2;    // A/D: 临界区内同步阻塞 (把互斥窗口撑开, 期间不交还事件循环)
const GAP_MS = 6;     // B/C: await 让出时长 (Windows 定时器粒度 ≈15ms, 足够交错)

const PRELUDE = `
import fs from "node:fs";
import path from "node:path";
const { withFileLock, readJson, writeJson } = await import(${JSON.stringify(STORE_URL)});
const D = process.env.PPX_L_DIR;
const ROLE = process.env.PPX_L_ROLE;
const FILE = path.join(D, "counter.json");
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) {} }
};
const mark = (n) => fs.writeFileSync(path.join(D, n + "." + ROLE), String(process.pid));
const waitMark = (n, limit = 30000) => {
  const t0 = Date.now();
  while (!fs.existsSync(path.join(D, n))) {
    if (Date.now() - t0 > limit) throw new Error("等标记超时: " + n);
    sleepSync(5);
  }
};
// "改前"的 withFileLock 复刻 (只用于 B 组, 证明窗口是真的): 锁文件在 fn() 返回时就删,
// async fn 返回的只是"刚开始执行"的 Promise → 剩下的临界区裸奔。
const _grab = (file) => { try { const fd = fs.openSync(file + ".lock", "wx"); fs.closeSync(fd); return true; } catch { return false; } };
function withFileLockOld(file, fn) {
  const lock = file + ".lock";
  const t0 = Date.now();
  while (!_grab(file)) { if (Date.now() - t0 > 8000) throw new Error("锁等待超时"); sleepSync(5); }
  try { return fn(); } finally { try { fs.rmSync(lock, { force: true }); } catch {} }
}
`;

// A: 真锁 + 全同步临界区 (读 → 阻塞 → 写 都在锁内)
const CHILD_SYNC = PRELUDE + `
mark("ready");
waitMark("go");
for (let i = 0; i < ${ITER}; i++) {
  withFileLock(FILE, () => {
    const v = readJson(FILE, 0);
    sleepSync(${HOLD_MS});
    writeJson(FILE, v + 1);
  });
}
mark("done");
`;

// B: 旧行为 + async 临界区 → 锁在 await 处就没了, 两个进程交错读到同一个 v 再各写 v+1 (丢更新)
const CHILD_OLD_ASYNC = PRELUDE + `
mark("ready");
waitMark("go");
const tick = () => new Promise((r) => setTimeout(r, ${GAP_MS}));
for (let i = 0; i < ${ITER}; i++) {
  await withFileLockOld(FILE, async () => {
    const v = readJson(FILE, 0);
    await tick();
    writeJson(FILE, v + 1);
  });
}
mark("done");
`;

// C: 修复后的原语 + 同样的 async 临界区 → 必须当场抛错 (且一个计数都不加)
const CHILD_GUARDED = PRELUDE + `
mark("ready");
waitMark("go");
const tick = () => new Promise((r) => setTimeout(r, ${GAP_MS}));
let threw = null;
try {
  await withFileLock(FILE, async () => {
    const v = readJson(FILE, 0);
    await tick();
    writeJson(FILE, v + 1);
  });
} catch (e) { threw = e && e.message ? e.message : String(e); }
console.log(threw ? "GUARDED:" + threw.split("\\n")[0] : "NO-THROW");
mark("done");
`;

// D: 反向申请同一批文件 (withFileLocks 升序取锁 → 不会互相卡死)
const CHILD_ORDER = PRELUDE + `
const { withFileLocks } = await import(${JSON.stringify(STORE_URL)});
const A = path.join(D, "a.json"), B = path.join(D, "b.json");
const order = ROLE === "a" ? [A, B] : [B, A];
mark("ready");
waitMark("go");
for (let i = 0; i < 5; i++) {
  withFileLocks(order, () => {
    const va = readJson(A, 0), vb = readJson(B, 0);
    sleepSync(${HOLD_MS});
    writeJson(A, va + 1); writeJson(B, vb + 1);
    return fs.readdirSync(D).filter((f) => f.endsWith(".lock")).sort().join(",");
  });
}
console.log("LOCKSET:" + fs.readdirSync(D).filter((f) => f.endsWith(".lock")).join(","));
mark("done");
`;

function runKids(childSource, dir) {
  const roles = ["a", "b"];
  const kids = roles.map((role) => spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    env: { ...process.env, PPX_L_DIR: dir, PPX_L_ROLE: role },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  let out = "";
  for (const k of kids) {
    k.stdout.on("data", (d) => { out += d; });
    k.stderr.on("data", (d) => { out += d; });
  }
  return new Promise((resolve, reject) => {
    const bail = (why) => reject(new Error(why + "\n--- 子进程输出 ---\n" + out));
    const timer = setTimeout(() => bail("子进程整体超时"), 60000);
    let failed = 0;
    for (const k of kids) k.on("exit", (c) => { if (c !== 0) failed++; });
    // 两个子进程都装载完毕 (此刻内存态/盘态对齐) 后才放行 → 写窗口真正重叠
    const waitGo = () => {
      if (!roles.every((r) => fs.existsSync(path.join(dir, "ready." + r)))) return setTimeout(waitGo, 5);
      fs.writeFileSync(path.join(dir, "go"), "1");
      const waitFinish = () => {
        if (!roles.every((r) => fs.existsSync(path.join(dir, "done." + r)))) return setTimeout(waitFinish, 20);
        clearTimeout(timer);
        setTimeout(() => resolve({ out, failed }), 300); // 等 exit 事件记账
      };
      waitFinish();
    };
    waitGo();
  });
}

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-lockxp-${tag}-`));
const locksIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".lock"));
const counterOf = (dir) => {
  const f = path.join(dir, "counter.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : 0;
};

test("A 两个真实进程 × 同步临界区: 计数精确不丢更新, 且不留 .lock", async (t) => {
  const dir = tmp("sync");
  const { out, failed } = await runKids(CHILD_SYNC, dir);
  assert.equal(failed, 0, "子进程不应失败: " + out);
  t.diagnostic(`真锁计数 = ${counterOf(dir)} / 期望 ${ITER * 2}`);
  assert.equal(counterOf(dir), ITER * 2, "40+40 次读-改-写必须一个不丢 (互斥生效)");
  assert.deepEqual(locksIn(dir), [], "不得留下锁残骸");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("B 复刻改前行为 (async fn): 同一窗口必然丢更新 —— 证明 A 不是空断言", async (t) => {
  const dir = tmp("oldasync");
  const { out, failed } = await runKids(CHILD_OLD_ASYNC, dir);
  assert.equal(failed, 0, "旧行为不会报错 (这正是它危险的地方): " + out);
  const got = counterOf(dir);
  t.diagnostic(`改前行为计数 = ${got} / 期望 ${ITER * 2} (丢了 ${ITER * 2 - got} 次)`);
  assert.ok(got < ITER * 2,
    `旧行为应当丢更新, 实测 ${got}/${ITER * 2} —— 若本条失败说明没造出真并发, 则 A 组结论不成立`);
  assert.deepEqual(locksIn(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("C 修复后的原语 × async 临界区 (跨进程): 子进程拿到清晰拒绝, 数据一个没写坏", async () => {
  const dir = tmp("guarded");
  const { out, failed } = await runKids(CHILD_GUARDED, dir);
  assert.equal(failed, 0, "拒绝是被 catch 住的正常路径: " + out);
  const guarded = (out.match(/GUARDED:/g) || []).length;
  assert.equal(guarded, 2, "两个子进程都应当打出拒绝信息: " + out);
  assert.ok(!out.includes("NO-THROW"), "绝不允许静默放过异步临界区");
  assert.match(out, /GUARDED:withFileLock:[^\n]*只能同步持有/);
  assert.equal(counterOf(dir), 0, "被拒绝的临界区一个计数都不该写下去 (函数体从未执行)");
  assert.deepEqual(locksIn(dir), [], "拒绝路径不得留下 .lock");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("D 反向申请同一批文件: withFileLocks 升序取锁, 两个进程互不死锁", async () => {
  const dir = tmp("order");
  for (const f of ["a.json", "b.json"]) fs.writeFileSync(path.join(dir, f), "0", "utf8");
  const { out, failed } = await runKids(CHILD_ORDER, dir);
  assert.equal(failed, 0, "反向顺序不应导致锁超时 (双方都按 a→b 取锁): " + out);
  const sets = [...out.matchAll(/LOCKSET:([^\n\r]*)/g)].map((m) => m[1]);
  assert.equal(sets.length, 2, "两个子进程都要收尾: " + out);
  assert.deepEqual(sets, ["", ""], "收尾后盘上不得有任何 .lock");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "a.json"), "utf8")), 10, "a 计数 = 2 进程 × 5");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "b.json"), "utf8")), 10, "b 计数 = 2 进程 × 5");
  assert.deepEqual(locksIn(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
