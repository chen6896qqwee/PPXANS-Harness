// test/fact-tombstone-purge-2026-10-04.test.js — F4: 墓碑 (软删/归档) 必须被物理回收
// 钉住的不变量:
//   1) facts.json 的行数与"活跃量"同阶有界: 此前软删/归档只打标不回收, 唯一硬删入口是
//      clearLayer(hard) —— add() 的锁内 _reload() 要为每一行读盘+重建索引, 于是
//      "遗忘越勤, 文件越大, 每次操作越贵" (实测 600 次 add+forget 后 live=0 而盘上 600 行/287KB)。
//   2) 单条操作扫过的行数有上界 (结构判据, 与墙钟无关): 每次 op 的行数 ≤ maxFacts × (TOMBSTONE_FACTOR+1)。
//   3) 墓碑不进倒排索引: 索引规模只由活跃集决定。
//   4) 年龄回收挂在**已有的**每日时效扫描 (sweepExpired, 即 eviction-daily 的入口) 里, 不新起定时器;
//      保留期内 (purgeGraceDays) 的最近删除仍可 restore/审计; dryRun 只报不动盘。
//   5) 版本链语义不被顺手改坏: archived 旧版走"TTL 软删 -> 保留期 -> 物理清理"同一条流水线;
//      validFrom/validTo 窗口永远不是回收判据 (只管检索可见性)。
//   6) count() (行数) 与 countLive() (还能用的条数) 分开, stats() 两个都报。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactStore } from "../src/memory/fact-store.js";

