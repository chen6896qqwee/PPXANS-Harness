// test/experts.test.js - 专家名册守卫 (2026-10-02)
import test from "node:test";
import assert from "node:assert";
import { EXPERTS, resolveExpert, listExperts } from "../src/orchestrator/experts.js";

test("专家名册: 英文 id / 中文名 / 模糊匹配 / 未命中 null", () => {
  assert.equal(resolveExpert("code").name, "代码专家");
  assert.equal(resolveExpert("代码专家").name, "代码专家"); // 中文名直查
  assert.equal(resolveExpert("CODE").name, "代码专家");     // 大小写
  assert.equal(resolveExpert("把代码交给代码专家").name, "代码专家"); // 模糊包含
  assert.equal(resolveExpert("设计").name, "设计专家", "简称模糊命中设计专家");
  assert.equal(resolveExpert("不存在的专家"), null, "未命中返回 null (静默降级)");
  assert.equal(resolveExpert(""), null);
  assert.equal(resolveExpert(null), null);
});

test("专家名册: 只读专家标记 + 名册完整性", () => {
  assert.equal(EXPERTS.review.readonly, true, "审查专家应只读");
  assert.equal(EXPERTS.security.readonly, true, "安全专家应只读");
  for (const [id, e] of Object.entries(EXPERTS)) {
    assert.ok(e.name, `${id} 缺中文名`);
    assert.ok(e.perspective && e.perspective.length > 20, `${id} 视角过于空洞`);
  }
  const ids = Object.keys(EXPERTS);
  for (const must of ["code", "architect", "review", "test", "security", "design", "docs", "data", "product"]) {
    assert.ok(ids.includes(must), `名册缺 ${must}`);
  }
});

test("专家名册: listExperts 摘要含全部 id 与只读标注", () => {
  const s = listExperts();
  for (const id of Object.keys(EXPERTS)) assert.ok(s.includes(id), `摘要缺 ${id}`);
  assert.ok(s.includes("/只读"), "只读专家应有标注");
});
