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

// --- 最佳匹配窗口诊断 (2026-10-02 深度优化) ---

test("not-found 附最佳匹配 hint: 行号+相似度", () => {
  const content = "line1\nfunction calcTotal(n){\n  return n * 1.1;\n}\nline5\n";
  // SEARCH 写错了一点 (calcTotal 写成 calcTotall, 缩进不同) → 精确/模糊都应失败, 但 hint 应指向第 2 行
  const r = applyEditBlock(content, { search: "function calcTotall(n){\n  return n * 1.1;\n}", replace: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "not-found");
  assert.ok(r.hint, "应有 hint");
  assert.equal(r.hint.line, 2, "应定位到第 2 行");
  assert.ok(r.hint.score >= 0.5, `相似度应较高, 实际 ${r.hint.score}`);
  assert.ok(/第 2 行附近/.test(r.error), "error 应含可行动指引");
});

test("not-found 无相似区域时 hint 为 null", () => {
  const r = applyEditBlock("aaa\nbbb\nccc\n", { search: "xyz\n完全不同\n", replace: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.hint, undefined, "无相似区域不应造 hint");
});

test("formatRetryFeedback: hint 带原文摘录 (±5 行带行号), 无 hint 回落首尾 20 行", () => {
  const content = Array.from({ length: 30 }, (_, i) => `第${i + 1}行`).join("\n");
  const results = [{ ok: false, path: "f.js", kind: "not-found", error: "未找到", search: "第10行", hint: { line: 10, score: 0.8 } }];
  const fb = formatRetryFeedback(results, content);
  assert.ok(fb.includes("第 5-15 行"), "应摘录 hint 附近区域");
  assert.ok(fb.includes("10 | 第10行"), "应带行号前缀");
  // 无 hint: 回落旧首尾 20 行模式
  const fb2 = formatRetryFeedback([{ ok: false, path: "f", kind: "not-found", error: "x", search: "y" }], content);
  assert.ok(fb2.includes("文件前 20 行"), "无 hint 应回落首尾模式");
});

// --- 路径可选语法 (2026-10-05 修复: 旧解析器无条件吞 SEARCH 后首行当路径) ---

test("无路径普通形式: 首行代码完整留在 search, path 为 null", () => {
  const blocks = parseEditBlocks(
    "<<<<<<< SEARCH\nexport async function fetchData()\n=======\nexport async function loadData()\n>>>>>>> REPLACE");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, null);
  assert.equal(blocks[0].search, "export async function fetchData()");
  assert.equal(blocks[0].replace, "export async function loadData()");
});

test("无路径多行块: 首行即使短也不是路径 (空白判据不吃代码行)", () => {
  const blocks = parseEditBlocks("<<<<<<< SEARCH\nconst v = parse(x)\nreturn v\n=======\nreturn v\n>>>>>>> REPLACE");
  assert.equal(blocks[0].path, null);
  assert.equal(blocks[0].search, "const v = parse(x)\nreturn v");
});

test("行内路径行后紧跟 =======: 该行按内容处理, search 非空 (良构块 search 恒非空)", () => {
  // 单行 SEARCH + 行内路径约定在这里天然歧义 —— 保 search 不保路径, 路径由 args.path 兜底
  const blocks = parseEditBlocks("<<<<<<< SEARCH\nutils.js\n=======\nhelpers.js\n>>>>>>> REPLACE");
  assert.equal(blocks[0].path, null);
  assert.equal(blocks[0].search, "utils.js");
});

test("aider 约定: 文件名在 <<<<<<< SEARCH 的上一行", () => {
  const blocks = parseEditBlocks("src/a.js\n<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE");
  assert.equal(blocks[0].path, "src/a.js");
  assert.equal(blocks[0].search, "const x = 1;");
});

test("aider 约定容错: @@@ 装饰 / 反引号包裹 / 尾冒号", () => {
  const b1 = parseEditBlocks("@@@ rename-me.js\n<<<<<<< SEARCH\nfetchData\n=======\nloadData\n>>>>>>> REPLACE");
  assert.equal(b1[0].path, "rename-me.js");
  assert.equal(b1[0].search, "fetchData");
  const b2 = parseEditBlocks("`notes.md`:\n<<<<<<< SEARCH\n旧\n=======\n新\n>>>>>>> REPLACE");
  assert.equal(b2[0].path, "notes.md");
});

test("aider 多文件: 每块各带前置文件名, 散文前缀不误判为路径", () => {
  const text = [
    "把 a.js 改掉:",
    "src/a.js",
    "<<<<<<< SEARCH", "A", "=======", "B", ">>>>>>> REPLACE",
    "src/b.js",
    "<<<<<<< SEARCH", "C", "=======", "D", ">>>>>>> REPLACE",
  ].join("\n");
  const blocks = parseEditBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, "src/a.js");
  assert.equal(blocks[1].path, "src/b.js");
  assert.equal(blocks[1].search, "C");
});

test("新建文件: 空 SEARCH + 前置路径 / 空 SEARCH + 无路径两种形式", () => {
  const withPath = parseEditBlocks("src/new.js\n<<<<<<< SEARCH\n=======\ncontent\n>>>>>>> REPLACE");
  assert.equal(withPath[0].path, "src/new.js");
  assert.equal(withPath[0].search, "");
  const noPath = parseEditBlocks("<<<<<<< SEARCH\n=======\ncontent\n>>>>>>> REPLACE");
  assert.equal(noPath[0].path, null);
  assert.equal(noPath[0].search, "");
});

test("CRLF 输入按行拆分, 新语法同样成立", () => {
  const blocks = parseEditBlocks("x.js\r\n<<<<<<< SEARCH\r\nold line\r\n=======\r\nnew line\r\n>>>>>>> REPLACE");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "x.js");
  assert.equal(blocks[0].search, "old line");
});

test("前置行是块结束标记时不误判为路径", () => {
  const blocks = parseEditBlocks(
    "<<<<<<< SEARCH\nf.js\nA\n=======\nB\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nC\n=======\nD\n>>>>>>> REPLACE");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, "f.js");
  assert.equal(blocks[1].path, null, "第二块前置是 >>>>>>> REPLACE, 不是文件名");
});