function tmp(name = "f4") { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${name}-`)); }
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ } }
const factsFile = (dir) => path.join(dir, "memory", "facts.json");
const rowsOf = (dir) => JSON.parse(fs.readFileSync(factsFile(dir), "utf8"));
const agoISO = (days) => new Date(Date.now() - days * 86400000).toISOString();

// 把某些行的删除/归档时钟回溯到过去 (模拟"墓碑已经躺了 N 天"), 直接改盘: 扫描在锁内重读, 会看到
function backdate(dir, ids, days, field = "deletedAt") {
  const rows = rowsOf(dir);
  for (const f of rows) if (ids.includes(f.id)) f[field] = agoISO(days);
  fs.writeFileSync(factsFile(dir), JSON.stringify(rows, null, 2), "utf8");
  return rows;
}

// WAL 模式的同一件事必须走 store 自己的落盘通道: 直接改 facts.json 会被 WAL 里的 upsert 事件盖回去
// (锁内重读 = 磁盘快照 + 重放增量), 所以先 flush 把 WAL 清掉再回溯
function backdateWal(store, dir, ids, days, field = "deletedAt") {
  store.flush();
  for (const id of ids) {
    const f = store.facts.find((x) => x.id === id);
    if (f) f[field] = agoISO(days);
  }
  store.save();
}

// 一次"记住 -> 遗忘"的风暴: n 条事实全部软删, 活跃集清空
function storm(store, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const f = store.add(`风暴事实编号 ${i} 关于阈值与重试策略`, { importance: 6, source: "bench" });
    ids.push(f.id);
    store.forget(f.id, { reason: "bench" });
  }
  return ids;
}

// 采样每个 op 在锁内重读后"扫过的行数" (结构判据: 单条操作的工作量)
function sampler(store) {
  const seen = [];
  const real = store._reload.bind(store);
  store._reload = () => { const r = real(); seen.push(store.facts.length); return r; };
  return seen;
}

const CAP = (maxFacts) => maxFacts * (FactStore.TOMBSTONE_FACTOR + 1); // 总行数上界

// ===========================================================================
// 1) 风暴后的行数界
// ===========================================================================
test("F4: 600 次 add+forget 风暴后行数有界 ≤ maxFacts×(K+1), 而不是等于累计遗忘次数", () => {
  const dir = tmp("storm");
  try {
    const n = 600, maxFacts = 50;
    const st = new FactStore(dir, { maxFacts });
    storm(st, n);
    const rows = st.count();
    assert.equal(st.countLive(), 0, "全部已遗忘 (活跃集为空)");
    assert.ok(rows <= CAP(maxFacts),
      `行数必须有界: 期望 ≤ ${CAP(maxFacts)} (maxFacts ${maxFacts} × K+1), 实到 ${rows}`);
    assert.ok(rows < n / 2, `行数应远小于累计遗忘数 ${n}, 实到 ${rows}`);
    const bytes = fs.statSync(factsFile(dir)).size;
    assert.ok(bytes > 0);

    // 对照: 关掉两个上限 (旧语义) 同样的风暴就是纯线性膨胀 —— 证明上界来自新机制而非样本巧合
    const dir2 = tmp("storm-legacy");
    const old = new FactStore(dir2, { maxFacts: 0, purgeGraceDays: 0, maxTombstones: 0 });
    storm(old, n);
    assert.equal(old.count(), n, `不设上限时累计 ${n} 行全留在盘上 (旧形状)`);
    assert.ok(bytes < fs.statSync(factsFile(dir2)).size, "有界后的文件明显小于无界");
    assert.equal(rows, st.stats().rows);
  } finally { rmrf(dir); }
});

test("F4: 每个 op 扫过的行数有上界 (结构判据, 不测墙钟); 无界时随累计操作线性上涨", () => {
  const dir = tmp("opercost");
  const dir2 = tmp("opercost-legacy");
  try {
    const n = 300, maxFacts = 50;
    const st = new FactStore(dir, { maxFacts });
    const seen = sampler(st);
    storm(st, n);
    const p1max = Math.max(...seen);
    storm(st, n);                       // 第二阶段: 同样规模再来一遍
    const p2max = Math.max(...seen.slice(n * 2));

    const other = new FactStore(dir2, { maxFacts: 0, purgeGraceDays: 0, maxTombstones: 0 });
    const legacy = sampler(other);
    storm(other, n);
    const l1max = Math.max(...legacy);
    storm(other, n);
    const l2max = Math.max(...legacy.slice(n * 2));

    // 有界: 单 op 的行数量与"累计遗忘了多少"无关 —— 第二阶段不得比第一阶段更贵
    assert.ok(p2max <= CAP(maxFacts), `第二阶段单 op 最多扫 ${p2max} 行, 上界 ${CAP(maxFacts)}`);
    assert.ok(p2max <= p1max + 1, `单 op 成本不随历史增长 (第一阶段 ${p1max} 行 -> 第二阶段 ${p2max} 行)`);
    // 旧形状: 再忘一批, 每个 op 就更贵一倍 (Θ(总历史行数) = Θ(累计遗忘数))
    assert.equal(l1max, n, `旧形状第一阶段末: 单 op 要为 ${n} 行重建索引`);
    assert.equal(l2max, n * 2, `旧形状第二阶段末: 涨到 ${l2max} 行`);
    assert.ok(l2max >= p2max * 2, `同一批操作下旧形状比有界贵 ${Math.round(l2max / p2max)} 倍`);
  } finally { rmrf(dir); rmrf(dir2); }
});

test("F4: 墓碑不进倒排索引 —— 索引规模只由活跃集决定", () => {
  const dir = tmp("index");
  try {
    const st = new FactStore(dir, { maxFacts: 1000 });
    const ids = [];
    for (let i = 0; i < 40; i++) ids.push(st.add(`阈值 ${i} 的重试策略说明`, { importance: 5 }).id);
    assert.ok(st._index.size > 0, "活跃时索引非空");
    for (const id of ids) st.forget(id);
    st.rebuildIndex();
    assert.equal(st._index.size, 0, "全部软删后索引里一个 key 都不该留下");
    assert.equal(st.count(), 40, "行仍是 40 条 (可回滚, 只是不进索引)");
    // 混合: 索引中的 id 必须全部是活跃行的 id
    const keep = st.add("这条留下", { importance: 8 });
    const inIndex = new Set();
    for (const set of st._index.values()) for (const id of set) inIndex.add(id);
    const live = new Set(st._live().map((f) => f.id));
    assert.ok([...inIndex].every((id) => live.has(id)), "索引中不存在墓碑 id");
    assert.ok(inIndex.has(keep.id), "活跃事实照常进索引");
  } finally { rmrf(dir); }
});

// ===========================================================================
// 2) 年龄回收: 在既有的每日时效扫描里
// ===========================================================================
test("F4: sweepExpired 同一次扫描内物理回收超过保留期的墓碑, 保留期内的最近删除仍可 restore", () => {
  const dir = tmp("age");
  try {
    const st = new FactStore(dir, { maxFacts: 1000, purgeGraceDays: 30 });
    const old1 = st.add("很久以前被遗忘的旧事 A", { importance: 5 });
    const old2 = st.add("很久以前被遗忘的旧事 B", { importance: 5 });
    const fresh = st.add("刚刚被遗忘, 还在审计窗口", { importance: 5 });
    const live = st.add("活跃事实, 不该被动", { importance: 9 });
    st.forget(old1.id); st.forget(old2.id); st.forget(fresh.id);
    backdate(dir, [old1.id, old2.id], 60);

    const r = st.sweepExpired({ ttlDays: 90 });
    assert.equal(r.purged, 2, `两条超过 30 天保留期的墓碑应回收, 实到 ${r.purged}`);
    assert.deepEqual(r.purgedIds.sort(), [old1.id, old2.id].sort());
    assert.equal(st.count(), 2, "行数: 剩 fresh 墓碑 + live 活跃行");
    assert.ok(st.deletedList().some((f) => f.id === fresh.id), "最近删除留在窗口内 (可审计)");
    const restored = st.restore(fresh.id);
    assert.equal(restored.status, "active", "保留期内的墓碑可回滚");
    assert.equal(st.countLive(), 2, "恢复后活跃 2 条");
    assert.equal(st.countLive(), st._live().length);
    assert.ok(st._live().some((f) => f.id === live.id), "活跃事实没被回收顺带伤到");
    // 再跑一次: 已无过期墓碑 (幂等, 不动盘)
    const again = st.sweepExpired({ ttlDays: 90 });
    assert.equal(again.purged, 0, "第二次没有可回收的墓碑");
    assert.equal(again.swept, 0, "回收 ≠ TTL 软归档: 活跃行没被顺手标掉");
  } finally { rmrf(dir); }
});

test("F4: dryRun 只报数不动盘; purgeGraceDays=0 关闭年龄回收 (仍可被行数上限兜底)", () => {
  const dir = tmp("dry");
  try {
    const st = new FactStore(dir, { maxFacts: 1000, purgeGraceDays: 30 });
    const a = st.add("过期墓碑一", { importance: 4 });
    const b = st.add("过期墓碑二", { importance: 4 });
    st.forget(a.id); st.forget(b.id);
    backdate(dir, [a.id, b.id], 45);

    const before = fs.readFileSync(factsFile(dir), "utf8");
    const plan = st.sweepExpired({ ttlDays: 90, dryRun: true });
    assert.equal(plan.purged, 2, "dryRun 报出将要回收的条数");
    assert.deepEqual(plan.purgedIds.sort(), [a.id, b.id].sort());
    assert.equal(fs.readFileSync(factsFile(dir), "utf8"), before, "dryRun 一个字节都不改");

    // 关闭年龄清理: 原样复制到另一份数据, 开关关掉 -> 一行都不动
    const dir2 = tmp("dry-off");
    fs.mkdirSync(path.dirname(factsFile(dir2)), { recursive: true });
    fs.copyFileSync(factsFile(dir), factsFile(dir2));
    const off = new FactStore(dir2, { maxFacts: 1000, purgeGraceDays: 0 });
    const r = off.sweepExpired({ ttlDays: 90 });
    assert.equal(r.purged, 0, "purgeGraceDays=0 时不按年龄物理清理");
    assert.equal(off.count(), 2, "两条过期墓碑仍在");
    assert.equal(off.countLive(), 0);
    // 同一份数据把保留期打开就立刻回收 —— 证明开关真的接在判据上, 不是测试自说自话
    const on = new FactStore(dir2, { maxFacts: 1000, purgeGraceDays: 30 });
    assert.equal(on.sweepExpired({ ttlDays: 90 }).purged, 2, "purgeGraceDays=30 时同样的行被回收");
    assert.equal(on.count(), 0);
    rmrf(dir2);
  } finally { rmrf(dir); }
});

test("F4: 行数上限可由调用方显式配置 (maxTombstones), 与 maxFacts 解耦", () => {
  const dir = tmp("cap");
  try {
    const st = new FactStore(dir, { maxFacts: 0, maxTombstones: 5, purgeGraceDays: 0 });
    storm(st, 40);
    const s = st.stats();
    assert.equal(s.max_tombstones, 5, "显式上限优先");
    // 上限在 add 的裁剪里落到 5; 随后那次 forget 只软删不裁剪 -> 稳态上界是 cap+1
    assert.ok(s.tombstones <= 6, `墓碑行数被压到 5(+最后一次删除 = 6), 实到 ${s.tombstones}`);
    assert.ok(s.tombstones < 40, `40 次遗忘只留下 ${s.tombstones} 行死数据`);
    assert.equal(s.rows, s.tombstones + s.live);
    assert.equal(st.count(), s.rows, "count() 就是行数 (含墓碑)");
    assert.equal(st.countLive(), 0);
    // 保留的是"最近的删除", 最老的先走
    const rest = st.deletedList();
    assert.equal(rest.length, s.tombstones);
    for (let i = 1; i < rest.length; i++) {
      assert.ok(String(rest[i - 1].deletedAt) >= String(rest[i].deletedAt), "deletedList 新→旧");
    }
  } finally { rmrf(dir); }
});

// ===========================================================================
// 3) 版本链 / 有效期窗口语义保持不变
// ===========================================================================
test("F4: update() 的 archived 旧版仍在审计窗口内; 过保留期后回收不影响活跃行的版本链检索", () => {
  const dir = tmp("chain");
  try {
    const st = new FactStore(dir, { maxFacts: 1000, purgeGraceDays: 30 });
    const a = st.add("用户偏好: 深色主题", { importance: 8 });
    const upd = st.update(a.id, "用户偏好: 浅色主题");
    assert.ok(upd.prevId, "活跃行挂着旧版 id");
    const archived = st.facts.find((f) => f.id === upd.prevId);
    assert.equal(archived.status, "archived", "旧版进版本链归档");
    assert.equal(archived.supersededBy, a.id, "反向指针仍在");

    let r = st.sweepExpired({ ttlDays: 90 });
    assert.equal(r.purged, 0, "刚归档的旧版在保留期内, 不会被 TTL 扫描顺手抹掉");
    assert.ok(st.facts.some((f) => f.id === upd.prevId), "版本链旧版仍在盘上");

    backdate(dir, [upd.prevId], 60, "archivedAt");
    // archived 行也在 TTL 射程内 (扫描只排除 status=deleted), 先被软删再走保留期
    r = st.sweepExpired({ ttlDays: 0 });
    assert.ok(r.purged >= 1, `超过保留期的 archived 旧版被回收 (purged=${r.purged})`);
    assert.ok(!st.facts.some((f) => f.id === upd.prevId), "旧版已物理回收");
    assert.equal(st.countLive(), 1, "活跃行一条不少");
    assert.equal(st.facts.find((f) => f.id === a.id).prevId, upd.prevId,
      "活跃行仍记录 prevId (历史指针不因回收而伪造)");
    const hit = st.query("浅色主题", { limit: 3 });
    assert.ok(hit.some((h) => h.id === a.id), "检索照常命中活跃版本");
  } finally { rmrf(dir); }
});

test("F4: validFrom/validTo 窗口不是回收判据 —— 过期窗口的事实只是检索不可见, 行仍在", () => {
  const dir = tmp("window");
  try {
    const st = new FactStore(dir, { maxFacts: 1000, purgeGraceDays: 30 });
    const out = st.add("去年住在北京 (窗口已过期)", { importance: 7, validTo: agoISO(10) });
    const inw = st.add("现在住在上海", { importance: 7 });
    const r = st.sweepExpired({ ttlDays: 90 });
    assert.equal(r.purged, 0, "没有墓碑 = 一行都不物理清理");
    assert.equal(st.count(), 2, "窗口过期的行仍是 active, 不因为 validTo 被抹掉");
    assert.equal(st._isCurrent(st.facts.find((f) => f.id === out.id)), false, "窗口判据仍是检索层的可见性");
    assert.ok(st.listOutOfWindow().some((f) => f.id === out.id), "过期窗口进 out-of-window 清单 (可治理)");
    assert.ok(!st.query("住在北京", { limit: 5 }).some((h) => h.id === out.id), "默认检索不带过期窗口");
    assert.ok(st.query("住在上海", { limit: 5 }).some((h) => h.id === inw.id), "在窗内的照常命中");
  } finally { rmrf(dir); }
});

// ===========================================================================
// 4) 数字诚实 + WAL 重放一致
// ===========================================================================
test("F4: stats() 把行数与活跃数分开报 (count() 是行数, 不是'还能用的条数')", () => {
  const dir = tmp("stats");
  try {
    const st = new FactStore(dir, { maxFacts: 20 });
    const keep = st.add("长期有效的偏好", { importance: 9 });
    for (let i = 0; i < 6; i++) st.forget(st.add(`临时条目 ${i}`, { importance: 3 }).id);
    const s = st.stats();
    assert.equal(s.rows, st.count(), "rows == count() (含墓碑)");
    assert.equal(s.live, st.countLive(), "live == countLive()");
    assert.equal(s.tombstones, s.rows - s.live, "tombstones == 行差");
    assert.equal(s.deleted, 6);
    assert.equal(s.max_tombstones, 20 * FactStore.TOMBSTONE_FACTOR);
    assert.equal(s.purge_grace_days, 30);
    assert.notEqual(st.count(), st.countLive(), "有墓碑时两个数字必须不同 (这就是旧文案的坑)");
    assert.ok(st.query("长期有效", { limit: 3 }).some((h) => h.id === keep.id), "活跃事实仍可检索");
  } finally { rmrf(dir); }
});

test("F4: WAL 模式下回收后重放不复活墓碑 (remove 事件按序压过 upsert)", () => {
  const dir = tmp("wal");
  try {
    const st = new FactStore(dir, { maxFacts: 1000, purgeGraceDays: 30, wal: true });
    const ids = [];
    for (let i = 0; i < 8; i++) { const f = st.add(`WAL 条目 ${i}`, { importance: 4 }); ids.push(f.id); st.forget(f.id); }
    const live = st.add("WAL 活跃条目", { importance: 20 });
    backdateWal(st, dir, ids.slice(0, 5), 60);
    const r = st.sweepExpired({ ttlDays: 3650 });
    assert.equal(r.purged, 5, `WAL 模式同样按年龄回收, 实到 ${r.purged}`);
    st.flush();
    const reopened = new FactStore(dir, { maxFacts: 1000, wal: true });
    assert.equal(reopened.count(), 4, "重开后只剩未过期墓碑 + 活跃行");
    assert.ok(!reopened.facts.some((f) => ids.slice(0, 5).includes(f.id)), "已回收的墓碑没从 WAL 复活");
    assert.equal(reopened.countLive(), 1, "活跃行一条不少");
    assert.ok(reopened.facts.some((f) => f.id === live.id));
    assert.deepEqual(reopened._live().map((f) => f.id), [live.id]);
    // 保留期内的最近删除仍可回滚
    assert.equal(reopened.restore(ids[7]).status, "active", "未过期墓碑仍可 restore");
  } finally { rmrf(dir); }
});

test("F4: 回收后重开实例与盘一致, 且不会把回收当'容量裁剪'误伤活跃行", () => {
  const dir = tmp("reopen");
  try {
    const st = new FactStore(dir, { maxFacts: 30 });
    const live = [];
    for (let i = 0; i < 20; i++) live.push(st.add(`重要活跃事实 ${i}`, { importance: 15 }).id);
    const doomed = [];
    for (let i = 0; i < 90; i++) { const f = st.add(`低价值条目 ${i}`, { importance: 1 }); doomed.push(f.id); st.forget(f.id); }
    backdate(dir, doomed, 90);
    const r = st.sweepExpired({ ttlDays: 365 });
    assert.equal(r.purged, doomed.length, `全部过期墓碑回收 (${r.purged})`);
    const again = new FactStore(dir, { maxFacts: 30 });
    assert.equal(again.countLive(), 20, "20 条重要活跃事实一条不少 (回收 ≠ 容量裁剪)");
    assert.equal(again.count(), 20, "行数 = 活跃数, 墓碑清零");
    assert.equal(again.stats().tombstones, 0);
  } finally { rmrf(dir); }
});
