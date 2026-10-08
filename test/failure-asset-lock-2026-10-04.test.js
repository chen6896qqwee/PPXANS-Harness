// test/failure-asset-lock-2026-10-04.test.js — F3: 病历库/资产库的跨进程读-改-写
// 钉住的不变量 (2026-10-04 修的是这两处同类缺陷):
//   memory/failures/episodes.json 与 memory/assets/registry.json 是 CLI + Web + 自愈探针**共写**的文件,
//   旧实现是"构造时读一次 + 每次全量重写"(中间既没有文件锁, 也没有锁内重读),
//   于是后写的那一方把对手刚落盘的内容整段覆盖 —— 病历/资产静默丢失。
//   现在: withFileLock(锁内重读磁盘 → 按 id 并集合并 → 原子全量写), 临界区**全同步**
//   (withFileLock 的 fn 一旦 await 就提前释放锁, 这是 utils/store.js 的已知缺陷)。
// 判据一律是"两个真实 OS 进程写同一个 dataDir": 跨进程不变量只能跨进程证。
// 每个窗口都跑两遍: 一遍现行实现, 一遍用 env 开关退回修复前的形状 (证明测试真抓得到旧 bug)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FailureEpisodeStore } from "../src/memory/failure-episode.js";
import { AssetHub } from "../src/memory/asset-hub.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FE_URL = pathToFileURL(path.join(ROOT, "src", "memory", "failure-episode.js")).href;
const AH_URL = pathToFileURL(path.join(ROOT, "src", "memory", "asset-hub.js")).href;
const STORE_URL = pathToFileURL(path.join(ROOT, "src", "utils", "store.js")).href;

