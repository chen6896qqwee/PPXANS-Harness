// test/selfcode.test.js — 自改代码闭环回归 (2026-10-27)
//
// 用临时夹具工程验证七条不变量, 全程零 LLM、不碰主工程文件:
//   1) propose 只出 diff, 一个字节都不落盘
//   2) apply 绿 → 保留 + 账本 kept + pending-reload 记账
//   3) apply 红 (测试失败) → 整体回滚, 源码逐字复原 + 账本 rolled_back
//   4) apply 红 (语法错) → 同样回滚, 且不跑测试 (不浪费两分钟换一个误导性结论)
//   5) 路径逃逸 / 禁区 (node_modules) / 测试文件保护 一律拒
//   6) rewind 按账本把改过的文件退回改动前
//   7) 工具面: apply 需 config 双门 + riskLevel=high
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SelfCodeEngine, compactDiff } from "../src/selfcode/index.js";
import { guardPath } from "../src/selfcode/verify.js";
import { registerSelfCodeTools } from "../src/tools/selfcode.js";
import { ToolCatalog } from "../src/tools/catalog.js";

const BROKEN_SRC = "export function add(a, b) { return a - b; }\n";
const FIXTURE_IMPORT = 'import { add } from "../src/' + 'math.js";';
const TEST_JS = [
  'import { test } from "node:test";',
  'import assert from "node:assert";',
  FIXTURE_IMPORT,
  'test("add(1,2) 应为 3", () => { assert.equal(add(1, 2), 3); });',
  "",
].join("\n");

function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-selfcode-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "math.js"), BROKEN_SRC);
  fs.writeFileSync(path.join(root, "test", "math.test.js"), TEST_JS);
  return root;
}

// 正确补丁: 把 - 改成 +
const GOOD_PATCH = [
  "src/math.js",
  "<<<<<<< SEARCH",
  "return a - b;",
  "=======",
  "return a + b;",
  ">>>>>>> REPLACE",
  "",
].join("\n");

// 语义错但语法合法的补丁: 测试仍然红
const STILL_BROKEN_PATCH = [
  "src/math.js",
  "<<<<<<< SEARCH",
  "return a - b;",
  "=======",
  "return a * b;",
  ">>>>>>> REPLACE",
  "",
].join("\n");

// 语法错补丁: 括号没闭 (错误必须落在 REPLACE 内容里 —— 块外的文字会被解析器当噪声丢弃)
const SYNTAX_BROKEN_PATCH = [
  "src/math.js",
  "<<<<<<< SEARCH",
  "return a - b;",
  "=======",
  "return (a + b;",
  ">>>>>>> REPLACE",
  "",
].join("\n");

test("compactDiff: 统计增删行并给预览", () => {
  const d = compactDiff("a\nb\nc\n", "a\nB\nc\nd\n");
  assert.equal(d.linesBefore, 4);
  assert.equal(d.linesAfter, 5);
  assert.ok(d.added >= 2, "至少新增 B 与 d");
  assert.ok(d.removed >= 1, "至少删除 b");
});

test("guardPath: 拒绝逃逸 / node_modules / 不支持扩展名", () => {
  const root = path.resolve(os.tmpdir(), "ppx-guard-root");
  assert.equal(guardPath(root, "../evil.js").ok, false);
  assert.equal(guardPath(root, "node_modules/x/index.js").ok, false);
  assert.equal(guardPath(root, "src/x.exe").ok, false);
  assert.equal(guardPath(root, "src/ok.js").ok, true);
});

test("guardPath: 默认拒绝改测试文件, allowTestEdit 才放行", () => {
  const root = path.resolve(os.tmpdir(), "ppx-guard-root2");
  const rel = "test/a.test.js";
  assert.equal(guardPath(root, rel, { testFiles: [rel] }).ok, false);
  assert.equal(guardPath(root, rel, { testFiles: [rel], allowTestEdit: true }).ok, true);
});

