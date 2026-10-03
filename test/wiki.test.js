// test/wiki.test.js - 代码库 Wiki 生成器守卫 (2026-10-02, ZCode 吸收)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateWiki, isSensitiveFile, SENSITIVE_PATTERNS } from "../src/wiki/index.js";

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-wiki-"));
  fs.mkdirSync(path.join(d, "src"));
  fs.writeFileSync(path.join(d, "src", "calc.js"), "export function calcDiscount(n){\n  return n * 0.9;\n}\n");
  fs.writeFileSync(path.join(d, "app.js"), "import { calcDiscount } from \"./src/calc.js\";\nconsole.log(calcDiscount(10));\n");
  return d;
}

test("敏感文件排除: token/secret/credential/password/pem 一律不进 wiki", () => {
  const d = tmpRepo();
  fs.writeFileSync(path.join(d, "secret-token.json"), "{\"k\":1}");
  fs.writeFileSync(path.join(d, "deploy-password.txt"), "p");
  fs.writeFileSync(path.join(d, "server.pem"), "-----BEGIN");
  fs.writeFileSync(path.join(d, "normal.js"), "export const ok = 1;\n");
  const w = generateWiki(d);
  // .json 在扫描范围内应被计数排除; .txt/.pem 天然不在扫描扩展名内 (双重保险)
  assert.ok(w.sensitiveSkipped >= 1, "被扫描到的敏感文件应计数排除");
  assert.ok(!w.text.includes("secret-token"), "敏感文件不应出现在 wiki");
  assert.ok(!w.text.includes("deploy-password"), "敏感文件不应出现在 wiki");
  assert.ok(!w.text.includes("server.pem"), "敏感文件不应出现在 wiki");
  assert.ok(w.text.includes("normal.js"), "普通文件应保留");
  // 单测 isSensitiveFile
  assert.equal(isSensitiveFile("config/api_key.json"), true);
  assert.equal(isSensitiveFile("src/calc.js"), false);
  assert.ok(SENSITIVE_PATTERNS.length >= 8);
});

test("结论绑定源码位置: 签名 + file:line", () => {
  const w = generateWiki(tmpRepo());
  assert.ok(w.text.includes("export function calcDiscount(n){"), "应含签名原文");
  assert.ok(/src\/calc\.js:1/.test(w.text), "应绑定 file:line");
  assert.ok(w.stats.files >= 2 && w.stats.defs >= 1);
});

test("mermaid 依赖图: 相对 import 解析为内部边", () => {
  const w = generateWiki(tmpRepo());
  assert.ok(w.text.includes("```mermaid"), "应含 mermaid 图");
  assert.ok(w.stats.edges >= 1, "app.js → src/calc.js 应产生依赖边");
  assert.ok(w.text.includes("-->"), "应有 mermaid 边语法");
});

// --- 陈旧检测 (ZCode 语义: 代码变化后 wiki 标记陈旧) ---
import { checkStaleness } from "../src/wiki/index.js";

test("陈旧检测: 未生成=stale; 生成后改源码=stale; 刷新后=同步", () => {
  const d = tmpRepo();
  const out = path.join(d, "docs", "WIKI.md");
  // 未生成
  assert.equal(checkStaleness(out, d).stale, true, "未生成应 stale");
  // 生成后: 同步
  const w = generateWiki(d);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, w.text + "\n");
  assert.equal(checkStaleness(out, d).stale, false, "刚生成应同步");
  // 改源码 → 陈旧 (mtime 分辨率可能只有毫秒级: 显式 utimes 拉开时间差, 消除同毫秒竞态)
  const calcPath = path.join(d, "src", "calc.js");
  fs.writeFileSync(calcPath, "export function calcDiscount(n){\n  return n * 0.95;\n}\n");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(calcPath, future, future);
  const st = checkStaleness(out, d);
  assert.equal(st.stale, true, "源码变更应 stale");
  assert.ok(/变更/.test(st.reason));
});
