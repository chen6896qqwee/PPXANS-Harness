// test/repomap.test.js - 仓库地图(PageRank) 单测
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { scanRepo, renderRepoMap, computePageRank, clearRepoMapCache } from "../src/repomap/index.js";

function tmpRoot(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-rm-${n}-`)); }
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

test("scanRepo: 递归收集 js 文件并提取互相引用的 def", () => {
  const root = tmpRoot("a");
  write(root, "a.js", "function alpha() { beta(); }\nmodule.exports = alpha;");
  write(root, "sub/b.js", "function beta() { gamma(); }\nconst gamma = 1;\nfunction gamma() {}");
  write(root, "sub/c.py", "def gamma():\n    return alpha()\n");
  const scan = scanRepo(root, { ignore: [".git", "node_modules"] });
  assert.ok(scan.files.length >= 2, "至少扫到 js 文件");
  assert.ok(scan.defRecords.has("alpha"), "提取 alpha 定义");
  assert.ok(scan.defRecords.has("beta"), "提取 beta 定义");
  assert.ok(scan.defRecords.has("gamma"), "提取 gamma 定义");
  assert.ok(scan.totalRefs > 0, "统计到引用");
  fs.rmSync(root, { recursive: true, force: true });
});

test("computePageRank: 互相引用的标识符获得非零排名", () => {
  const root = tmpRoot("b");
  write(root, "a.js", "function alpha() { beta(); }\n");
  write(root, "b.js", "function beta() { gamma(); }\nconst gamma = ()=>{};\n");
  write(root, "c.js", "function gamma() { alpha(); }\n");
  const scan = scanRepo(root);
  const rank = computePageRank(scan);
  assert.ok(rank.has("alpha") && rank.get("alpha") > 0);
  assert.ok(rank.has("beta") && rank.get("beta") > 0);
  assert.ok(rank.has("gamma") && rank.get("gamma") > 0);
  // 三个节点权重和应接近 1 (阻尼归一)
  const sum = [...rank.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, "PageRank 权重和≈1");
  fs.rmSync(root, { recursive: true, force: true });
});

test("renderRepoMap: 文本含函数名且统计正确, 缓存命中", () => {
  const root = tmpRoot("c");
  write(root, "a.js", "function alpha() { beta(); }\n");
  write(root, "b.js", "function beta() { gamma(); }\nfunction gamma() { alpha(); }\n");
  clearRepoMapCache();
  const r1 = renderRepoMap(root, { tokenBudget: 4096 });
  assert.ok(r1.text.includes("alpha"), "渲染含 alpha");
  assert.ok(r1.text.includes("beta"), "渲染含 beta");
  assert.ok(r1.text.includes("gamma"), "渲染含 gamma");
  assert.equal(r1.stats.files, 2, "stats.files=2");
  assert.ok(r1.stats.defs >= 3, "stats.defs>=3");

  // 缓存命中: 相同 root 在 30s 内返回同一对象引用
  const r2 = renderRepoMap(root, { tokenBudget: 4096 });
  assert.strictEqual(r1, r2, "缓存命中(同一对象)");
  fs.rmSync(root, { recursive: true, force: true });
});

test("renderRepoMap: 超 token 预算截断", () => {
  const root = tmpRoot("d");
  let body = "function root() {\n";
  for (let i = 0; i < 60; i++) body += `  const helper${i} = ${i};\n`;
  body += "}\n";
  write(root, "big.js", body);
  clearRepoMapCache();
  const r = renderRepoMap(root, { tokenBudget: 24 });
  const tokens = r.text.split(/\s+/).filter(Boolean).length;
  assert.ok(tokens <= 30, "预算内截断");
  fs.rmSync(root, { recursive: true, force: true });
});
