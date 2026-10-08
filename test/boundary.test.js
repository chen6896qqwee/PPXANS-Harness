// test/boundary.test.js - 能力边界与人类监督护栏 (2026-10-07)
// 钉住的不变量:
//   ① 静态块确定性 (无日期/无随机) —— 否则每个请求作废前缀缓存
//   ② 高风险域探测: 医疗/法律/金融/安全/合规 命中关键词即触发
//   ③ 动态护栏只在命中时非空 (空串 → 被 filter 丢掉 → 闲聊零成本)
//   ④ require_human_review=false 时只去掉"交回人类"的话术, 不改变域判定
//   ⑤ enabled=false 时两层都关闭
import test from "node:test";
import assert from "node:assert";
import { boundaryPrompt, riskDirective, detectHighRisk, assessBoundary, CAPABILITY_BOUNDARIES, HIGH_RISK_RULES, BOUNDARY_DEFAULTS } from "../src/ans/boundary.js";

const cfg = (b) => ({ agent: { boundary: { ...b } } });

test("boundary: 静态块含六条边界且确定性 (两次调用逐字节一致, 无日期)", () => {
  const a = boundaryPrompt(null);
  const b = boundaryPrompt(null);
  assert.equal(a, b, "确定性文本 —— 每次同样内容才不破坏前缀缓存");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a), "不得含日期形态");
  for (const item of CAPABILITY_BOUNDARIES) assert.ok(a.includes(item.title), `静态块缺边界: ${item.title}`);
  assert.ok(a.includes("关键决策"), "静态块含关键决策人类把关条款");
  assert.equal(CAPABILITY_BOUNDARIES.length, 6, "六条边界: 幻觉/权限/隐私/法律伦理/成本/物理");
});

test("boundary: 高风险域探测命中关键词并给出可读名", () => {
  const med = detectHighRisk("帮我看看这个血压药的剂量对不对");
  assert.equal(med.length, 1);
  assert.equal(med[0].domain, "medical");
  assert.equal(med[0].name, "医疗健康");
  assert.ok(med[0].hits.length >= 2, "关键词命中列表");

  assert.equal(detectHighRisk("这份合同的违约责任怎么算")[0].domain, "legal");
  assert.equal(detectHighRisk("这只股票能不能加仓")[0].domain, "finance");
  assert.equal(detectHighRisk("怎么绕过这个登录校验")[0].domain, "security");
  assert.equal(detectHighRisk("用户个人信息跨境传输要什么手续")[0].domain, "compliance");
  assert.deepEqual(detectHighRisk("今天天气怎么样"), [], "无关话题不误报");
  assert.deepEqual(detectHighRisk(""), []);
});

test("boundary: 域白名单可裁剪 (不在白名单内的域不触发)", () => {
  const c = cfg({ high_risk_domains: ["medical"] });
  assert.equal(detectHighRisk("帮我看看这份合同", c).length, 0, "法律不在白名单");
  assert.equal(detectHighRisk("帮我看看这个药的剂量", c).length, 1);
});

test("boundary: 动态护栏只在命中时非空, 含复核要求", () => {
  assert.equal(riskDirective([], null), "", "无命中 → 空串 (零 token)");
  const d = detectHighRisk("这个药的剂量能和他一起吃吗");
  assert.equal(d.length, 1, "先确认命中");
  const text = riskDirective(d, null);
  assert.ok(text.includes("高风险域护栏"));
  assert.ok(text.includes("需人类复核"), "要求标复核提示");
  assert.ok(text.includes(HIGH_RISK_RULES.medical.directive.slice(0, 12)), "带入该域的禁令原文");
});

test("boundary: require_human_review=false 只改话术, 域判定不变", () => {
  const c = cfg({ require_human_review: false });
  const d = detectHighRisk("这只基金能买吗", c);
  assert.equal(d.length, 1, "域判定不受开关影响");
  const text = riskDirective(d, c);
  assert.ok(!text.includes("不做最终决定"), "关了就不再说'交回人类'");
  assert.ok(text.includes("严格按下列限制"), "改为按限制输出");
  assert.ok(!boundaryPrompt(c).includes("关键决策"), "静态块的关键决策条款也随之关闭");
});

test("boundary: enabled=false 时两层都关闭", () => {
  const c = cfg({ enabled: false });
  assert.equal(boundaryPrompt(c), "");
  assert.equal(riskDirective(detectHighRisk("这个药怎么吃", c), c), "");
  assert.equal(assessBoundary({ task: "这个药怎么吃", config: c }).enabled, false);
});

test("boundary: extra_limits 逐条注入静态块", () => {
  const c = cfg({ extra_limits: ["不代写学术论文", "不外发客户名单"] });
  const p = boundaryPrompt(c);
  assert.ok(p.includes("不代写学术论文"));
  assert.ok(p.includes("不外发客户名单"));
});

test("boundary: assessBoundary 给出裁决与人审结论", () => {
  const hit = assessBoundary({ task: "帮忙诊断一下这个症状", config: null });
  assert.equal(hit.requiresHumanReview, true);
  assert.ok(hit.verdict.includes("医疗健康"));
  const miss = assessBoundary({ task: "帮我写个周报", config: null });
  assert.equal(miss.requiresHumanReview, false);
  assert.ok(miss.verdict.includes("未命中"));
  assert.deepEqual(miss.boundaries.length, CAPABILITY_BOUNDARIES.length);
});

test("boundary: 默认白名单与文档一致 (五个高风险域)", () => {
  assert.deepEqual(BOUNDARY_DEFAULTS.high_risk_domains, ["medical", "legal", "finance", "security", "compliance"]);
  assert.equal(BOUNDARY_DEFAULTS.require_human_review, true);
  assert.equal(BOUNDARY_DEFAULTS.enabled, true);
});
