import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MULTILINGUAL_CASES,
  normalizeFact,
  evaluateMultilingualConsistency,
} from "../scripts/eval.js";

test("多语言任务按 group 提供中英文等价对和规范化器", () => {
  const groups = new Map();
  for (const item of MULTILINGUAL_CASES) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
    assert.ok(item.prompt);
  }
  assert.deepEqual([...groups.keys()].sort(), ["package-name", "sum-1-1"]);
  for (const items of groups.values()) {
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((item) => item.lang).sort(), ["en", "zh"]);
    assert.equal(new Set(items.map((item) => item.normalize)).size, 1);
  }
});

test("数字、年份和 package 项目名可跨中英文规范化", () => {
  assert.equal(normalizeFact("答案是２。", "number"), "2");
  assert.equal(normalizeFact("The answer is 2.", "number"), "2");
  assert.equal(normalizeFact("项目于 2009 年发布。", "year"), "2009");
  assert.equal(normalizeFact("It was released in 2009.", "year"), "2009");
  assert.equal(normalizeFact("项目名是 `PPXANS-Harness`。", "package"), "ppxans-harness");
  assert.equal(normalizeFact("The package is ppx-agent.", "package"), "ppxans-harness");
});

test("组内只要求规范化事实一致，不要求自由文本逐字相同", () => {
  const results = evaluateMultilingualConsistency([
    { group: "sum-1-1", lang: "zh", normalize: "number", content: "计算结果是 2。" },
    { group: "sum-1-1", lang: "en", normalize: "number", content: "The final answer is 2." },
    { group: "package-name", lang: "zh", normalize: "package", content: "这个项目叫 PPXANS-Harness。" },
    { group: "package-name", lang: "en", normalize: "package", content: "Its name is `ppxans-harness`." },
  ]);
  assert.deepEqual(results.map((result) => result.ok), [true, true]);
  assert.deepEqual(results[0].facts, [{ lang: "zh", fact: "2" }, { lang: "en", fact: "2" }]);
});

test("近失数字 2 与 3 不得判为一致", () => {
  const [result] = evaluateMultilingualConsistency([
    { group: "sum-1-1", lang: "zh", normalize: "number", content: "答案是 2。" },
    { group: "sum-1-1", lang: "en", normalize: "number", content: "The answer is 3." },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.facts.map((item) => item.fact), ["2", "3"]);
});

test("近失 package 项目名不得被正确子串掩盖", () => {
  assert.equal(normalizeFact("ppxans-harness-v2", "package"), null);
  const [result] = evaluateMultilingualConsistency([
    { group: "package-name", lang: "zh", normalize: "package", content: "ppxans-harness" },
    { group: "package-name", lang: "en", normalize: "package", content: "ppxans-harness-v2" },
  ]);
  assert.equal(result.ok, false);
});

test("事实缺失或语言不完整时保守判为不一致", () => {
  const results = evaluateMultilingualConsistency([
    { group: "missing-fact", lang: "zh", normalize: "package", content: "不知道" },
    { group: "missing-fact", lang: "en", normalize: "package", content: "Unknown" },
    { group: "missing-language", lang: "zh", normalize: "number", content: "答案是 2" },
  ]);
  assert.deepEqual(results.map((result) => result.ok), [false, false]);
});
