// test/local-embedder.test.js - 本地向量嵌入器单测 (2026-10-06 补齐: 向量库此前无直接单测)
// 覆盖: 维度稳定 / 确定性 / 区分度 (相关 > 无关) / 边界输入 / CJK 支持
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalEmbedder } from "../src/llm/local-embedder.js";

function cos(x, y) {
  let d = 0, m = 0, n = 0;
  for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; m += x[i] * x[i]; n += y[i] * y[i]; }
  return d / (Math.sqrt(m) * Math.sqrt(n) || 1);
}

test("维度恒定 256 且 L2 归一化", async () => {
  const e = createLocalEmbedder();
  const a = await e("任意文本");
  assert.equal(a.length, 256);
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, `L2 范数=${norm}`);
});

test("确定性: 同文本两次嵌入结果一致", async () => {
  const e = createLocalEmbedder();
  const a = await e("皮皮虾智能体内核");
  const b = await e("皮皮虾智能体内核");
  assert.deepEqual(a, b);
});

test("区分度: 词汇重叠高者相似度更高", async () => {
  const e = createLocalEmbedder();
  const base = await e("向量记忆库支持混合检索");
  const near = await e("向量记忆库混合检索实现");
  const far = await e("今天午餐吃红烧牛肉面");
  assert.ok(cos(base, near) > cos(base, far),
    `near=${cos(base, near).toFixed(3)} 应 > far=${cos(base, far).toFixed(3)}`);
});

test("边界: 空串/超长文本不崩溃且维度一致", async () => {
  const e = createLocalEmbedder();
  const empty = await e("");
  const huge = await e("皮皮虾".repeat(10000));
  assert.equal(empty.length, 256);
  assert.equal(huge.length, 256);
});

test("CJK + 拉丁混排均可嵌入", async () => {
  const e = createLocalEmbedder();
  const a = await e("PPXANS-Harness 纯 Node.js 零依赖");
  assert.equal(a.length, 256);
  assert.ok(a.some((v) => v !== 0));
});
