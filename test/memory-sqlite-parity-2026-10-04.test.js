// test/memory-sqlite-parity-2026-10-04.test.js — sqlite 后端与 JSON 后端行为对齐 (P2#sqlite-parity)
// 覆盖四个阻断缺陷:
//   P1 validFrom/validTo 时效窗口列 (含旧库 ALTER TABLE 迁移路径) + sweepExpired 软归档同口径
//   P2 exportAll 形状统一为 { items } (fact-store.js 口径), 且导出物可被另一后端 importAll 回灌
//   P3 后端切换一次性迁移 (json→sqlite 与 sqlite→json, 保留 id/status/窗口/版本链)
//   P4 meta 半写入/手改损坏不再炸掉整库加载
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { FactStore } from "../src/memory/fact-store.js";
import { SqliteFactStore } from "../src/memory/sqlite-store.js";

// node:sqlite 是实验特性 (Node >= 22.5): 不可用时整组用例跳过 (同 advanced.tools 的 NET 约定)
const require2 = createRequire(import.meta.url);
let HAS_SQLITE = false;
try {
  const { DatabaseSync } = require2("node:sqlite");
  const probe = new DatabaseSync(":memory:");
  probe.exec("CREATE TABLE t(x)");
  probe.close();
  HAS_SQLITE = true;
} catch { /* 不可用 → skip */ }
const SQL = () => (HAS_SQLITE ? false : "node:sqlite 不可用, 跳过 SQLite 后端测试");

