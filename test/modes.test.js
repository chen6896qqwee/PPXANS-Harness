// test/modes.test.js - 四种新增编排模式的纯函数 + 注册
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseSteps } from "../src/mode/plan-exec.js";
import { matchSkill } from "../src/mode/router.js";
import { Board } from "../src/mode/blackboard.js";
import { normalizeNodes } from "../src/mode/graph.js";
import { SkillLoader } from "../src/skills/loader.js";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

// ---- plan-exec: parseSteps ----
test("parseSteps 解析 JSON 数组", () => {
  assert.deepEqual(parseSteps('["读取配置", "修改端口"]'), ["读取配置", "修改端口"]);
});

test("parseSteps 容忍 markdown 代码块", () => {
  assert.deepEqual(parseSteps('```json\n["a","b"]\n```'), ["a", "b"]);
});

test("parseSteps 非 JSON 返回空", () => {
  assert.deepEqual(parseSteps("第一步：做A\n第二步：做B"), []);
});

// ---- router: matchSkill ----
test("matchSkill 按描述匹配技能", () => {
  const dir = tmpRoot("skill");
  const d = path.join(dir, "memory");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), "---\nname: memory\ndescription: 持久记忆, 记住偏好, 跨会话召回\n---\n# memory\n");
  const loader = new SkillLoader(dir);
  const hit = matchSkill(loader, "帮我记住这个偏好");
  assert.ok(hit);
  assert.equal(hit.name, "memory");
  assert.equal(matchSkill(loader, "今天天气如何"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- blackboard: Board ----
test("Board 读写与快照", () => {
  const b = new Board();
  b.set("task", "分析 A");
  b.set("分析师", "结论 1");
  assert.equal(b.get("task"), "分析 A");
  assert.deepEqual(b.keys().sort(), ["task", "分析师"].sort());
  const snap = b.snapshot();
  assert.equal(snap["分析师"], "结论 1");
});

// ---- graph: normalizeNodes ----
test("normalizeNodes 归一化字符串与对象", () => {
  assert.deepEqual(normalizeNodes(["a", "b"]), [{ name: "a", task: "a" }, { name: "b", task: "b" }]);
  assert.deepEqual(normalizeNodes([{ name: "读配置", task: "读文件" }]), [{ name: "读配置", task: "读文件" }]);
  assert.deepEqual(normalizeNodes("not-array"), []);
});

// ---- 七种模式全部注册 ----
test("PPXAgent 注册全部 7 种模式", () => {
  const root = tmpRoot("modes");
  const agent = new PPXAgent({ root });
  const modes = agent.ctx.consume("modes");
  assert.deepEqual(modes.list().sort(), ["blackboard", "graph", "legion", "plan-exec", "react", "router", "single"].sort());
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- 无 LLM 时各模式兜底 ----
test("无 LLM 时四种新模式均返回字符串兜底", async () => {
  const root = tmpRoot("modes-fallback");
  const agent = new PPXAgent({ root });
  const modes = agent.ctx.consume("modes");
  for (const m of ["plan-exec", "router", "blackboard", "graph"]) {
    const r = await modes.run(m, agent, "你好皮皮虾", { sessionKey: "default" });
    assert.ok(typeof r === "string", `${m} 应返回字符串`);
    assert.ok(r.length > 0);
  }
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
