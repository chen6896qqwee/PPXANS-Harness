// test/teams.test.js - 专家班组与协作拓扑 (2026-10-07)
// 钉住的不变量:
//   ① 每个班组成员都能在专家名册里解析出来 (班组不该引用不存在的角色)
//   ② 拓扑取值合法
//   ③ 风险画像: 含高风险域 (医疗/法律/金融/安全/合规) → requiresHuman; 全员只读 → allReadonly
//   ④ 中文名/别名可解析 (研发/调研/评审/对抗 …)
//   ⑤ 原 9 个专家的 id 与中文名不变 (experts.test.js 是既有契约)
import test from "node:test";
import assert from "node:assert";
import { TEAMS, TOPOLOGIES, resolveTeam, teamExperts, listTeams, teamCatalog, teamRiskProfile } from "../src/orchestrator/teams.js";
import { EXPERTS, HIGH_RISK_DOMAINS, expertCatalog, expertsByDomain } from "../src/orchestrator/experts.js";

test("teams: 名册自洽 —— 成员存在于专家名册且拓扑合法", () => {
  for (const [id, t] of Object.entries(TEAMS)) {
    assert.ok(t.name && t.desc, `${id} 缺名称/说明`);
    assert.ok(TOPOLOGIES.includes(t.topology), `${id} 拓扑非法: ${t.topology}`);
    assert.ok(Array.isArray(t.members) && t.members.length >= 2, `${id} 成员过少`);
    for (const m of t.members) assert.ok(EXPERTS[m], `${id} 引用不存在的专家: ${m}`);
  }
});

test("teams: 中文名与别名解析", () => {
  assert.equal(resolveTeam("dev").name, "研发班组");
  assert.equal(resolveTeam("研发").id, "dev");
  assert.equal(resolveTeam("调研").id, "research");
  assert.equal(resolveTeam("评审").id, "governance");
  assert.equal(resolveTeam("对抗").id, "debate");
  assert.equal(resolveTeam("出行").id, "life");
  assert.equal(resolveTeam("不存在的班组"), null);
  assert.equal(resolveTeam(null), null);
  const s = listTeams();
  for (const id of Object.keys(TEAMS)) assert.ok(s.includes(id), `摘要缺 ${id}`);
});

test("teams: teamExperts 带出安全属性, 未知成员静默丢弃", () => {
  const members = teamExperts("hotfix");
  assert.equal(members.length, 2);
  assert.ok(members.some((m) => m.readonly), "紧急修复班组应含只读审查者");
  // 人为塞一个不存在的成员: 应被丢弃而不是让整班组失效
  const withGhost = teamExperts({ id: "x", members: ["code", "不存在的角色"] });
  assert.equal(withGhost.length, 1);
  assert.equal(withGhost[0].name, "代码专家");
});

test("teams: 风险画像 —— 评审班组全员只读且需人类复核", () => {
  const r = teamRiskProfile("governance");
  assert.equal(r.requiresHuman, true, "含合规/法务/安全 → 需人类复核");
  assert.equal(r.allReadonly, true, "评审班组全员只读");
  assert.equal(r.memberCount, 3);
  const dev = teamRiskProfile("dev");
  assert.equal(dev.requiresHuman, false, "研发班组不触发高风险域");
  assert.equal(dev.allReadonly, false, "研发班组有可写角色");
});

test("experts v2: 原 9 员的 id 与中文名不变 (向后兼容契约)", () => {
  assert.equal(EXPERTS.code.name, "代码专家");
  assert.equal(EXPERTS.architect.name, "架构专家");
  assert.equal(EXPERTS.review.name, "代码审查专家");
  assert.equal(EXPERTS.test.name, "测试专家");
  assert.equal(EXPERTS.security.name, "安全专家");
  assert.equal(EXPERTS.design.name, "设计专家");
  assert.equal(EXPERTS.docs.name, "文档专家");
  assert.equal(EXPERTS.data.name, "数据专家");
  assert.equal(EXPERTS.product.name, "产品专家");
  assert.equal(EXPERTS.review.readonly, true);
  assert.equal(EXPERTS.security.readonly, true);
});

test("experts v2: 高风险域专家一律只读 + requiresHuman", () => {
  const high = expertCatalog().filter((e) => HIGH_RISK_DOMAINS.includes(e.domain));
  assert.ok(high.length >= 4, "医疗/法律/金融/合规 至少四员");
  for (const e of high) {
    assert.equal(e.readonly, true, `${e.id} 高风险域专家必须只读`);
    assert.equal(e.requiresHuman, true, `${e.id} 高风险域专家必须标需人工复核`);
  }
});

test("experts v2: 每员都有 domain / perspective / 非空技能绑定 (若有)", () => {
  for (const e of expertCatalog()) {
    assert.ok(e.name, `${e.id} 缺中文名`);
    assert.ok(e.perspective && e.perspective.length > 20, `${e.id} 视角过于空洞`);
    assert.ok(e.domain, `${e.id} 缺 domain`);
    assert.ok(Array.isArray(e.skills), `${e.id} skills 应为数组`);
  }
  assert.ok(expertsByDomain("code").length >= 3, "code 域有多个专家");
  assert.equal(expertsByDomain("不存在的域").length, 0);
});

test("teams: teamCatalog 输出结构完整 (供 team_list 工具消费)", () => {
  const cat = teamCatalog();
  assert.equal(cat.length, Object.keys(TEAMS).length);
  for (const t of cat) {
    assert.ok(t.id && t.name && t.desc && t.topology);
    for (const m of t.members) {
      assert.ok(m.id && m.name);
      assert.equal(typeof m.readonly, "boolean");
      assert.equal(typeof m.requiresHuman, "boolean");
    }
  }
});