function tmp(name = "sqlite-parity") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${name}-`));
}

// ---- P1 时效窗口: 写入/读取/重开库 round-trip + 检索过滤 ----
test("P1 validFrom/validTo: add 落库、_row2fact 回读、重开库仍在", { skip: SQL() }, () => {
  const dir = tmp("window");
  const from = new Date(Date.now() - 60000).toISOString();
  const to = new Date(Date.now() + 86400000).toISOString();
  const store = new SqliteFactStore(dir);
  const f = store.add("会议室在三楼东侧", { validFrom: from, validTo: to });
  assert.equal(f.validFrom, from);
  assert.equal(f.validTo, to);
  const reopened = new SqliteFactStore(dir);
  const got = reopened.list().find((x) => x.id === f.id);
  assert.equal(got.validFrom, from, "validFrom 必须持久化 (列 + 迁移)");
  assert.equal(got.validTo, to, "validTo 必须持久化 (列 + 迁移)");
  reopened.close();
  store.close();
});

test("P1 时效窗口: 已失效/未生效不命中, includeExpired/listOutOfWindow/setValidity 同 JSON 口径", { skip: SQL() }, () => {
  const store = new SqliteFactStore(tmp("window2"));
  const f = store.add("部署命令是 npm run deploy");
  assert.equal(store.query("部署").length, 1, "无窗口 = 永久有效");
  store.setValidity(f.id, { validTo: new Date(Date.now() - 1000) });
  assert.equal(store.query("部署").length, 0, "已失效不应命中 (与 fact-store.js 同口径)");
  assert.equal(store.query("部署", { includeExpired: true }).length, 1, "includeExpired 供治理检视");
  assert.ok(store.listOutOfWindow().some((x) => x.id === f.id));
  assert.equal(store.list().some((x) => x.status === "active"), true, "时效不改 status (只影响可见性)");
  store.setValidity(f.id, { validTo: null });
  assert.equal(store.query("部署").length, 1, "setValidity 可重新开放");
  store.setValidity(f.id, { validFrom: new Date(Date.now() + 86400000) });
  assert.equal(store.query("部署").length, 0, "尚未生效不应命中");
  store.close();
});

test("P1 旧库升级路径: 缺 valid_from/valid_to 列的存量 db 经 ALTER TABLE 补列后可用", { skip: SQL() }, () => {
  const dir = tmp("oldschema");
  const memDir = path.join(dir, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  const { DatabaseSync } = require2("node:sqlite");
  const db = new DatabaseSync(path.join(memDir, "facts.db"));
  // 迁移前的旧 schema: 没有 valid_from/valid_to
  db.exec(`CREATE TABLE facts (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, norm_key TEXT, toks TEXT,
    type TEXT DEFAULT 'general', source TEXT DEFAULT 'manual',
    importance REAL DEFAULT 10, score REAL DEFAULT 10, created INTEGER, last_access INTEGER,
    hits INTEGER DEFAULT 0, scope TEXT, layer INTEGER DEFAULT 1, status TEXT DEFAULT 'active',
    prev_id TEXT, superseded_by TEXT, deleted_reason TEXT, deleted_at INTEGER, ttl_days INTEGER, meta TEXT
  )`);
  db.prepare("INSERT INTO facts(id,content,norm_key,toks,created,last_access,importance,score) VALUES(?,?,?,?,?,?,?,?)")
    .run("f_legacy_row", "旧库里的事实", "旧库里的事实", "旧 库 里 的 事 实", Date.now() - 5000, Date.now() - 5000, 10, 10);
  db.close();

  const store = new SqliteFactStore(dir);
  const cols = new Set(store.db.prepare("PRAGMA table_info(facts)").all().map((c) => c.name));
  assert.ok(cols.has("valid_from") && cols.has("valid_to"), "打开时必须补列");
  const legacy = store.list().find((x) => x.id === "f_legacy_row");
  assert.ok(legacy, "旧行可读");
  assert.equal(legacy.validFrom, null, "旧行窗口为空而非崩溃");
  const r = store.setValidity("f_legacy_row", { validTo: new Date(Date.now() - 1).toISOString() });
  assert.ok(r.validTo, "补列后可参与 TTL 时效治理");
  assert.equal(store.query("旧库").length, 0, "窗口过滤对旧行生效");
  store.close();
});

test("P1 sweepExpired: 逐条 ttlDays 优先、软归档可 restore、返回形状对齐 { swept, ids, dryRun }", { skip: SQL() }, () => {
  const store = new SqliteFactStore(tmp("sweep"));
  const short = store.add("七天临时情报", { ttlDays: 7 });
  assert.equal(short.ttlDays, 7, "ttlDays 必须回读 (fact-store.js 同口径)");
  const normal = store.add("长期有效事实");
  assert.equal(short.validTo, null);
  // 两条都倒拨 30 天未访问
  const old = Date.now() - 30 * 86400000;
  store.db.prepare("UPDATE facts SET last_access = ? WHERE id = ?").run(old, short.id);
  store.db.prepare("UPDATE facts SET last_access = ? WHERE id = ?").run(old, normal.id);

  const dry = store.sweepExpired({ ttlDays: 90, dryRun: true });
  assert.equal(dry.swept, 1, "dryRun 只报告: 逐条 ttlDays=7 的先到期");
  assert.equal(dry.dryRun, true);
  const r = store.sweepExpired({ ttlDays: 90 });
  assert.equal(r.swept, 1, "全局 90 天未到的普通事实不受影响, 条目自带 ttlDays 覆盖之");
  assert.deepEqual(r.ids, [short.id]);
  assert.equal("count" in r, false, "返回形状与 fact-store.js 一致 (agent sweepMemoryTtl 读 r.swept)");
  assert.equal(store.deletedList().some((f) => f.id === short.id), true);
  assert.ok(/TTL 90 天未访问自动归档/.test(store.deletedList()[0].deleteReason), "deleteReason 字段名与 JSON 后端一致");
  const back = store.restore(short.id);
  assert.equal(back.status, "active", "软归档可回滚");
  assert.equal(store.query("七天").length, 1);
  store.close();
});

// ---- P2 exportAll 形状 ----
test("P2 exportAll: sqlite 与 JSON 后端同返回形状 { version, exportedAt, count, items }", { skip: SQL() }, () => {
  const js = new FactStore(tmp("shape-json"));
  const sq = new SqliteFactStore(tmp("shape-sqlite"));
  js.add("形状基准事实");
  sq.add("形状对齐事实");
  const jd = js.exportAll();
  const sd = sq.exportAll();
  assert.ok(Array.isArray(jd.items), "JSON 后端以 items 为准 (test/memory-governance 已断言)");
  assert.deepEqual(Object.keys(sd).sort(), Object.keys(jd).sort(), "键集合完全一致");
  assert.equal("facts" in sd, false, "sqlite 不再返回 facts 键");
  // 交叉回灌: 任一端导出物都能被另一端 importAll 接受 (governance memory_export/import 工具链)
  const inSqlite = sq.importAll(jd, { mode: "merge" });
  assert.equal(inSqlite.ok, true);
  assert.equal(inSqlite.imported, 1);
  const inJson = js.importAll(sd, { mode: "merge" });
  assert.equal(inJson.ok, true, "sqlite 导出物可被 JSON 后端导入");
  assert.equal(inJson.imported, 1);
  assert.equal(js.importAll({ nope: 1 }).ok, false, "非法格式拒绝 (同 JSON 后端)");
  sq.close();
});

// ---- P3 后端切换迁移: json → sqlite ----
test("P3 切换 json→sqlite: 空 sqlite 首用时一次性导入 facts.json, 保留 id/status/版本链/TTL 窗口", { skip: SQL() }, () => {
  const dir = tmp("mig-j2s");
  const js = new FactStore(dir);
  const keep = js.add("用户偏好深色主题", { importance: 12 });
  const ttl = js.add("周报临时备忘", { ttlDays: 3, validTo: new Date(Date.now() + 86400000).toISOString() });
  const gone = js.add("将被遗忘的事实");
  js.forget(gone.id, { reason: "误记" });
  const evolving = js.add("生产地址是 A 机房");
  js.update(evolving.id, "生产地址是 B 机房"); // 旧版转 archived
  const expected = js.exportAll();
  assert.ok(expected.items.some((f) => f.status === "archived"), "前置: JSON 侧已产生 archived");

  const sq = new SqliteFactStore(dir); // 构造即触发一次性导入
  assert.equal(sq.count(), expected.count, `迁移后条数一致 (期望 ${expected.count}, 实得 ${sq.count()})`);
  const migrated = sq.exportAll();
  for (const f of expected.items) {
    const got = migrated.items.find((x) => x.id === f.id);
    assert.ok(got, `id 保留: ${f.id}`);
    assert.equal(got.status, f.status, `status 保留 (${f.content})`);
    assert.equal(got.scope ?? null, f.scope ?? null);
    assert.equal(got.created, f.created, "时间戳保留");
  }
  const gotTtl = migrated.items.find((x) => x.id === ttl.id);
  assert.equal(gotTtl.ttlDays, 3);
  assert.equal(gotTtl.validTo, expected.items.find((x) => x.id === ttl.id).validTo, "TTL 窗口随迁移保留");
  assert.ok(migrated.items.find((x) => x.id === gone.id).deleteReason === "误记");

  // 目标非空绝不重复导入/覆盖
  sq.add("迁移后的新事实", { dedupe: false });
  const again = new SqliteFactStore(dir);
  assert.equal(again.count(), sq.count(), "非空目标: 二次打开不重复导入");
  again.close();
  sq.close();
});

// ---- P3 后端切换迁移: sqlite → json (切回默认后端) ----
test("P3 切回 json: 空 JSON 首用时从 facts.db 导入, 软删/归档状态与 id 保留", { skip: SQL() }, () => {
  const dir = tmp("mig-s2j");
  const sq = new SqliteFactStore(dir);
  const a = sq.add("SQLite 侧长期事实");
  const b = sq.add("SQLite 侧待遗忘事实", { importance: 1 });
  sq.forget(b.id, { reason: "切换前软删" });
  const dumpBefore = sq.exportAll();
  sq.close(); // WAL checkpoint, 保证落盘

  const js = new FactStore(dir);
  assert.equal(js.count(), dumpBefore.count, "条数一致");
  const byId = new Map(js.facts.map((f) => [f.id, f]));
  assert.ok(byId.has(a.id), "id 保留");
  assert.equal(byId.get(b.id).status, "deleted", "软删状态保留");
  assert.equal(byId.get(b.id).deleteReason, "切换前软删");
  assert.equal(byId.get(a.id).created, dumpBefore.items.find((x) => x.id === a.id).created, "时间戳保留");
  // 目标非空 (JSON 已有自己的数据) → 不重复导入
  const dir2 = tmp("mig-s2j-nonempty");
  const js2 = new FactStore(dir2);
  js2.add("JSON 侧已有的事实");
  fs.copyFileSync(path.join(dir, "memory", "facts.db"), path.join(js2.dir, "facts.db"));
  const js3 = new FactStore(dir2);
  assert.equal(js3.count(), 1, "非空目标不被迁移覆盖");
});

// ---- P4 损坏 meta ----
test("P4 meta 半写入/手改: 加载不抛错, 坏 meta 视为空, 行其余字段保留", { skip: SQL() }, () => {
  const store = new SqliteFactStore(tmp("meta"));
  const good = store.add("带元数据的事实", { meta: { team: "ppx" } });
  assert.deepEqual(store.list().find((f) => f.id === good.id).meta, { team: "ppx" });
  // 模拟半写入/手工编辑出的非法 JSON
  store.db.prepare("UPDATE facts SET meta = ? WHERE id = ?").run('{"team": 半写入', good.id);
  const row = store.list().find((f) => f.id === good.id);
  assert.ok(row, "行仍在");
  assert.equal(row.meta, null, "坏 meta 视为空");
  assert.equal(row.content, "带元数据的事实", "其余字段不丢");
  assert.doesNotThrow(() => store.query("元数据"), "检索路径不炸");
  assert.doesNotThrow(() => store.exportAll(), "导出路径不炸");
  assert.doesNotThrow(() => store.deletedList(), "治理列表不炸");
  store.close();
});

// ---- P5 单点脱密 parity (安全缺口): sqlite 后端不得重开凭证泄漏口 ----
// 与 fact-store.js 的 P0 决策对齐: 记忆会逐轮回注 system prompt、还会被导出, api_key 一旦原样入库
// 即等于外泄。keep email/phone (用户主动要求记住的联系方式是正常用途), 其余凭证一律 [REDACTED]。
// 注意: 两端均无 get(id) 方法, 读回走 add 返回值 + query/list (与既有测试口径一致)。
const SECRET_TEXT = "我的API密钥 sk-abcdefghij0123456789ABCDEF 手机 13800138000";

test("P5 sqlite add(): api_key 脱敏、phone 保留, query/list 读回均为已脱敏文本", { skip: SQL() }, () => {
  const store = new SqliteFactStore(tmp("scrub-add"));
  const f = store.add(SECRET_TEXT);
  assert.ok(f, "事实应入库");
  assert.ok(!f.content.includes("sk-abcdefghij0123456789ABCDEF"), "api_key 不得原样返回");
  assert.ok(f.content.includes("[REDACTED]"), "凭证替换为 [REDACTED]");
  assert.ok(f.content.includes("13800138000"), "手机号按 keep 保留 (非泄漏)");
  // 检索/列表读回同样已脱敏
  const q = store.query("API密钥");
  assert.equal(q.length, 1, "脱敏后仍可命中检索");
  assert.ok(!q[0].content.includes("sk-abcdefghij0123456789ABCDEF"));
  const listed = store.list().find((x) => x.id === f.id);
  assert.ok(!listed.content.includes("sk-abcdefghij0123456789ABCDEF"), "list 读回亦脱敏");
  // 持久化到 db 的行本身不含明文密钥 (重开库验证落盘即脱敏)
  store.close();
  const reopened = new SqliteFactStore(path.join(store.dir, ".."));
  const raw = reopened.db.prepare("SELECT content FROM facts WHERE id = ?").get(f.id);
  assert.ok(raw && !raw.content.includes("sk-abcdefghij0123456789ABCDEF"), "落盘内容即已脱敏");
  reopened.close();
});

test("P5 parity: 同一输入经 JSON 与 sqlite 后端得到逐字相同的存储内容", { skip: SQL() }, () => {
  const js = new FactStore(tmp("scrub-json"));
  const sq = new SqliteFactStore(tmp("scrub-sqlite"));
  const jf = js.add(SECRET_TEXT);
  const sf = sq.add(SECRET_TEXT);
  assert.equal(sf.content, jf.content, "两端存储文本必须完全一致 (scrub→norm 同序同参)");
  // update 同口径
  const upd = "换成新密钥 sk-ZZYYYYYYYYYYYYYYYYYYYY 邮箱保留 me@example.com";
  const ju = js.update(jf.id, upd);
  const su = sq.update(sf.id, { content: upd });
  assert.equal(su.content, ju.content, "update 后两端仍逐字一致");
  sq.close();
});

test("P5 sqlite update() 同样脱敏 (api_key 抹除 / phone 保留)", { skip: SQL() }, () => {
  const store = new SqliteFactStore(tmp("scrub-update"));
  const f = store.add("初始无敏感信息的事实");
  const u = store.update(f.id, { content: "更新带上 sk-abcdefghij0123456789ABCDEF 和 13912345678" });
  assert.ok(u, "update 应返回新条");
  assert.ok(!u.content.includes("sk-abcdefghij0123456789ABCDEF"), "update 路径必须脱 api_key");
  assert.ok(u.content.includes("[REDACTED]"));
  assert.ok(u.content.includes("13912345678"), "update 保留 phone (keep 口径)");
  store.close();
});
