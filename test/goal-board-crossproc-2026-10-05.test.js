// test/goal-board-crossproc-2026-10-05.test.js — 两个真实 OS 进程并发写同一份计划台账
// 为什么单开一个跨进程文件: 军团/CLI+Web 是**多个进程共用一个 dataDir** 的真实形态,
// 而 goal_board 的旧形态是"进程内 Map" —— 计划随进程退出蒸发。持久化改造引入了两个新风险面,
// 只有真进程才能证伪 (单进程里两个实例永远共享同一份内存, 测不出覆盖式丢失):
//   A. 两个进程同时各加一步: 锁内"读-改-写"+ 磁盘∪内存并集必须让**两条都在**
//      (旧式"基于过期内存整体写盘"会把对方刚落的goal 抹掉 —— 丢更新)。
//   B. 盘上有一条**缺 id** 的历史目标, 两个进程同时装载并各写一次: 补号必须是**内容哈希**
//      而非随机号, 否则两边各补一个号 → "按 id 并集"把一条目标裂成两条 → 再叠加覆盖写就是
//      又一次静默丢数据 (2026-10-04 memory/l2.js F8 修掉的真实用户记忆丢失 bug, 同一类)。
// 全程零网络零 LLM: 只用 node -e 子进程 + 临时目录 + 文件标记握手。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createGoalBoard, deriveGoalId, mergeGoals } from "../src/evidence/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_URL = pathToFileURL(path.join(ROOT, "src", "evidence", "index.js")).href;

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-goalxp-${tag}-`));
const goalsFile = (dir) => path.join(dir, "evidence", "goals.json");
const rowsOf = (dir) => JSON.parse(fs.readFileSync(goalsFile(dir), "utf8"));
function writeGoals(dir, rows) {
  fs.mkdirSync(path.dirname(goalsFile(dir)), { recursive: true });
  fs.writeFileSync(goalsFile(dir), JSON.stringify(rows, null, 2), "utf8");
}

// 子进程骨架: 就绪标记 → 等 go → 写完落"done"标记 (parent 用标记把并发窗口对齐到同一刻)
const PRELUDE = `
import fs from "node:fs";
import path from "node:path";
const { createGoalBoard } = await import(${JSON.stringify(EVIDENCE_URL)});
const D = process.env.PPX_G_DIR;
const ROLE = process.env.PPX_G_ROLE;
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

// A: 装载 (此刻盘上没有缺 id 的行) → 同一刻各写各的
const CHILD_ADD = PRELUDE + `
const b = createGoalBoard({ dataDir: D });
mark("ready");
waitMark("go");
b.addGoal({ title: "进程" + ROLE + "的一步", priority: ROLE === "a" ? "p0" : "p1" });
b.addGoal({ title: "进程" + ROLE + "的第二步", priority: "p2" });
mark("done");
`;

// B: 装载即触发"缺 id 行一次性补号"落盘 —— 两个进程同时面对同一条历史行
const CHILD_MIGRATE = PRELUDE + `
const b = createGoalBoard({ dataDir: D });   // 构造期就会补号并写盘 (两边同时抢这把锁)
mark("ready");
waitMark("go");
b.addGoal({ title: "进程" + ROLE + "的一步", priority: "p1" });
mark("done");
`;

async function runKids(dir, childSource) {
  const roles = ["a", "b"];
  const kids = roles.map((role) => spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    env: { ...process.env, PPX_G_DIR: dir, PPX_G_ROLE: role },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  let out = "";
  for (const k of kids) { k.stdout.on("data", (d) => { out += d; }); k.stderr.on("data", (d) => { out += d; }); }
  // 两个子进程都装载完毕 (内存态都是"装载那一刻"的旧盘态) 后才放行 → 写窗口真正重叠
  const started = Date.now();
  while (!roles.every((r) => fs.existsSync(path.join(dir, `ready.${r}`)))) {
    if (Date.now() - started > 25000) { for (const k of kids) k.kill(); assert.fail(`子进程 25s 未就绪: ${out}`); }
    await new Promise((r) => setTimeout(r, 10));
  }
  fs.writeFileSync(path.join(dir, "go"), "go");
  const codes = await Promise.all(kids.map((k) => new Promise((res, rej) => {
    k.on("exit", (c) => res(c)); k.on("error", rej);
  })));
  assert.deepEqual(codes, [0, 0], `子进程应正常退出 (代码 ${codes}), 输出: ${out}`);
  return out;
}

// 收尾体检: 锁文件/临时文件/损坏留档都不该残留 (残留说明临界区没走完或现场被误判)
function assertNoLeftovers(dir) {
  const files = [...fs.readdirSync(dir), ...fs.readdirSync(path.join(dir, "evidence"))];
  assert.deepEqual(files.filter((f) => f.endsWith(".lock")), [], "goals.json.lock 必须已释放");
  assert.deepEqual(files.filter((f) => f.includes(".corrupt-")), [], "没有损坏留档说明两次写都没踩坏文件");
  assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), [], "原子写的临时文件不残留");
}

