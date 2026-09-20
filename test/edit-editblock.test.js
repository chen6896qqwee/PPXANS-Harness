// test/edit-editblock.test.js — SEARCH/REPLACE 编辑块单测
import test from "node:test";
import assert from "node:assert";
import {
  parseEditBlocks,
  applyEditBlock,
  applyAll,
  formatRetryFeedback,
} from "../src/edit/editblock.js";

const SAMPLE = `<<<<<<< SEARCH
src/a.js
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;

test("解析基本块: 提取 path/search/replace", () => {
  const blocks = parseEditBlocks(SAMPLE);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "src/a.js");
  assert.equal(blocks[0].search, "const x = 1;");
  assert.equal(blocks[0].replace, "const x = 2;");
});

test("解析容错: 围栏/冒号包裹", () => {
  const text = [
    "```",
    "<<<<<<< SEARCH",
    "[src/b.js]:",
    "let a = 0;",
    "=======",   // 实际应为 7 个 =, 容错用 5+ 也行
    "let a = 1;",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n");
  const blocks = parseEditBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "src/b.js");
  assert.equal(blocks[0].search, "let a = 0;");
  assert.equal(blocks[0].replace, "let a = 1;");
});

test("解析容错: 分隔符前后多余空格", () => {
  const text = `  <<<<<<< SEARCH
src/c.js
foo
   =======
bar
  >>>>>>> REPLACE  `;
  const blocks = parseEditBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "src/c.js");
  assert.equal(blocks[0].search, "foo");
  assert.equal(blocks[0].replace, "bar");
});

test("解析多块同文件", () => {
  const text = [
    "<<<<<<< SEARCH",
    "f.js",
    "A",
    "=======", "B", ">>>>>>> REPLACE",
    "<<<<<<< SEARCH",
    "f.js",
    "C",
    "=======", "D", ">>>>>>> REPLACE",
  ].join("\n");
  const blocks = parseEditBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].search, "A");
  assert.equal(blocks[1].search, "C");
});

test("精确匹配应用", () => {
  const [b] = parseEditBlocks(SAMPLE);
  const r = applyEditBlock("const x = 1;", b);
  assert.equal(r.ok, true);
  assert.equal(r.content, "const x = 2;");
  assert.equal(r.kind, "exact");
});

test("去首尾空行匹配", () => {
  const b = { path: "f", search: "\nconst y = 1;\n", replace: "const y = 9;" };
  const r = applyEditBlock("const y = 1;", b);
  assert.equal(r.ok, true);
  assert.equal(r.content, "const y = 9;");
});

test("模糊匹配: 搜索块带多余空白导致精确失败, 走模糊", () => {
  const content = ["function f() {", "  return 1;", "}", ""].join("\n");
  const b = { path: "f", search: "  return 1;  ", replace: "  return 2;  " };
  const r = applyEditBlock(content, b);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "fuzzy");
  assert.ok(r.content.includes("return 2;"));
});

test("not-found: 搜索内容不存在", () => {
  const b = { path: "f", search: "不存在的内容", replace: "x" };
  const r = applyEditBlock("hello", b);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "not-found");
  assert.ok(r.error.includes("not-found"));
});

test("ambiguous: 搜索内容多处命中", () => {
  const b = { path: "f", search: "dup", replace: "X" };
  const r = applyEditBlock("dup\ndup", b);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "ambiguous");
  assert.ok(r.error.includes("ambiguous"));
});

test("applyAll: 顺序应用多个块", () => {
  const blocks = [
    { path: "f", search: "A", replace: "B" },
    { path: "f", search: "B", replace: "C" },
  ];
  const r = applyAll("A", blocks);
  assert.equal(r.ok, true);
  assert.equal(r.content, "C");
  assert.equal(r.results.length, 2);
});

test("applyAll: 含失败块标记 ok=false", () => {
  const blocks = [
    { path: "f", search: "A", replace: "B" },
    { path: "f", search: "ZZZ", replace: "Y" },
  ];
  const r = applyAll("A", blocks);
  assert.equal(r.ok, false);
  assert.equal(r.results[1].ok, false);
});

test("formatRetryFeedback: 列出失败块与文件首尾 20 行", () => {
  const results = [
    { path: "f.js", ok: true, search: "A" },
    { path: "f.js", ok: false, kind: "not-found", error: "未找到匹配", search: "BAD" },
  ];
  const file = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  const fb = formatRetryFeedback(results, file);
  assert.ok(fb.includes("失败"));
  assert.ok(fb.includes("f.js"));
  assert.ok(fb.includes("line0"));
  assert.ok(fb.includes("line29"));
});

test("formatRetryFeedback: 无失败返回空串", () => {
  const r = applyAll("A", [{ path: "f", search: "A", replace: "B" }]);
  assert.equal(formatRetryFeedback(r.results, "x"), "");
});
