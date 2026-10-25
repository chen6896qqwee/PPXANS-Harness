// test/skill-eval.test.js — 技能 A/B 对照评测守卫 (2026-10-09, skill-up 式闭环)
// 锁语义: ①用例 schema 校验 ②rule_based 三判分器 ③verdict 阈值 ④注册表过滤钩子 (env 驱动零侵入)
import { test } from "node:test";
import assert from "node:assert";
import { validateCases, scoreArtifact, verdictOf } from "../scripts/skill-eval.js";
import { applySkillEvalFilter, createSkillRegistry } from "../src/skills/registry.js";

test("用例 schema: 合法通过 / 缺字段逐条报错", () => {
  assert.deepEqual(validateCases({ skill: "s", cases: [{ id: "a", task: "t", artifact: "f.html", verifier: { type: "html-structure" } }] }), []);
  const errs = validateCases({ cases: [{ id: "a" }] });
  assert.ok(errs.length >= 4, "缺 skill/task/artifact/verifier 都要报");
  assert.ok(validateCases(null).length === 1);
});

test("判分器: contains / file-exists / html-structure 线性分", () => {
  assert.equal(scoreArtifact({ type: "contains", value: "hero" }, "<h1>hero</h1>"), 1);
  assert.equal(scoreArtifact({ type: "contains", value: "zzz" }, "<h1>hero</h1>"), 0);
  assert.equal(scoreArtifact({ type: "file-exists" }, "x"), 1);
  assert.equal(scoreArtifact({ type: "file-exists" }, ""), 0);
  const full = "<!DOCTYPE html><html><head><meta name=\"viewport\"><title>demo</title></head><body><nav>x</nav><div class=\"hero\">h</div><div class=\"card\">1</div><div class=\"card\">2</div><footer>f</footer><style>@media(max-width:600px){} .b:hover{}:root{--a:1px}</style><main>m</main></body></html>";
  const s = scoreArtifact({ type: "html-structure" }, full);
  assert.ok(s > 0.9, "全结构页应接近满分: " + s);
  assert.equal(scoreArtifact({ type: "html-structure" }, "hello"), 0);
});

test("verdict 阈值: Δ>0.05 有效 / Δ<-0.05 负效 / 中间无差", () => {
  assert.equal(verdictOf(0.9, 0.5).verdict, "有效");
  assert.equal(verdictOf(0.5, 0.9).verdict, "负效(考虑修技能)");
  assert.equal(verdictOf(0.5, 0.52).verdict, "无显著差异");
  assert.equal(verdictOf(0.6, 0.5).delta, 0.1);
});

test("anti-slop 判分: 四俗全中=0 / 戒律全守=1 / 单项违规逐条扣", () => {
  // AI slop 样本: 紫渐变 + 全居中无左对齐 + 单一圆角 + Inter (模型默认审美画像)
  const slop = "<style>.hero{text-align:center}h1{text-align:center}.c{border-radius:14px}.d{border-radius:14px}body{font-family:Inter,sans-serif}.g{background:linear-gradient(#8b5cf6,#a855f7)}</style>";
  assert.equal(scoreArtifact({ type: "anti-slop" }, slop), 0);
  // 戒律样本: 无紫 / 左对齐 / 圆角有节奏(3种) / 非 Inter
  const clean = "<style>.hero{text-align:left}.a{border-radius:4px}.b{border-radius:12px}.c{border-radius:24px}body{font-family:Georgia,serif}</style>";
  assert.equal(scoreArtifact({ type: "anti-slop" }, clean), 1);
  // 单俗: 只有居中
  const one = "<style>.hero{text-align:center}.a{border-radius:4px}.b{border-radius:12px}.c{border-radius:20px}body{font-family:Georgia}</style>";
  assert.equal(scoreArtifact({ type: "anti-slop" }, one), 0.75);
  // 无圆角 = 极简也合戒律 (radii.size===0)
  assert.equal(scoreArtifact({ type: "anti-slop" }, "<style>.h{text-align:left}body{font-family:serif}</style>"), 1);
});

test("注册表过滤钩子: PPX_DISABLE_SKILLS 滤名册, 不设=零行为", () => {
  const r = createSkillRegistry(null, process.cwd());
  const before = r.list().length;
  // 本测试验证的是【过滤钩子的增减行为】, 不是技能库的绝对数量 ——
  //   原先硬编码 `before > 70` 会随技能库增删而假失败 (2026-10-10: 实际 66 个, 断言过期)。
  //   改为断言"非空且含可识别 id", 与数量解耦。
  assert.ok(before > 0, "全量技能应非空: " + before);
  assert.ok(typeof r.list()[0]?.id === "string" && r.list()[0].id, "技能应带字符串 id");
  const target = r.list()[0].id;
  process.env.PPX_DISABLE_SKILLS = target;
  const r2 = createSkillRegistry(null, process.cwd());
  assert.equal(r2.list().length, before - 1, "禁 1 个应少 1");
  assert.ok(!r2.list().some((s) => s.id === target));
  assert.deepEqual(r2.disabledSkills, [String(target).toLowerCase()]);
  delete process.env.PPX_DISABLE_SKILLS;
  const r3 = createSkillRegistry(null, process.cwd());
  assert.equal(r3.list().length, before, "清 env 恢复全量");
  assert.equal(applySkillEvalFilter(r3).length, 0, "无 env 时过滤为空");
});