function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${name}-`)); }
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ } }

// 子进程头部: 导入被测实现 (与主代码同一份文件), 就绪/放行/完成三对标记
const PRELUDE = `
import fs from "node:fs";
import path from "node:path";
const { FailureEpisodeStore } = await import(${JSON.stringify(FE_URL)});
const { AssetHub } = await import(${JSON.stringify(AH_URL)});
const { writeJson } = await import(${JSON.stringify(STORE_URL)});
const D = process.env.PPX_C_DIR;
const ROLE = process.env.PPX_C_ROLE;
const LEGACY = process.env.PPX_F3_LEGACY === "1";
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
// 修复前的形状 (逐条对照): 无锁 + 无锁内重读, 把本进程内存态整体盖到磁盘上
if (LEGACY) {
  FailureEpisodeStore.prototype.record = function (ep) {
    const e = { id: "fe" + ROLE + (this.__n = (this.__n || 0) + 1), tool: ep.tool, error: ep.error,
      category: "unknown", rootCause: null, fix: null, confidence: 0, traceRef: null, hit: 0, ts: Date.now() };
    this._episodes.unshift(e);
    writeJson(this.file, this._episodes);   // 旧: 直接全量重写
    return e;
  };
  AssetHub.prototype.register = function (asset) {
    const a = { id: "as" + ROLE + (this.__n = (this.__n || 0) + 1), name: asset.name, kind: asset.kind || "document",
      scope: null, owner: "local", visibility: "private", source: null, description: "", version: 1, uses: 0,
      createdAt: Date.now(), updatedAt: Date.now() };
    this._assets.push(a);
    writeJson(this.file, this._assets);     // 旧: 直接全量重写
    return a;
  };
  AssetHub.prototype.equip = function (id) {
    const a = this._assets.find((x) => x.id === id && !x.deleted);
    if (!a) return null;
    a.uses++; a.updatedAt = Date.now();
    writeJson(this.file, this._assets);     // 旧: 内存里那份旧计数盖回磁盘
    return a;
  };
}
`;

async function runKids(dir, scripts, legacy = false) {
  const kids = scripts.map(({ code, role }) => spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, PPX_C_DIR: dir, PPX_C_ROLE: role, PPX_F3_LEGACY: legacy ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  let out = "";
  for (const k of kids) { k.stderr.on("data", (d) => { out += d; }); k.stdout.on("data", (d) => { out += d; }); }
  const started = Date.now();
  while (!kids.every((k, i) => k.__exited || fs.existsSync(path.join(dir, `ready.${scripts[i].role}`)))) {
    if (Date.now() - started > 25000) { for (const k of kids) k.kill(); assert.fail(`子进程 25s 未就绪: ${out}`); }
    await new Promise((r) => setTimeout(r, 20));
  }
  fs.writeFileSync(path.join(dir, "go"), "go");
  const codes = await Promise.all(kids.map((k) => new Promise((resolve, reject) => {
    k.on("exit", (c) => { k.__exited = true; resolve(c); });
    k.on("error", reject);
  })));
  assert.deepEqual(codes, [0, 0], `子进程应正常退出 (代码 ${codes}), 输出: ${out}`);
  return out;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// 两次损坏留档用的是毫秒时间戳, 中间空过 2ms 保证档名不同 (否则 Windows 上第二次改名会撞名)
function gap(ms = 3) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) {} }
}

// 两个子进程同时写同一个共享文件, 各 N 次
const raceChild = (kind, n) => PRELUDE + `
const s = ${kind === "fe" ? "new FailureEpisodeStore(D)" : "new AssetHub(D)"};
mark("ready");
waitMark("go");
for (let i = 0; i < ${n}; i++) {
  if (${kind === "fe"}) s.record({ tool: "tool-" + ROLE, error: "ERR_" + ROLE + "_" + i, rootCause: "rc-" + ROLE });
  else s.register({ name: "asset-" + ROLE + "-" + i, kind: "skill" });
}
mark("done");
`;

function feFile(dir) { return path.join(dir, "memory", "failures", "episodes.json"); }
function ahFile(dir) { return path.join(dir, "memory", "assets", "registry.json"); }

// ===========================================================================
// 窗口 1: 双进程 record() —— 病历零丢失 (F3 主案)
// ===========================================================================
test("F3: 两进程各 12 次 record() 写同一个 episodes.json —— 24 份病历一份不丢", { timeout: 90000 }, async () => {
  const dir = tmp("f3-fe-race");
  try {
    await runKids(dir, [
      { role: "a", code: raceChild("fe", 12) },
      { role: "b", code: raceChild("fe", 12) },
    ]);
    const all = readJson(feFile(dir));
    assert.equal(all.length, 24, `24 次 record() 应留下 24 行, 实到 ${all.length}`);
    assert.equal(new Set(all.map((e) => e.id)).size, 24, "id 无重复");
    for (const role of ["a", "b"]) {
      for (let i = 0; i < 12; i++) {
        assert.ok(all.some((e) => e.error === `ERR_${role}_${i}`), `丢病历: ERR_${role}_${i}`);
      }
    }
    // 重开实例与盘一致 (没有"内存比盘多/盘比内存多"的漂移)
    const reopened = new FailureEpisodeStore(dir);
    assert.equal(reopened.list(1000).length, 24, "重开实例看到全部 24 条");
  } finally { rmrf(dir); }
});

test("F3: 旧形状复现 —— 载入一次 + 全量重写把对手的病历整段抹掉 (证明上面那测有效)", { timeout: 90000 }, async () => {
  const dir = tmp("f3-fe-legacy");
  try {
    await runKids(dir, [
      { role: "a", code: raceChild("fe", 12) },
      { role: "b", code: raceChild("fe", 12) },
    ], true);
    const all = readJson(feFile(dir));
    assert.equal(all.length, 12, `旧形状: 末位写者用自己内存里的 12 条盖掉全部, 实到 ${all.length}`);
    assert.equal(new Set(all.map((e) => e.tool)).size, 1, "旧形状: 盘上只剩一个进程的病历, 另一进程 12 条彻底消失");
  } finally { rmrf(dir); }
});

// ===========================================================================
// 窗口 2: 双进程 register() / equip() —— 资产登记与增量计数
// ===========================================================================
test("F3: 两进程各 10 次 register() 写同一个 registry.json —— 20 个登记一份不丢", { timeout: 90000 }, async () => {
  const dir = tmp("f3-ah-race");
  try {
    await runKids(dir, [
      { role: "a", code: raceChild("ah", 10) },
      { role: "b", code: raceChild("ah", 10) },
    ]);
    const all = readJson(ahFile(dir));
    assert.equal(all.length, 20, `20 次 register() 应留下 20 条, 实到 ${all.length}`);
    assert.equal(new Set(all.map((a) => a.id)).size, 20, "id 无重复");
    for (const role of ["a", "b"]) for (let i = 0; i < 10; i++) {
      assert.ok(all.some((a) => a.name === `asset-${role}-${i}`), `丢资产: asset-${role}-${i}`);
    }
    assert.equal(new AssetHub(dir).list().length, 20, "重开实例看到全部资产");
  } finally { rmrf(dir); }
});

test("F3: 旧形状复现 —— register() 全量重写抹掉对手登记的资产", { timeout: 90000 }, async () => {
  const dir = tmp("f3-ah-legacy");
  try {
    await runKids(dir, [
      { role: "a", code: raceChild("ah", 10) },
      { role: "b", code: raceChild("ah", 10) },
    ], true);
    const all = readJson(ahFile(dir));
    assert.equal(all.length, 10, `旧形状: 只剩末位写者的 10 条, 实到 ${all.length}`);
    assert.equal(new Set(all.map((a) => String(a.name).slice(6, 7))).size, 1, "旧形状: 另一进程 10 个资产彻底消失");
  } finally { rmrf(dir); }
});

// equip(): 同一资产被两个进程各装备 5 次 —— uses 是增量语义, 必须等于 10
const equipChild = () => PRELUDE + `
const s = new AssetHub(D);
const id = fs.readFileSync(path.join(D, "asset-id"), "utf8").trim();
mark("ready");
waitMark("go");
for (let i = 0; i < 5; i++) { if (!s.equip(id)) throw new Error("装备失败: " + id); }
mark("done");
`;

test("F3: 两进程各 5 次 equip(同一资产) —— uses 累加到 10, 不被旧计数盖回", { timeout: 90000 }, async () => {
  const dir = tmp("f3-equip");
  try {
    const hub = new AssetHub(dir);
    const a = hub.register({ name: "共享技能", kind: "skill" });
    fs.writeFileSync(path.join(dir, "asset-id"), a.id, "utf8");
    await runKids(dir, [
      { role: "a", code: equipChild() },
      { role: "b", code: equipChild() },
    ]);
    const all = readJson(ahFile(dir));
    assert.equal(all.length, 1, "只有一个资产 (登记没被并发写抹掉)");
    assert.equal(all[0].uses, 10, `10 次装备应累计 uses=10, 实到 ${all[0].uses}`);
    assert.equal(new AssetHub(dir).get(a.id).uses, 10, "重开实例同值");
  } finally { rmrf(dir); }
});

test("F3: 旧形状复现 —— equip() 用内存里的旧计数盖回磁盘, 一半装备次数丢失", { timeout: 90000 }, async () => {
  const dir = tmp("f3-equip-legacy");
  try {
    const hub = new AssetHub(dir);
    const a = hub.register({ name: "共享技能", kind: "skill" });
    fs.writeFileSync(path.join(dir, "asset-id"), a.id, "utf8");
    await runKids(dir, [
      { role: "a", code: equipChild(true) },
      { role: "b", code: equipChild(true) },
    ], true);
    const all = readJson(ahFile(dir));
    assert.equal(all[0].uses, 5, `旧形状: 末位写者把 uses 盖回自己内存里的 5, 实到 ${all[0].uses}`);
  } finally { rmrf(dir); }
});

// ===========================================================================
// 窗口 3: 同进程多实例 (CLI 与 Web 服务在同一进程内也会各 new 一份)
// ===========================================================================
test("F3: 同一 dataDir 上两个实例互不覆盖 (进程内也走锁内重读)", () => {
  const dir = tmp("f3-twoinst");
  try {
    const a = new FailureEpisodeStore(dir);
    const b = new FailureEpisodeStore(dir);
    a.record({ tool: "t-a", error: "AAA-01" });
    b.record({ tool: "t-b", error: "BBB-01" });
    a.record({ tool: "t-a", error: "AAA-02" });
    const onDisk = readJson(feFile(dir));
    assert.equal(onDisk.length, 3, `两实例交替写 3 条应全在盘上, 实到 ${onDisk.length}`);
    assert.deepEqual(onDisk.map((e) => e.error).sort(), ["AAA-01", "AAA-02", "BBB-01"]);
    // 关键: b 的内存态在下次动作时被磁盘最新态并进来, 不是停留在自己构造时看到的 0 条
    assert.equal(b.list(100).length, 3, "另一实例的写入对本实例可见 (锁内重读)");
    const hubA = new AssetHub(dir); const hubB = new AssetHub(dir);
    hubA.register({ name: "A1" }); hubB.register({ name: "B1" }); hubA.register({ name: "A2" });
    assert.deepEqual(readJson(ahFile(dir)).map((x) => x.name).sort(), ["A1", "A2", "B1"], "资产同口径");
    assert.equal(hubB.list().length, 3, "资产库另一实例也看到全部登记");
  } finally { rmrf(dir); }
});

// ===========================================================================
// 窗口 4: 损坏文件留档 (F3 另一半: 解析失败不得变成"空数组覆盖")
// ===========================================================================
test("F3: 损坏的 episodes.json / registry.json 先改名 .corrupt-<ts> 留档, 再写新内容", () => {
  for (const [label, Store, file, op] of [
    ["episodes", FailureEpisodeStore, feFile, (s) => s.record({ tool: "t", error: "E1" })],
    ["registry", AssetHub, ahFile, (s) => s.register({ name: "N1" })],
  ]) {
    const dir = tmp(`f3-corrupt-${label}`);
    try {
      fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
      fs.writeFileSync(file(dir), "{\"episodes\": [ 截断的半截 JSON", "utf8");   // 不可解析
      const before = fs.readFileSync(file(dir), "utf8");
      const s = new Store(dir);
      op(s);
      const archives = fs.readdirSync(path.dirname(file(dir))).filter((f) => f.includes(".corrupt-"));
      assert.equal(archives.length, 1, `${label}: 应留下 1 个 .corrupt- 档, 实到 ${archives.length}`);
      assert.equal(fs.readFileSync(path.join(path.dirname(file(dir)), archives[0]), "utf8"), before,
        `${label}: 留档内容与原损坏文件逐字一致 (可人工恢复)`);
      assert.deepEqual(readJson(file(dir)).length, 1, `${label}: 新内容照常写入`);
      // 第二次写不再产生新档 (标记已清)
      gap();
      op(s);
      assert.equal(fs.readdirSync(path.dirname(file(dir))).filter((f) => f.includes(".corrupt-")).length, 1,
        `${label}: 留档只发生一次`);
    } finally { rmrf(dir); }
  }
});

test("F3: 目录里已有 .corrupt- 档时不覆盖旧档 (两次损坏各留一份)", () => {
  const dir = tmp("f3-corrupt2");
  try {
    const s = new FailureEpisodeStore(dir);
    fs.writeFileSync(feFile(dir), "不是 JSON", "utf8");
    s.record({ tool: "t", error: "E1" });
    gap();
    fs.writeFileSync(feFile(dir), "又不是 JSON", "utf8");
    const s2 = new FailureEpisodeStore(dir);
    s2.record({ tool: "t", error: "E2" });
    const archives = fs.readdirSync(path.dirname(feFile(dir))).filter((f) => f.includes(".corrupt-"));
    assert.equal(archives.length, 2, `两次损坏应各留一档, 实到 ${archives.length}`);
    assert.equal(readJson(feFile(dir)).length, 1, "当前文件只剩本次 E2");
  } finally { rmrf(dir); }
});

// ===========================================================================
// 窗口 5: 写盘失败要响 (loud) 但不断 (non-fatal) —— 绝不允许静默空 catch
// ===========================================================================
test("F3: 落盘失败时 record()/register() 不抛异常, 但必须 warn 出声", () => {
  const dir = tmp("f3-loud");
  const realRename = fs.renameSync;
  const realLog = console.log;
  const logs = [];
  try {
    // 用"磁盘写不进去"造故障: renameSync 是 atomicWrite 的落盘动作
    fs.renameSync = () => { const e = new Error("模拟 EPERM"); throw e; };
    console.log = (...a) => { logs.push(a.join(" ")); };
    const s = new FailureEpisodeStore(dir);
    const e = s.record({ tool: "t", error: "E1" });
    assert.ok(e && e.id, "record() 仍返回结构化病历 (不阻断工具链)");
    const hub = new AssetHub(dir);
    const a = hub.register({ name: "N1" });
    assert.ok(a && a.id, "register() 仍返回资产");
    assert.equal(hub.get(a.id).name, "N1", "内存态保留, 调用方还能读到");
  } finally {
    fs.renameSync = realRename;
    console.log = realLog;
  }
  const warned = logs.filter((l) => /\[warn\]/.test(l));
  assert.ok(warned.length >= 2, `两次写失败至少要响两次 warn, 实到 ${warned.length}`);
  assert.ok(warned.some((l) => l.includes("failure-episode")), "病历失败的 warn 要标明出处");
  assert.ok(warned.some((l) => l.includes("asset-hub")), "资产失败的 warn 要标明出处");
  assert.ok(warned.every((l) => l.includes("模拟 EPERM") || l.includes("EPERM")), "失败原因要带进日志 (不能只说'写失败')");
  rmrf(dir);
});

test("F3: 写失败后下次成功写入不带出半截态 (内存/磁盘重新对齐)", () => {
  const dir = tmp("f3-recover");
  const realRename = fs.renameSync;
  const realLog = console.log;
  try {
    console.log = () => {};
    const s = new FailureEpisodeStore(dir);
    fs.renameSync = () => { throw new Error("模拟一次失败"); };
    s.record({ tool: "t", error: "LOST" });
    fs.renameSync = realRename;
    s.record({ tool: "t", error: "KEPT" });
    const onDisk = readJson(feFile(dir));
    assert.deepEqual(onDisk.map((e) => e.error), ["KEPT", "LOST"],
      "恢复后一次写入把内存态两条都补上 (全量原子写, 不存在半截文件)");
  } finally {
    fs.renameSync = realRename;
    console.log = realLog;
    rmrf(dir);
  }
});

// ===========================================================================
// 窗口 6: search() 的 hit 计数是"改盘上那条", 不是改副本
// ===========================================================================
test("F3: search() 命中计数写回磁盘, 且带上另一进程的变更后再写 (不是副本自增)", () => {
  const dir = tmp("f3-hit");
  try {
    const a = new FailureEpisodeStore(dir);
    const e = a.record({ tool: "web_fetch", error: "429 Too Many Requests 限流", category: "throttle" });
    const b = new FailureEpisodeStore(dir);
    b.record({ tool: "web_fetch", error: "429 Too Many Requests 限流(另一进程)", category: "throttle" });
    const hitIds = a.search({ tool: "web_fetch", error: "429 限流", limit: 3 }).map((x) => x.id);
    assert.ok(hitIds.includes(e.id), "检索命中历史病历");
    const onDisk = readJson(feFile(dir));
    assert.equal(onDisk.length, 2, "hit 写回没抹掉另一进程的病历");
    assert.equal(onDisk.find((x) => x.id === e.id).hit, 1, "hit 落在盘上");
    const other = onDisk.find((x) => x.id !== e.id);
    assert.equal(other.hit, 1, "同批命中的另一条也写回 (不是只改副本)");
    assert.ok(a.stats().totalHits >= 1, "统计读到写回的计数");
  } finally { rmrf(dir); }
});
