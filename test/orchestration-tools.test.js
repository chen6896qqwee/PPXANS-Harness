// test/orchestration-tools.test.js - 编排与自省工具 (2026-10-07)
// 覆盖: legion_status / legion_set_concurrency / team_list / expert_list /
//       capability_matrix / boundary_check / skill_coverage / skill_domains
// 走真装配链路 (PPXAgent), 不 mock —— 这些工具的价值全在"把真实状态说出来"。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { getGovernor, resetGovernor } from "../src/orchestrator/governor.js";
import { TEAMS } from "../src/orchestrator/teams.js";
import { EXPERTS } from "../src/orchestrator/experts.js";
import { SKILL_DOMAINS } from "../src/skills/registry.js";
import { setLevel } from "../src/utils/logger.js";

setLevel("error");
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-orch-${tag}-`));

let agent = null;
function shared() {
  if (!agent) agent = new PPXAgent({ root: path.resolve("."), dataDir: tmp("main") });
  return agent;
}
test.after(() => { if (agent) { agent.shutdown(); fs.rmSync(agent.dataDir, { recursive: true, force: true }); } });

test("装配: 八个自省/编排工具全部注册且带显式能力声明", () => {
  const c = shared().tools;
  for (const n of ["legion_status", "legion_set_concurrency", "team_list", "expert_list", "capability_matrix", "boundary_check", "skill_coverage", "skill_domains"]) {
    assert.ok(c.has(n), `${n} 未注册`);
    const cap = c.getCapability(n);
    assert.ok(cap && typeof cap.readOnly === "boolean", `${n} 缺能力声明`);
  }
  assert.equal(c.getCapability("legion_status").readOnly, true, "状态查询是只读");
  assert.equal(c.getCapability("legion_set_concurrency").readOnly, false, "改并发配额不是只读");
  assert.equal(c.getCapability("skill_import").readOnly, false, "网络写文件不是只读");
});

test("legion_status: 报告治理器上限/在跑/排队 + 未建军团时如实说明", async () => {
  const a = shared();
  const out = await a.tools.call("legion_status", {}, { agent: a });
  const gov = getGovernor().stats();
  assert.ok(out.includes(`上限 ${gov.limit}`), `应报上限, 实际: ${out}`);
  assert.ok(out.includes("单次派发上限"));
  assert.ok(/军团成员|尚未创建军团/.test(out), "军团状态如实报告");
});

test("legion_set_concurrency: 运行期调整并同步内存配置 (不写盘)", async () => {
  const a = shared();
  const before = a.config.agent.legion.max_concurrent_agents;
  const out = await a.tools.call("legion_set_concurrency", { limit: 5, per_call: 3 }, { agent: a });
  assert.ok(out.includes("并发已调整"), out);
  assert.equal(getGovernor().limit, 5);
  assert.equal(getGovernor().perCallMax, 3);
  assert.equal(a.config.agent.legion.max_concurrent_agents, 5, "内存配置同步 (后续 Legion 实例生效)");
  assert.equal(a.config.agent.legion.max_concurrent_per_call, 3);
  assert.ok(!out.includes("已写回"), "默认不写盘");
  // 无参数 → 可行动错误而不是静默 no-op
  const bad = await a.tools.call("legion_set_concurrency", {}, { agent: a });
  assert.ok(bad.includes("[工具错误]"), bad);
  // 还原, 避免影响同文件后续用例
  await a.tools.call("legion_set_concurrency", { limit: before, per_call: 4 }, { agent: a });
});

test("team_list: 列出全部班组 + 拓扑 + 只读/高风险标记", async () => {
  const a = shared();
  const out = await a.tools.call("team_list", {}, { agent: a });
  for (const id of Object.keys(TEAMS)) assert.ok(out.includes(id), `缺班组 ${id}`);
  assert.ok(out.includes("拓扑"), "带拓扑");
  assert.ok(out.includes("只读"), "评审/审查角色带只读标记");
  assert.ok(out.includes("含高风险域"), "高风险班组带提示");
});

test("expert_list: 名册可见并可按域过滤", async () => {
  const a = shared();
  const all = await a.tools.call("expert_list", {}, { agent: a });
  for (const id of Object.keys(EXPERTS)) assert.ok(all.includes(id), `缺专家 ${id}`);
  assert.ok(all.includes("需人工复核"), "高风险专家带标记");
  const med = await a.tools.call("expert_list", { domain: "medical" }, { agent: a });
  assert.ok(med.includes("医疗信息顾问"));
  assert.ok(!med.includes("代码专家"), "按域过滤生效");
  const none = await a.tools.call("expert_list", { domain: "不存在" }, { agent: a });
  assert.ok(none.includes("无匹配专家"), none);
});

test("skill_coverage: 报告技能总数与十二域覆盖", async () => {
  const a = shared();
  const out = await a.tools.call("skill_coverage", {}, { agent: a });
  assert.ok(/技能总数 \d+ · 域覆盖 \d+\/12/.test(out), out);
  for (const d of SKILL_DOMAINS) assert.ok(out.includes(d.name), `缺域 ${d.name}`);
});

test("skill_domains: 列出十二域目录", async () => {
  const a = shared();
  const out = await a.tools.call("skill_domains", {}, { agent: a });
  assert.equal(out.split("\n").length, SKILL_DOMAINS.length);
  assert.ok(out.includes("knowledge — 信息与知识处理"));
});

test("capability_matrix: 九维能力 + 域覆盖 + 并发 + 边界四段齐全", async () => {
  const a = shared();
  const out = await a.tools.call("capability_matrix", {}, { agent: a });
  assert.ok(out.includes("九维核心能力"));
  for (const axis of ["感知", "记忆", "规划", "推理", "工具调用", "执行", "反思", "协作", "权限管理"]) {
    assert.ok(out.includes(axis + ":"), `缺能力维 ${axis}`);
  }
  assert.ok(out.includes("能力域技能覆盖"));
  assert.ok(out.includes("协作与并发"));
  assert.ok(out.includes("能力边界"));
  assert.ok(out.includes("子智能体并发: 上限"));
});

test("boundary_check: 命中高风险域给出人审要求与边界条款", async () => {
  const a = shared();
  const hit = await a.tools.call("boundary_check", { task: "帮我看看这份合同的违约责任" }, { agent: a });
  assert.ok(hit.includes("命中高风险域"), hit);
  assert.ok(hit.includes("法律"));
  assert.ok(hit.includes("需人类复核"));
  const miss = await a.tools.call("boundary_check", { task: "帮我写个周报" }, { agent: a });
  assert.ok(miss.includes("未命中高风险域"));
  assert.ok(miss.includes("边界条款"));
});

test("技能清单: 全量按域分组 (56 个技能一个不丢), 且不因截断丢名字", () => {
  const a = shared();
  const prompt = a._skillsPrompt();
  const list = a.skills.list();
  assert.ok(prompt.includes(`共 ${list.length} 个`), prompt.slice(0, 120));
  // 抽查几个容易被 top-K 截断策略丢掉的名字 (字母序靠后 / 中文作者技能)
  for (const id of ["verify", "session-naming", "knowledge/deep-research", "research/teaching-plan"]) {
    if (a.skills.has(id)) {
      const leaf = id.includes("/") ? id.split("/").pop() : id;
      assert.ok(prompt.includes(leaf), `名册缺 ${id}`);
    }
  }
  assert.ok(prompt.length < 4000, `名册应保持轻量, 实测 ${prompt.length} 字符`);
});

test("边界护栏: 静态块进 system 指令区, 动态块只在高风险消息时出现", () => {
  const a = shared();
  const plain = a._context("帮我写个周报");
  assert.ok(plain.includes("【能力边界】"), "静态块常驻");
  assert.ok(!plain.includes("【高风险域护栏】"), "闲聊不注入动态护栏");
  const risky = a._context("帮我看看这份合同的违约责任");
  assert.ok(risky.includes("【高风险域护栏】"), "命中高风险域时注入");
  // 静态区前缀不被 userMsg 影响 (前缀缓存契约): 到动态护栏插入点为止必须逐字节一致
  const idx = risky.indexOf("【高风险域护栏】");
  assert.ok(idx > 0, "动态护栏位于静态区之后");
  assert.equal(plain.slice(0, idx), risky.slice(0, idx), "静态区前缀不随 userMsg 变化");
});

test("governor 单例可重置 (测试隔离用)", () => {
  const g1 = getGovernor();
  resetGovernor();
  const g2 = getGovernor();
  assert.notEqual(g1, g2, "重置后是新实例");
  assert.equal(g2.running, 0);
});
