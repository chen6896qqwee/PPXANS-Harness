import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { buildArbitrationInput, arbitrate, parseReviewFindings, needsFix, buildReviewPrompt, buildFixPrompt } from "../src/tools/delegate.js";

function tmp(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-dl-${n}-`)); }

test("spawn_agent 工具已注册", () => {
  const agent = new PPXAgent({ root: tmp("reg") });
  assert.ok(agent.tools.has("spawn_agent"), "spawn_agent 工具已注册");
  const meta = agent.tools.tools.get("spawn_agent");
  assert.ok(meta.parameters.properties.task, "有 task 参数");
  assert.ok(meta.parameters.properties.role, "有 role 参数");
  assert.ok(meta.parameters.properties.tasks, "有 tasks 参数");
  assert.ok(meta.parameters.properties.perspectives, "有 perspectives 参数");
  assert.ok(meta.parameters.properties.arbitrate, "有 arbitrate 参数");
  assert.ok(meta.parameters.properties.judge, "有 judge 参数");
  agent.shutdown();
});

test("spawn_agent 无 LLM 时返回引导错误 (不崩)", async () => {
  const agent = new PPXAgent({ root: tmp("nolm") });
  const res = await agent.tools.call("spawn_agent", { task: "x" }, { agent });
  assert.ok(res.includes("未配置模型"), "无 LLM 时明确引导");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("spawn_agent 无 agent 上下文时返回错误 (不崩)", async () => {
  const agent = new PPXAgent({ root: tmp("noctx") });
  const res = await agent.tools.call("spawn_agent", { task: "x" });
  assert.ok(res.includes("无 agent 上下文") || res.includes("工具错误"), "缺上下文时安全失败");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("spawn_agent 无 task 也无 tasks 时返回引导错误", async () => {
  const agent = new PPXAgent({ root: tmp("notask") });
  const res = await agent.tools.call("spawn_agent", {}, { agent });
  assert.ok(res.includes("需要 task 或 tasks"), `应引导补 task, 实际: ${res}`);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

// --- 仲裁/差异化上下文纯函数 ---

test("buildArbitrationInput 组装多子结果含视角", () => {
  const input = buildArbitrationInput(
    ["分析代码质量", "分析性能"],
    ["质量一般", "性能优秀"],
    ["质量视角", "性能视角"]
  );
  assert.ok(input.includes("【子任务1 (视角: 质量视角)】"), "含视角标注");
  assert.ok(input.includes("【结果2】性能优秀"), "含第二结果");
});

test("arbitrate 有 LLM 时返回仲裁结果", async () => {
  const fakeAgent = { llm: { chat: async () => ({ content: "综合结论: 质量一般, 性能优秀" }) } };
  const out = await arbitrate(fakeAgent, ["任务A", "任务B"], ["结果A", "结果B"], [], "");
  assert.equal(out, "综合结论: 质量一般, 性能优秀");
});

test("arbitrate 无 LLM 或失败时降级拼接 (不崩)", async () => {
  const noLlm = await arbitrate({}, ["任务A"], ["结果A"], [], "");
  assert.ok(noLlm.includes("结果A"), "无 LLM 降级拼接");
  const failAgent = { llm: { chat: async () => { throw new Error("boom"); } } };
  const failed = await arbitrate(failAgent, ["任务A"], ["结果A"], [], "");
  assert.ok(failed.includes("结果A"), "LLM 失败降级拼接");
});

test("spawn_agent 多任务不仲裁时拼接各方结果 (mock legion)", async () => {
  const agent = new PPXAgent({ root: tmp("multi") });
  agent.llm = { chat: async () => ({ content: "x" }) }; // 占位, 满足"已配置模型"
  // 注入 mock legion, 不真 spawn 子进程
  const replies = ["质量一般", "性能优秀"];
  agent._legion = {
    spawnAgent: () => {},
    send: async () => ({ reply: replies.shift() }),
  };
  const res = await agent.tools.call("spawn_agent", {
    tasks: ["分析代码质量", "分析性能"],
    perspectives: ["质量视角", "性能视角"],
  }, { agent });
  assert.ok(res.includes("【子任务1") && res.includes("【子任务2"), "多任务结果拼接");
  assert.ok(res.includes("质量一般") && res.includes("性能优秀"), "含各方结果");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("spawn_agent 多任务仲裁时走主 agent 聚合", async () => {
  const agent = new PPXAgent({ root: tmp("arb") });
  agent.llm = {
    chat: async () => ({ content: "仲裁结论: 取性能方案" }),
  };
  const replies = ["方案A", "方案B"];
  agent._legion = {
    spawnAgent: () => {},
    send: async () => ({ reply: replies.shift() }),
  };
  const res = await agent.tools.call("spawn_agent", {
    tasks: ["方案A评估", "方案B评估"],
    arbitrate: true,
    judge: "选出最优",
  }, { agent });
  assert.ok(res.includes("仲裁结论: 取性能方案"), `仲裁生效, 实际: ${res}`);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("spawn_agent 单任务保持旧行为 (直接返回子 agent 回复)", async () => {
  const agent = new PPXAgent({ root: tmp("single") });
  agent.llm = { chat: async () => ({ content: "x" }) };
  agent._legion = {
    spawnAgent: () => {},
    send: async () => ({ reply: "单子任务回复" }),
  };
  const res = await agent.tools.call("spawn_agent", { task: "干活", role: "worker" }, { agent });
  assert.equal(res, "单子任务回复");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("spawn_agent 多任务超时返回失败标注 (不崩)", async () => {
  const agent = new PPXAgent({ root: tmp("timeout") });
  agent.llm = { chat: async () => ({ content: "x" }) };
  agent._legion = {
    spawnAgent: () => {},
    send: async () => new Promise((_, rej) => setTimeout(() => rej(new Error("agent 已退出")), 10)),
  };
  const res = await agent.tools.call("spawn_agent", {
    tasks: ["任务A", "任务B"],
  }, { agent });
  assert.ok(res.includes("任务A失败") || res.includes("子任务"), `超时标注, 实际: ${res}`);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("差异化视角注入 system prompt (_perspective)", () => {
  const agent = new PPXAgent({ root: tmp("persp") });
  try {
    const plain = agent._context("普通问题");
    assert.ok(!plain.includes("任务视角"), "无视角时不含注入");
    agent._perspective = "从代码质量角度";
    const withP = agent._context("普通问题");
    assert.ok(withP.includes("【任务视角】从代码质量角度"), `注入差异化视角, 实际: ${withP.slice(0, 300)}`);
  } finally {
    agent.shutdown();
    fs.rmSync(agent.dataDir, { recursive: true, force: true });
  }
});

// ===== SDD review 循环 (Superpowers 子代理驱动开发吸收) =====

test("parseReviewFindings 解析严重级清单", () => {
  const text = "[Critical] 功能不满足需求\n[Important] 缺边界检查\n[Minor] 命名可改进\n中间有干扰文字\n[Important] 第二处";
  const f = parseReviewFindings(text);
  assert.equal(f.length, 4, "只提取 [严重级] 行");
  assert.equal(f[0].severity, "Critical");
  assert.equal(f[0].finding, "功能不满足需求");
  assert.equal(f[1].severity, "Important");
});

test("parseReviewFindings 无发现/空输入返回空数组", () => {
  assert.deepEqual(parseReviewFindings("(无发现)"), []);
  assert.deepEqual(parseReviewFindings(""), []);
  assert.deepEqual(parseReviewFindings(null), []);
  assert.deepEqual(parseReviewFindings("普通文字没有标签"), []);
});

test("needsFix 仅 Critical/Important 触发修复", () => {
  assert.equal(needsFix([{ severity: "Critical", finding: "x" }]), true);
  assert.equal(needsFix([{ severity: "Important", finding: "x" }]), true);
  assert.equal(needsFix([{ severity: "Minor", finding: "x" }]), false);
  assert.equal(needsFix([]), false);
});

test("buildReviewPrompt 含任务/准则/只读约束", () => {
  const p = buildReviewPrompt("实现一个排序函数", "检查正确性与边界", "质量视角");
  assert.ok(p.includes("只读审查"), "含只读约束");
  assert.ok(p.includes("实现一个排序函数"), "含任务");
  assert.ok(p.includes("检查正确性与边界"), "含审查准则");
  assert.ok(p.includes("[严重]"), "含严重级说明 (中文 token)");
});

test("buildFixPrompt 只带 Critical/Important 发现", () => {
  const p = buildFixPrompt("原始任务", [
    { severity: "Critical", finding: "A" },
    { severity: "Minor", finding: "B" },
    { severity: "Important", finding: "C" },
  ]);
  assert.ok(p.includes("[严重] A"), "含严重 (Critical 映射中文)");
  assert.ok(p.includes("[重要] C"), "含重要 (Important 映射中文)");
  assert.ok(!p.includes("Minor"), "不带 Minor");
  assert.ok(!p.includes("次要"), "不带次要");
  assert.ok(p.includes("原始任务"), "含原始任务");
});

test("spawn_agent review: 审查通过直接返回产出 (mock legion)", async () => {
  const agent = new PPXAgent({ root: tmp("revpass") });
  agent.llm = { chat: async () => ({ content: "x" }) };
  let reviewCalls = 0;
  agent._legion = {
    spawnAgent: () => {},
    send: async (name) => {
      if (name.endsWith("_rev")) { reviewCalls++; return { reply: "(无发现)" }; }
      return { reply: "完整实现结果" };
    },
  };
  const res = await agent.tools.call("spawn_agent", { task: "写一个函数", review: true }, { agent });
  assert.ok(res.includes("✅ 审查通过"), `审查通过标记, 实际: ${res}`);
  assert.ok(res.includes("完整实现结果"), "含实施者产出");
  assert.equal(reviewCalls, 1, "审查者只审一次");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("spawn_agent review: 发现问题自动修复一轮后通过", async () => {
  const agent = new PPXAgent({ root: tmp("revfix") });
  agent.llm = { chat: async () => ({ content: "x" }) };
  let implCall = 0, revCall = 0;
  agent._legion = {
    spawnAgent: () => {},
    send: async (name) => {
      if (name.endsWith("_rev")) {
        revCall++;
        return revCall === 1 ? { reply: "[Critical] 缺边界检查\n[Minor] 格式" } : { reply: "(无发现)" };
      }
      implCall++;
      return { reply: implCall === 1 ? "v1 实现" : "v2 修复了边界" };
    },
  };
  const res = await agent.tools.call("spawn_agent", { task: "写函数", review: true, fix_rounds: 3 }, { agent });
  assert.ok(res.includes("✅ 审查通过"), `通过, 实际: ${res.slice(0, 80)}`);
  assert.ok(res.includes("v2 修复了边界"), "实施者被要求修复并产出 v2");
  assert.equal(implCall, 2, "实施者跑两次 (初版+修复)");
  assert.equal(revCall, 2, "审查者审两次 (初版+复审)");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("spawn_agent review: 达修复上限熔断停放未决发现", async () => {
  const agent = new PPXAgent({ root: tmp("revbreak") });
  agent.llm = { chat: async () => ({ content: "x" }) };
  let implCall = 0;
  agent._legion = {
    spawnAgent: () => {},
    send: async (name) => {
      if (name.endsWith("_rev")) return { reply: "[Important] 一直存在的问题" };
      implCall++;
      return { reply: `实现第${implCall}版` };
    },
  };
  const res = await agent.tools.call("spawn_agent", { task: "写函数", review: true, fix_rounds: 2 }, { agent });
  assert.ok(res.includes("⚠️ 审查未通过"), "熔断标记");
  assert.ok(res.includes("2 轮"), "标注修复上限轮数");
  assert.ok(res.includes("[重要] 一直存在的问题"), "未决发现列出交主 agent 裁定 (中文严重级标签)");
  assert.equal(implCall, 3, "初版 + 2 轮修复");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("spawn_agent review: 多任务每任务独立审查后拼接", async () => {
  const agent = new PPXAgent({ root: tmp("revmulti") });
  agent.llm = { chat: async () => ({ content: "x" }) };
  let revCalls = 0;
  agent._legion = {
    spawnAgent: () => {},
    send: async (name) => {
      if (name.endsWith("_rev")) { revCalls++; return { reply: "(无发现)" }; }
      return { reply: `结果:${name.split("_").slice(-2)[0]}` };
    },
  };
  const res = await agent.tools.call("spawn_agent", { tasks: ["任务A", "任务B"], review: true }, { agent });
  assert.ok(res.includes("【子任务1") && res.includes("【子任务2"), `两任务拼接, 实际: ${res.slice(0, 80)}`);
  assert.ok(res.includes("✅ 审查通过"), "两任务均审查通过");
  assert.equal(revCalls, 2, "两个独立审查者各审一次");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("spawn_agent review: 多任务 + arbitrate 聚合各方审查结果", async () => {
  const agent = new PPXAgent({ root: tmp("revarb") });
  agent.llm = { chat: async () => ({ content: "聚合结论: A 方案可行, B 有风险" }) };
  agent._legion = {
    spawnAgent: () => {},
    send: async (name) => {
      if (name.endsWith("_rev")) return { reply: "(无发现)" };
      return { reply: "方案产出" };
    },
  };
  const res = await agent.tools.call("spawn_agent", { tasks: ["评估A", "评估B"], review: true, arbitrate: true, judge: "综合", perspectives: ["风险视角", "成本视角"] }, { agent });
  assert.ok(res.includes("聚合结论"), `仲裁生效, 实际: ${res.slice(0, 80)}`);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("spawn_agent 参数含 review/fix_rounds", () => {
  const agent = new PPXAgent({ root: tmp("revreg") });
  const meta = agent.tools.tools.get("spawn_agent");
  assert.ok(meta.parameters.properties.review, "有 review 参数");
  assert.ok(meta.parameters.properties.fix_rounds, "有 fix_rounds 参数");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

// ===== 只读审查者模式 =====

test("enableReadonlyMode 禁用修改/执行工具, 保留只读工具", () => {
  const agent = new PPXAgent({ root: tmp("readonly") });
  agent.enableReadonlyMode();
  assert.equal(agent.tools.tools.get("run_command").enabled, false, "run_command 禁用");
  assert.equal(agent.tools.tools.get("write_file").enabled, false, "write_file 禁用");
  assert.equal(agent.tools.tools.get("code_act").enabled, false, "code_act 禁用");
  assert.equal(agent.tools.tools.get("spawn_agent").enabled, false, "spawn_agent 禁用");
  assert.equal(agent.tools.tools.get("read_file").enabled, true, "read_file 保留");
  assert.equal(agent.tools.tools.get("memory_search").enabled, true, "memory_search 保留");
  assert.equal(agent.tools.tools.get("list_dir").enabled, true, "list_dir 保留");
  assert.equal(agent.readonly, true, "readonly 标志");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("审查者只读: readonly 下 run_command 调用被拒", async () => {
  const agent = new PPXAgent({ root: tmp("roexec") });
  agent.enableReadonlyMode();
  const res = await agent.tools.call("run_command", { command: "echo hi" }, { agent });
  assert.ok(/未注册|未知工具|disabled|禁用/i.test(res), `readonly 下 run_command 被拒: ${res}`);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

// ===== 方法技能自动触发 (Superpowers: 技能清单注入 system prompt) =====

test("方法技能清单注入 system prompt (_skillsPrompt)", () => {
  // root 指向项目根读 skills/, dataDir 隔离到 tmp (不污染生产数据)
  const agent = new PPXAgent({ root: path.resolve("."), dataDir: tmp("skillctx") });
  try {
    const ctx = agent._context("普通问题");
    assert.ok(ctx.includes("【可用技能】"), `技能清单注入, 实际: ${ctx.slice(0, 300)}`);
    assert.ok(ctx.includes("load_skill"), "提示按需加载");
    assert.ok(ctx.includes("brainstorm") && ctx.includes("verify"), "含方法论技能 (Superpowers)");
  } finally {
    agent.shutdown();
    fs.rmSync(agent.dataDir, { recursive: true, force: true });
  }
});
