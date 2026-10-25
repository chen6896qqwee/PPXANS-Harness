// test/scene-id-backfill-2026-10-04.test.js — F8: 无 id 场景不再被静默删除
// 钉住的不变量:
//   SceneStore.mergeScenes 的并集是按 id 取的, 而 SCENES_SCHEMA_VERSION=1 的"纯数组"基线里
//   从来没有哪里补过 id —— 旧实现 `if (!s || !s.id) return;` 直接把无 id 场景跳过,
//   于是 v1 遗留场景 (连同它承载的 facts) 在一次普通 assign() 之后从 scenes.json 消失。
//   现在: 磁盘态 ∪ 内存态时给无 id 场景**确定性补号** (s_h + FNV-1a 内容哈希),
//   并在构造时一次性落盘迁移 (常态零写盘); 有 id 的场景仍按 id 并集, 语义不变。
//   为什么是内容哈希而不是 shortId 随机: 两个进程各自给同一条无 id 场景补的号必须相同,
//   否则"按 id 并集"会把一条场景裂成两条 —— 随机号只是把丢更新换成了丢重复。
//   2026-10-04 修正: 补号必须识别"同哈希 ⟹ 同场景 ⟹ 并集", 而不是逢撞号就加后缀 ——
//   后者让内容相同的重复行 (含构造期迁移把同一批行喂两遍) 裂成 base/base_2 两条,
//   facts 从此各长各的、永不合流, 与 F8 同一丢失类。后缀只留给真撞号 (异内容同号)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SceneStore } from "../src/memory/l2.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const L2_URL = pathToFileURL(path.join(ROOT, "src", "memory", "l2.js")).href;

