// test/write-selfcheck-2026-10-05.test.js — 写后自查回执 (2026-10-05 真跑基准 write-function 复盘)
// 病根: 模型 write_file 一个没有任何 export 的 utils.js, 工具只回 ok:true, 它便宣称
// "已写入并导出" —— 确定性校验器 import 拿到 null。修的是回执缺信息, 不是语义:
// write_file / apply_patch 的结果在"JS 文件 + 非空 + 无 export/module.exports"时追加
// 一行条件式 selfcheck; 有导出 / 非 JS / 空内容绝不出现; 写入本身的成功/失败语义不变。
// node --check 语法回执同理: 只报告, 失败不门控、不回滚、不改盘。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCatalog } from "../src/tools/index.js";
import { registerBuiltinTools, jsExportSelfCheck } from "../src/tools/builtin.js";
import { registerV3Tools } from "../src/tools/v3.js";

const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-sc-${tag}-`));
const bcat = (root) => {
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: root, facts: null, memory: null });
  return c;
};
const vcat = (root) => {
  const c = new ToolCatalog();
  registerV3Tools(c, { rootDir: root });
  return c;
};
const write = async (root, p, content) =>
  JSON.parse(await bcat(root).call("write_file", { path: p, content }));

const NO_EXPORT = "function sum(a, b) {\n    return a + b;\n}";

test("1) 无导出的 .js 写入: 出现 export 自查提示, 且写入照常成功落盘", async () => {
  const root = mk("noexport");
  try {
    const r = await write(root, "utils.js", NO_EXPORT);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.selfcheck && /export/.test(r.selfcheck), `应含 export 自查提示: ${JSON.stringify(r)}`);
    assert.match(r.selfcheck, /无法被 import/, "提示要点明无法被导入");
    assert.equal(r.selfcheck.split("\n").length, 1, "提示必须是一行");
    assert.equal(fs.readFileSync(path.join(root, "utils.js"), "utf8"), NO_EXPORT, "内容不应被改动");
    assert.match(r.syntax || "", /^语法通过/, `合法 JS 应报语法通过: ${r.syntax}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("2) 有 export 的 .js: 不出现自查提示, 写入成功", async () => {
  const root = mk("esm");
  try {
    const r = await write(root, "utils.js", "export " + NO_EXPORT);
    assert.equal(r.ok, true);
    assert.equal(r.selfcheck, undefined, "有 export 不应提示");
    assert.equal(fs.readFileSync(path.join(root, "utils.js"), "utf8"), "export " + NO_EXPORT);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("3) 有 module.exports 的 .js: 不出现自查提示", async () => {
  const root = mk("cjs");
  try {
    const r = await write(root, "utils.cjs", "module.exports = { sum(a, b) { return a + b; } };\n");
    assert.equal(r.ok, true);
    assert.equal(r.selfcheck, undefined, "CJS 导出不应提示");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("4) .txt 无 export: 不出现自查提示 (只盯 JS 模块文件)", async () => {
  const root = mk("txt");
  try {
    const r = await write(root, "notes.txt", NO_EXPORT);
    assert.equal(r.ok, true);
    assert.equal(r.selfcheck, undefined, "非 JS 不应提示");
    assert.equal(r.syntax, undefined, "非 JS 不跑 node --check");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("5) 空内容 .js: 到不了自查 (必填参数校验先拒, 既有语义), 辅助函数对空串也返回 null", async () => {
  const root = mk("empty");
  try {
    const raw = await bcat(root).call("write_file", { path: "blank.js", content: "" });
    assert.match(String(raw), /参数错误/, "空 content 应被既有必填校验拒绝");
    assert.ok(!String(raw).includes("自查"), "拒绝结果里不应混入自查提示");
    assert.equal(fs.existsSync(path.join(root, "blank.js")), false, "不应发生写入");
    assert.equal(jsExportSelfCheck("blank.js", "   "), null, "纯空白内容不提示");
    assert.equal(r_null_ext(), null, "非 JS 不提示");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
const r_null_ext = () => jsExportSelfCheck("notes.txt", "hello");

test("6) 语法错误的 .js: 报告语法失败但写入不回滚不失败 (报告非门控)", async () => {
  const root = mk("bad");
  try {
    const broken = "function broken( {\nreturn 1;\n";
    const r = await write(root, "broken.js", broken);
    assert.equal(r.ok, true, "node --check 失败不得改变写入结果");
    assert.match(r.syntax || "", /^语法未通过/, `应报语法失败: ${r.syntax}`);
    assert.equal(r.syntax.split("\n").length, 1, "失败回执也是一行");
    assert.equal(fs.readFileSync(path.join(root, "broken.js"), "utf8"), broken, "文件须原样在盘上");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("7) apply_patch 新建无导出 .js: 每文件结果带自查; 有导出不带", async () => {
  const root = mk("patch");
  try {
    // 新建文件: SEARCH 留空 + 文件不存在 (工具文档形式)
    const mkBlock = (file, body) =>
      `${file}\n<<<<<<< SEARCH\n=======\n${body}\n>>>>>>> REPLACE`;
    const r1 = JSON.parse(await vcat(root).call("apply_patch", { content: mkBlock("a.js", NO_EXPORT) }));
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.ok(r1.results[0].selfcheck && /export/.test(r1.results[0].selfcheck),
      `无导出新建应提示: ${JSON.stringify(r1.results[0])}`);
    const r2 = JSON.parse(await vcat(root).call("apply_patch", { content: mkBlock("b.js", "export " + NO_EXPORT) }));
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.results[0].selfcheck, undefined, "有导出不应提示");
    assert.equal(fs.readFileSync(path.join(root, "a.js"), "utf8").includes("return a + b"), true, "内容照常落盘");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
