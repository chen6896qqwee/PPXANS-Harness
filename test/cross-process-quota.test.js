// test/cross-process-quota.test.js - 跨进程并发配额账本 (2026-10-07 评估报告 P0-3)
//
// 覆盖的失效模式: ConcurrencyGovernor 是进程级单例, 而子 agent 是**真子进程**
// (Legion.spawnAgent → spawn(process.execPath, [agent-worker.js]))。治理器在单进程内
// 再严谨也管不到隔壁 pid: 主进程限额 8, 三层嵌套各持一份 8, 机器上就是 8×8。
// 本测试里第 7 项是真的起一个独立 node 进程去占名额 —— 只有真跨进程才证得明。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CrossProcessQuota, pidAlive } from "../src/orchestrator/quota-file.js";
import { ConcurrencyGovernor, resetGovernor } from "../src/orchestrator/governor.js";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-quota-${tag}-`));
}

test("1) pidAlive: 自己活着, 不存在的 pid 死了", () => {
  assert.equal(pidAlive(process.pid), true, "自身 pid 必须判活");
  // 找一个几乎不可能存在的 pid: 32 位上限附近 (Linux 默认 max pid 4194304, Windows pid 远小于此)
  assert.equal(pidAlive(4139999), false, "不存在的 pid 必须判死");
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive("abc"), false);
});

test("2) 账本: acquire 后 total 增加, release 后归零", () => {
  const dir = tmpDir("basic");
  const q = CrossProcessQuota.inDir(dir, { limit: 4 });
  assert.equal(q.stats().total, 0);

  const rel = q.tryAcquire(3);
  assert.ok(rel, "limit=4 时申请 3 个应成功");
  assert.equal(q.stats().total, 3);

  assert.equal(rel(), true, "首次归还返回 true");
  assert.equal(rel(), false, "重复归还必须幂等返回 false");
  assert.equal(q.stats().total, 0);
});

test("3) 账本: 超额申请返回 null (不是抛错)", () => {
  const dir = tmpDir("over");
  const q = CrossProcessQuota.inDir(dir, { limit: 2 });
  const a = q.tryAcquire(2);
  assert.ok(a);
  assert.equal(q.tryAcquire(1), null, "limit=2 已占满, 再申 1 个必须被拒");
  a();
  assert.ok(q.tryAcquire(1), "归还后应能重新拿到");
});

test("4) 账本: 申请数超过 limit 时钳到 limit 而不是永久占死", () => {
  const dir = tmpDir("clamp");
  const q = CrossProcessQuota.inDir(dir, { limit: 3 });
  const rel = q.tryAcquire(99);
  assert.ok(rel, "超额请求按 limit 钳制后应放行 (上层意图是'尽可能宽')");
  assert.equal(q.stats().total, 3, "实际占用不得超过 limit");
  rel();
  assert.equal(q.stats().total, 0);
});

test("5) 账本: 死进程留下的名额会被回收 (kill -9 没有归还机会)", () => {
  const dir = tmpDir("reap");
  const q = CrossProcessQuota.inDir(dir, { limit: 2 });
  // 手工伪造一条死 pid 的占座记录 —— 等价于子进程被强杀后的账本残留
  fs.writeFileSync(q.file, JSON.stringify({ v: 1, holders: { "4139999": { n: 2, ts: Date.now() } } }), "utf8");
  const raw = JSON.parse(fs.readFileSync(q.file, "utf8"));
  assert.equal(raw.holders["4139999"].n, 2, "落盘的原始记录里确有 2 个名额");
  // 注意: stats() 本身就带回收语义 (读账本即顺手清死 pid), 所以"回收前"只能看原始文件,
  //       第一次 stats() 之后账本就已经干净了 —— 这是设计, 不是 bug。
  assert.equal(q.stats().total, 0, "读账本时应已回收死 pid 名额");
  assert.ok(q.reaped >= 1, "应记录回收次数");
  // 回收后必须能重新拿到名额, 否则账本泄漏就是永久的
  const rel = q.tryAcquire(2);
  assert.ok(rel, "死 pid 名额回收后应可重新分配");
  rel();
});

test("6) 账本损坏: 按空账本重建而不是卡死委派链", () => {
  const dir = tmpDir("corrupt");
  const q = CrossProcessQuota.inDir(dir, { limit: 2 });
  fs.writeFileSync(q.file, "{ 这不是 json", "utf8");
  const rel = q.tryAcquire(1);
  assert.ok(rel, "账本损坏时必须 fail-open 放行 (宁可短暂超发, 也不能让 IO 故障打挂委派)");
  rel();
});

test("7) 真跨进程: 另一个 node 进程占满名额后, 本进程必须被拒", async () => {
  const dir = tmpDir("xproc");
  const q = CrossProcessQuota.inDir(dir, { limit: 2 });
  q.reset();

  // 子进程脚本写成文件再跑: `node -e` 里塞 ESM import + 顶层 await + Windows 反斜杠路径
  // 三重转义太脆 (实测直接 exit 0, 连 READY 都没打出来)。落文件是唯一稳的写法。
  const childScript = path.join(dir, "holder.mjs");
  const modUrl = new URL("../src/orchestrator/quota-file.js", import.meta.url).href;
  fs.writeFileSync(childScript, [
    `import { CrossProcessQuota } from ${JSON.stringify(modUrl)};`,
    `const q = new CrossProcessQuota(${JSON.stringify(q.file)}, { limit: 2 });`,
    `q.tryAcquire(2);`,
    `process.stdout.write("READY\\n");`,
    `setTimeout(() => process.exit(0), 3000);`, // 故意不归还: 模拟 kill -9
    ``,
  ].join("\n"), "utf8");
  const child = spawn(process.execPath, [childScript], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });

  // 等子进程就位
  await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("子进程 10s 内未就绪")), 10000);
    child.stdout.on("data", (d) => {
      buf += String(d);
      if (buf.includes("READY")) { clearTimeout(t); resolve(); }
    });
    child.on("exit", () => { clearTimeout(t); reject(new Error("子进程提前退出")); });
  });

  // 此时账本里被另一个进程占了 2/2
  const s = q.stats();
  assert.equal(s.total, 2, `跨进程占用应为 2, 实际 ${s.total}`);
  assert.notEqual(Object.keys(s.holders)[0], String(process.pid), "占用者必须是别的 pid");
  assert.equal(q.tryAcquire(1), null, "别的进程占满后, 本进程必须被拒 —— 这正是进程级单例做不到的");

  // 子进程退出后 (没归还), 死 pid 回收必须把名额放出来
  await new Promise((r) => child.on("exit", r));
  const rel = q.tryAcquire(1);
  assert.ok(rel, "子进程退出后名额应被回收并可重新分配");
  rel();
});

test("8) 治理器接入: 挂账本后跨进程满则拒绝, 关闭后恢复按本地 limit", async () => {
  const dir = tmpDir("gov");
  resetGovernor();
  const g = new ConcurrencyGovernor({ limit: 4 });
  g.setCrossProcess({ enabled: true, dataDir: dir, limit: 2 });

  const a = g.tryAcquire(2);
  assert.ok(a, "账本 limit=2: 首批 2 个应放行");
  assert.equal(g.tryAcquire(1), null, "跨进程满额时治理器必须拒绝 (本地还有 2 个空也不放行)");
  assert.ok(g.stats().crossProcess.enabled, "stats 必须暴露跨进程状态");
  assert.equal(g.stats().crossProcess.total, 2);

  a();
  assert.ok(g.tryAcquire(1), "归还后应重新放行");

  // 关闭账本 → 回到纯本地治理 (默认路径, 不带任何文件 IO)
  g.setCrossProcess({ enabled: false });
  assert.equal(g.stats().crossProcess.enabled, false);
  resetGovernor();
});

test("9) 治理器 fail-open: 账本路径不可写时降级为单进程软约束而非抛错", () => {
  resetGovernor();
  const g = new ConcurrencyGovernor({ limit: 2 });
  // 指向一个不可能创建的路径 (父目录是文件, 不是目录)
  const badFile = path.join(tmpDir("bad"), "nope", "quota.json");
  fs.writeFileSync(path.join(path.dirname(badFile)), "x");
  g.setCrossProcess({ enabled: true, file: badFile, limit: 2 });
  const rel = g.tryAcquire(1);
  assert.ok(rel, "账本不可用时必须放行 (fail-open), 不能让 IO 故障打挂委派");
  assert.ok(g.stats().crossProcess.unavailable >= 1, "失败次数必须可见 —— 治理不能静默降级");
  rel();
  resetGovernor();
});