function tmp(name = "f8") { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${name}-`)); }
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ } }
const scenesFile = (dir) => path.join(dir, "memory", "l2", "scenes.json");
const rowsOf = (dir) => JSON.parse(fs.readFileSync(scenesFile(dir), "utf8"));
function writeScenes(dir, rows) {
  fs.mkdirSync(path.dirname(scenesFile(dir)), { recursive: true });
  fs.writeFileSync(scenesFile(dir), JSON.stringify(rows, null, 2), "utf8");
}

// v1 遗留形态: 一条无 id 场景 (挂着两条用户记忆) + 一条有 id 场景
const V1 = () => ([
  {
    name: "投资偏好", keywords: ["投资", "风险"], mode: "auto",
    facts: [
      { id: "f_old1", content: "用户偏好低风险品种", ts: "2026-01-01" },
      { id: "f_old2", content: "不加杠杆", ts: "2026-01-02" },
    ],
    created: "2026-01-01", lastUpdated: "2026-01-05",
  },
  {
    id: "s_keep01", name: "出行", keywords: ["出行"], mode: "auto",
    facts: [{ id: "f_old3", content: "长途偏好高铁", ts: "2026-02-01" }],
    created: "2026-02-01", lastUpdated: "2026-02-01",
  },
]);

// 修复前的 mergeScenes 形状 (逐字对照用): 无 id 直接跳过
function legacyMergeScenes(disk, mem) {
  const byId = new Map();
  for (const s of [...(disk || []), ...(mem || [])]) {
    if (!s || !s.id) continue;
    byId.set(s.id, s);
  }
  return [...byId.values()];
}

// ===========================================================================
// 1) 一次性迁移 + 第二次写入不丢东西 (F8 主案)
// ===========================================================================
test("F8: v1 无 id 场景在构造时被确定性补号并落盘, 另一个实例 assign() 后一条不少", () => {
  const dir = tmp("f8-migrate");
  try {
    writeScenes(dir, V1());
    const a = new SceneStore(dir);
    assert.equal(a.count(), 2, "两条场景都在");
    assert.ok(a.scenes.every((s) => typeof s.id === "string" && s.id.length > 0), "内存态全部有 id");
    const migrated = a.scenes.find((s) => s.name === "投资偏好");
    assert.match(migrated.id, /^s_h/, "补出来的 id 带 s_h 前缀 (与 shortId('s_',8) 同族, 不会与既有 id 撞)");
    assert.deepEqual(migrated.facts.map((f) => f.id), ["f_old1", "f_old2"], "承载的记忆原样保留");
    // 盘上也已迁移 (不是只在内存里补号)
    assert.ok(rowsOf(dir).every((s) => s.id), "磁盘上不再有缺 id 的行");

    // 另一个实例 (CLI 之外还有一份进程/另一轮对话) 走一次普通写入
    const b = new SceneStore(dir);
    const got = b.assign({ id: "f_new", content: "投资 风险 分散", created: "2026-03-01" });
    assert.equal(got.id, migrated.id, "命中已迁移的那条场景 (补号没改变匹配行为)");
    const rows = rowsOf(dir);
    assert.equal(rows.length, 2, `场景数不变 (实到 ${rows.length})`);
    const invest = rows.find((s) => s.name === "投资偏好");
    for (const fid of ["f_old1", "f_old2", "f_new"]) {
      assert.ok(invest.facts.some((f) => f.id === fid), `记忆 ${fid} 还在`);
    }
    assert.ok(rows.some((s) => s.id === "s_keep01"), "有 id 的场景照常并在一起");
  } finally { rmrf(dir); }
});

test("F8: 旧形状复现 —— 无 id 场景在一次 assign() 后被整条抹掉 (证明上面的测抓得到 bug)", () => {
  const dir = tmp("f8-legacy");
  const real = SceneStore.mergeScenes;
  try {
    SceneStore.mergeScenes = legacyMergeScenes;
    const a = new SceneStore(dir);
    a.create({ name: "占位", keywords: ["占位"] });   // 旧构造: 无迁移, 先有一条有 id 的场景
    writeScenes(dir, V1());                            // 盘上退回 v1: 一条无 id + 一条有 id
    const b = new SceneStore(dir);
    b._reload = () => { b.scenes = SceneStore.mergeScenes(rowsOf(dir), b.scenes); return b.scenes; };
    b.assign({ id: "f_new", content: "投资 风险 分散", created: "2026-03-01" });
    const rows = rowsOf(dir);
    assert.ok(!rows.some((s) => s.name === "投资偏好"), "旧形状: 无 id 场景被静默丢弃");
    assert.equal(rows.filter((s) => s.name === "投资偏好").length, 0);
    assert.ok(!rows.flatMap((s) => s.facts || []).some((f) => f.id === "f_old1"),
      "旧形状: 丢的是两条用户记忆, 不只是元数据");
    // 修正 (2026-10-04): 旧断言 rows.length===1 记错了 bug 的形状 —— assign 命中不了
    //   已消失的关键词, 会凭空新建一条自动场景, 所以盘上是"有 id 的那条 + 空壳替身"
    //   共 2 行。丢失证据 = 原场景与其记忆不在, 替身只带这一次的新记忆。
    assert.equal(rows.length, 2, "旧形状: 有 id 的那条还在, 原场景被一个空壳替身顶替");
    assert.ok(rows.some((s) => s.id === "s_keep01"), "旧形状: 有 id 的场景不受影响");
    const ghost = rows.find((s) => s.id !== "s_keep01");
    assert.deepEqual(ghost.facts.map((f) => f.id), ["f_new"], "v1 老记忆没有跟进替身 —— 丢的就是它们");
  } finally { SceneStore.mergeScenes = real; rmrf(dir); }
});

test("F8: 补号是确定性的 —— 同一条无 id 场景在两个实例手里拿到同一个 id (不裂成两条)", () => {
  const dir = tmp("f8-deterministic");
  try {
    const v1 = V1();
    const idA = SceneStore.mergeScenes(v1, []).find((s) => s.name === "投资偏好").id;
    const idB = SceneStore.mergeScenes([], v1).find((s) => s.name === "投资偏好").id;
    assert.equal(idA, idB, "磁盘先后顺序不影响补出来的 id");
    assert.equal(SceneStore.mergeScenes(v1, v1).filter((s) => s.name === "投资偏好").length, 1,
      "并集去重成立: 一条场景不会因为两边各补一次号而裂成两条");
    // 内容不同则 id 不同 (不是常量)
    const other = SceneStore.mergeScenes([{ name: "别的场景", facts: [] }], []);
    assert.notEqual(other[0].id, idA);
  } finally { rmrf(dir); }
});

test("F8: 重复无 id 条目 —— 同内容并成一条, 异内容各拿自己的哈希号, 真撞号才加后缀", () => {
  const rows = SceneStore.mergeScenes([
    { name: "重复", facts: [{ id: "x1", content: "一" }] },
    { name: "重复", facts: [{ id: "x1", content: "一" }] },
    { name: "重复", facts: [{ id: "x2", content: "二" }] },
  ], []);
  assert.equal(rows.length, 2, "内容完全相同的两份并成一条; 内容不同的那条本就是另一条场景");
  // 修正 (2026-10-04): 旧断言期望第二行是 rows[0].id+"_2" —— 那是"逢撞号就加后缀"的分裂
  //   语义 (本测试要钉死的 bug 本身)。内容不同 ⟹ 哈希不同 ⟹ 天然两个号, 后缀只属于真撞号。
  assert.match(rows[0].id, /^s_h[0-9a-z]{7}$/);
  assert.match(rows[1].id, /^s_h[0-9a-z]{7}$/);
  assert.notEqual(rows[1].id, rows[0].id, "两条不同内容场景各自成号");
  assert.notEqual(rows[1].id, rows[0].id + "_2", "不是消歧后缀号");
  assert.deepEqual(rows[0].facts.map((f) => f.id), ["x1"], "同内容重复喂入, facts 不翻倍");
  assert.equal(rows[1].facts.length, 1);
  // 真撞号: 某行显式 id 恰好等于另一条无 id 场景的补号基数, 内容又不同 → 两条都要活, 后来者让位加后缀
  const derived = SceneStore.mergeScenes([{ name: "甲", facts: [] }], [])[0];
  const clash = SceneStore.mergeScenes([
    { id: derived.id, name: "占了号的另一场景", facts: [] },
    { name: "甲", facts: [] },
  ], []);
  assert.equal(clash.length, 2, "同号不同内容是两条场景, 谁都不许被并掉");
  assert.equal(clash[0].id, derived.id);
  assert.equal(clash[1].id, derived.id + "_2", "真撞号才走后缀消歧");
  // 同号且同内容 (另一进程已迁移落盘) 则是同一条场景 → 并, 不产生 _2
  const remerged = SceneStore.mergeScenes([derived], [{ name: "甲", facts: [] }]);
  assert.equal(remerged.length, 1, "显式同内容行与无 id 行并成一条");
  assert.equal(remerged[0].id, derived.id);
});

test("F8: 常态 (全部有 id) 迁移是零写盘 —— 构造不碰文件", () => {
  const dir = tmp("f8-noop");
  try {
    writeScenes(dir, V1().map((s, i) => (s.id ? s : { ...s, id: "s_back" + i })));
    const before = fs.readFileSync(scenesFile(dir), "utf8");
    new SceneStore(dir);
    assert.equal(fs.readFileSync(scenesFile(dir), "utf8"), before, "全有 id 时构造期一个字节都不写");
  } finally { rmrf(dir); }
});

test("F8: 有 id 的场景仍是磁盘并内存 —— 陈旧内存写盘不带丢别的进程新增的记忆", () => {
  const dir = tmp("f8-union");
  try {
    writeScenes(dir, [{ id: "s_1", name: "网络", keywords: ["网络"], facts: [], created: "2026-01-01", lastUpdated: "2026-01-01" }]);
    const stale = new SceneStore(dir);          // 内存: s_1 空 facts
    const other = new SceneStore(dir);
    other.assign({ id: "f_disk", content: "网络 波动 排查", created: "2026-02-01" });
    const got = stale.assign({ id: "f_mem", content: "网络 延迟 抖动", created: "2026-02-02" });
    assert.equal(got.id, "s_1", "仍归入同一场景");
    const facts = rowsOf(dir).find((s) => s.id === "s_1").facts.map((f) => f.id);
    assert.deepEqual(facts.sort(), ["f_disk", "f_mem"], "两边的记忆并集都在");
  } finally { rmrf(dir); }
});

// ===========================================================================
// 2) 跨进程: 两个真实 OS 进程各自迁移同一条 v1 场景
// ===========================================================================
const PRELUDE = `
import fs from "node:fs";
import path from "node:path";
const { SceneStore } = await import(${JSON.stringify(L2_URL)});
const D = process.env.PPX_C_DIR;
const ROLE = process.env.PPX_C_ROLE;
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

const CHILD = PRELUDE + `
const s = new SceneStore(D);
mark("ready");
waitMark("go");
s.assign({ id: "f_" + ROLE, content: "投资 风险 分散", created: "2026-03-0" + (ROLE === "a" ? 1 : 2) });
mark("done");
`;

async function runKids(dir) {
  const kids = ["a", "b"].map((role) => spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
    env: { ...process.env, PPX_C_DIR: dir, PPX_C_ROLE: role },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  let out = "";
  for (const k of kids) { k.stderr.on("data", (d) => { out += d; }); k.stdout.on("data", (d) => { out += d; }); }
  const started = Date.now();
  while (!kids.every((k) => k.__exited || fs.existsSync(path.join(dir, `ready.${["a", "b"][kids.indexOf(k)]}`)))) {
    if (Date.now() - started > 25000) { for (const k of kids) k.kill(); assert.fail(`子进程 25s 未就绪: ${out}`); }
    await new Promise((r) => setTimeout(r, 20));
  }
  fs.writeFileSync(path.join(dir, "go"), "go");
  const codes = await Promise.all(kids.map((k) => new Promise((res, rej) => {
    k.on("exit", (c) => { k.__exited = true; res(c); }); k.on("error", rej);
  })));
  assert.deepEqual(codes, [0, 0], `子进程应正常退出 (代码 ${codes}), 输出: ${out}`);
  return out;
}

test("F8: 两个真实进程同时面对同一份 v1 无 id 场景 —— 补号一致, 记忆全在, 场景不裂", { timeout: 90000 }, async () => {
  const dir = tmp("f8-kids");
  try {
    writeScenes(dir, V1());
    await runKids(dir);
    const rows = rowsOf(dir);
    const invest = rows.filter((s) => s.name === "投资偏好");
    assert.equal(invest.length, 1, `同一条 v1 场景只应有一份, 实到 ${invest.length} (两个进程补号必须一致)`);
    const ids = invest[0].facts.map((f) => f.id).sort();
    assert.deepEqual(ids, ["f_a", "f_b", "f_old1", "f_old2"], "两个进程的新记忆与 v1 原记忆全部并在一处");
    assert.equal(rows.filter((s) => s.id === "s_keep01").length, 1, "有 id 的场景没被重复/丢失");
    assert.equal(new Set(rows.map((s) => s.id)).size, rows.length, "id 唯一");
    assert.ok(rows.every((s) => s.id), "盘上不再有缺 id 的行");
  } finally { rmrf(dir); }
});