test("propose: 只出 diff, 磁盘零改动", async () => {
  const root = mkFixture();
  try {
    const eng = new SelfCodeEngine({ root, dataDir: path.join(root, "data") });
    const r = await eng.run({ patch: GOOD_PATCH, tests: ["test/math.test.js"] });
    assert.equal(r.ok, true);
    assert.equal(r.stage, "propose");
    assert.equal(r.applied, false);
    assert.equal(fs.readFileSync(path.join(root, "src", "math.js"), "utf8"), BROKEN_SRC, "propose 不许动盘");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply 绿: 落盘 + 测试通过 + 账本 kept + pending-reload 记账", { timeout: 60000 }, async () => {
  const root = mkFixture();
  try {
    const eng = new SelfCodeEngine({ root, dataDir: path.join(root, "data"), mode: "apply" });
    const r = await eng.run({ patch: GOOD_PATCH, tests: ["test/math.test.js"], reason: "修 add 的减号 bug" });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
    assert.equal(r.stage, "kept");
    assert.match(fs.readFileSync(path.join(root, "src", "math.js"), "utf8"), /a \+ b/);
    assert.equal(r.reloadRequired.length, 1, "改了源码就该有 pending 清单");
    const rows = eng.ledger.all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "kept");
    assert.equal(rows[0].reason, "修 add 的减号 bug");
    assert.equal(eng.ledger.readPending().files.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply 红 (测试失败): 整体回滚, 源码逐字复原", { timeout: 60000 }, async () => {
  const root = mkFixture();
  try {
    const eng = new SelfCodeEngine({ root, dataDir: path.join(root, "data"), mode: "apply" });
    const r = await eng.run({ patch: STILL_BROKEN_PATCH, tests: ["test/math.test.js"] });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "verify");
    assert.equal(r.rolledBack, true);
    assert.equal(fs.readFileSync(path.join(root, "src", "math.js"), "utf8"), BROKEN_SRC, "红必须回滚到逐字原样");
    const rows = eng.ledger.all();
    assert.equal(rows[0].status, "rolled_back");
    assert.deepEqual(eng.ledger.readPending().files, [], "回滚后不该留 pending");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply 红 (语法错): 停在语法关, 不跑测试, 已回滚", { timeout: 60000 }, async () => {
  const root = mkFixture();
  try {
    const eng = new SelfCodeEngine({ root, dataDir: path.join(root, "data"), mode: "apply" });
    const r = await eng.run({ patch: SYNTAX_BROKEN_PATCH, tests: ["test/math.test.js"] });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "verify");
    assert.match(String(r.summary), /语法未通过/);
    assert.equal(r.tests, null, "语法不过就不该跑测试");
    assert.equal(fs.readFileSync(path.join(root, "src", "math.js"), "utf8"), BROKEN_SRC);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("补丁不匹配: 整批不落盘 (多块原子)", async () => {
  const root = mkFixture();
  try {
    const eng = new SelfCodeEngine({ root, dataDir: path.join(root, "data"), mode: "apply" });
    const bad = [
      "src/math.js",
      "<<<<<<< SEARCH",
      "return a - b;",
      "=======",
      "return a + b;",
      ">>>>>>> REPLACE",
      "",
      "src/math.js",
      "<<<<<<< SEARCH",
      "这一行根本不存在",
      "=======",
      "换掉",
      ">>>>>>> REPLACE",
      "",
    ].join("\n");
    const r = await eng.run({ patch: bad });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "plan");
    assert.equal(fs.readFileSync(path.join(root, "src", "math.js"), "utf8"), BROKEN_SRC, "有一块不匹配就一个字节都不写");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rewind: 按账本把改过的文件退回改动前", { timeout: 60000 }, async () => {
  const root = mkFixture();
  try {
    const eng = new SelfCodeEngine({ root, dataDir: path.join(root, "data"), mode: "apply" });
    const r = await eng.run({ patch: GOOD_PATCH, tests: ["test/math.test.js"] });
    assert.equal(r.ok, true);
    assert.match(fs.readFileSync(path.join(root, "src", "math.js"), "utf8"), /a \+ b/);
    const w = eng.rewind({ id: r.ledgerId });
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(fs.readFileSync(path.join(root, "src", "math.js"), "utf8"), BROKEN_SRC, "rewind 必须回到原始 bug 版本");
    assert.equal(eng.ledger.all().at(-1).status, "rewound");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("工具面: apply 需 config 双门, 未开时拒绝且不动盘", async () => {
  const catalog = new ToolCatalog();
  const root = mkFixture();
  try {
    const agent = { root, dataDir: path.join(root, "data"), config: { agent: {} } };
    registerSelfCodeTools(catalog, { agent });
    const names = catalog.list();
    for (const n of ["self_edit", "self_verify", "self_rewind"]) {
      assert.ok(names.includes(n), `缺少工具 ${n}`);
    }
    const out = await catalog.call("self_edit", { patch: GOOD_PATCH, mode: "apply" }, {});
    assert.match(String(out), /双门|显式开启/, "config 未开 apply 时必须拒绝");
    assert.equal(fs.readFileSync(path.join(root, "src", "math.js"), "utf8"), BROKEN_SRC, "被拒的调用不许落盘");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("工具面: 自改是高危能力 (riskLevel=high), 只读复核是 medium", () => {
  const catalog = new ToolCatalog();
  registerSelfCodeTools(catalog, { agent: { root: "/tmp/x", config: {} } });
  assert.equal(catalog.getCapability("self_edit")?.riskLevel, "high");
  assert.equal(catalog.getCapability("self_rewind")?.riskLevel, "high");
  assert.equal(catalog.getCapability("self_verify")?.riskLevel, "medium");
  assert.equal(catalog.getCapability("self_verify")?.readOnly, true);
});

test("账本报告: 空账本也给结构化输出", () => {
  const root = mkFixture();
  try {
    const eng = new SelfCodeEngine({ root, dataDir: path.join(root, "data") });
    const j = eng.status({ limit: 5 });
    assert.equal(j.total, 0);
    assert.deepEqual(j.pendingReload, []);
    assert.deepEqual(j.recent, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