test("A: 两个真实进程同时往同一份台账加目标 —— 一条不少, id 不撞, 无残留", { timeout: 120000 }, async () => {
  const dir = tmp("add");
  try {
    await runKids(dir, CHILD_ADD);
    const rows = rowsOf(dir);
    const titles = rows.map((r) => r.title).sort();
    assert.deepEqual(titles, ["进程a的一步", "进程a的第二步", "进程b的一步", "进程b的第二步"],
      "两边的四次写入全部并集落盘 (丢任何一条 = 覆盖式写入回来了)");
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "id 互不相同");
    assert.ok(rows.every((r) => /^g_/.test(r.id) && r.priority && r.status && r.title), "每条都是规范形态");
    assert.deepEqual(rows.map((r) => r.priority), ["P0", "P1", "P2", "P2"], "按全序落盘 (与进程写入次序无关)");
    // 第三方 (重启后的进程 / Web 服务) 读到的是同一份合并结果
    const later = createGoalBoard({ dataDir: dir });
    assert.equal(later.count(), 4);
    assert.ok(later.promptBlock().includes("进程b的一步"), "另一个进程的计划也进了注入块");
    assertNoLeftovers(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("B: 两个真实进程同时迁移同一条缺 id 历史目标 —— 补号一致, 目标不裂也不丢", { timeout: 120000 }, async () => {
  const dir = tmp("migrate");
  try {
    // 旧形态 (goal_board 从没成功写过, 但并集不变量对手写/未来数据一样成立): 缺 id 的一行
    const legacy = { title: "遗留的一步", priority: "P1", status: "pending" };
    writeGoals(dir, [legacy]);
    await runKids(dir, CHILD_MIGRATE);
    const rows = rowsOf(dir);
    const old = rows.filter((r) => r.title === "遗留的一步");
    assert.equal(old.length, 1, `遗留目标只应有一份, 实到 ${old.length} (两个进程补的号必须一致)`);
    assert.equal(old[0].id, deriveGoalId(legacy), "补号 = g_h + 内容哈希 (与 memory/l2.js F8 同一不变量)");
    assert.match(old[0].id, /^g_h[0-9a-z]{7}$/, "不是随机号: 随机号会把一条目标裂成两条");
    const titles = rows.map((r) => r.title).sort();
    assert.deepEqual(titles, ["进程a的一步", "进程b的一步", "遗留的一步"], "两边的新目标与历史目标并在一处");
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "id 唯一");
    assert.ok(rows.every((r) => r.id), "盘上不再有缺 id 的行");
    assertNoLeftovers(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("B2: 反证 —— 缺 id 行若用随机号补, 两个进程就会各写一条 (F8 丢失类换机制复现)", () => {
  // 这条不跑真进程, 只把"随机补号 vs 哈希补号"的差别钉成一个纯函数断言:
  // mergeGoals 对同一份缺 id 数据两次调用必须给出**同一个** id, 否则并集去重根本不成立。
  const rows = [{ title: "遗留的一步", priority: "P1", status: "pending" }];
  const first = mergeIds(rows);
  const second = mergeIds(rows);
  assert.deepEqual(first, second, "补号确定性 (随机号在这里就会分叉, 与 l2 当年同一形状)");
  assert.equal(mergeGoals(rows, rows).length, 1, "两侧各补一次号仍是同一条目标, 不裂成两条");
  assert.notEqual(mergeGoals(rows, [{ title: "别的", priority: "P2", status: "pending" }])[1].id, first[0],
    "内容不同则号不同 (不是常量)");
  function mergeIds(list) { return mergeGoals(list, []).map((g) => g.id); }
});
