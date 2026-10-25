// test/refine.test.js - 自我进化闭环 refine (轨迹 → 经验 → 注入上下文)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

function makeAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-refine-"));
  return new PPXAgent({ root, configFile: null });
}

test("refine: 回放失败轨迹, LLM 提炼经验进经验库", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: "教训: 命令要加引号避免空格截断" }) };
  a.traces.read = () => [
    { ok: false, tool: "run_command", error: "EACCES" },
    { ok: false, tool: "read_file", error: "ENOENT" },
  ];
  let learned = null;
  a.experience.learn = (x) => { learned = x; };
  const r = await a.refine({ limit: 10 });
  assert.equal(r.distilled, 1);
  assert.ok(r.lesson.includes("引号"), "应提炼出教训");
  assert.ok(learned && learned.lesson.includes("引号"), "经验库应收到教训");
  assert.deepEqual(learned.tags, ["auto-refine"]);
});

test("refine: 失败轨迹不足则跳过", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: "不应被调用" }) };
  a.traces.read = () => [{ ok: true, tool: "get_time" }];
  const r = await a.refine({ limit: 10 });
  assert.equal(r.distilled, 0);
  assert.ok(r.reason);
});

test("refine: 无 LLM 跳过", async () => {
  const a = makeAgent();
  a.llm = null;
  const r = await a.refine();
  assert.equal(r.distilled, 0);
  assert.equal(r.reason, "无 LLM");
});

test("refineSkill: 高频成功工具 → 提炼并落盘 SKILL.md", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: '{"name":"file-reader","description":"批量读文件","content":"## 流程\\n1. 确认目标文件路径存在\\n2. 调用 read_file 读取内容\\n3. 检查返回是否为空, 空则报路径错误\\n## 反合理化\\n路径不存在却说为空 = 偷懒\\n## 验证\\n输出读取的文件完整内容"}' }) };
  a.traces.read = () => [
    { ok: true, tool: "read_file", result: "a" },
    { ok: true, tool: "read_file", result: "b" },
    { ok: true, tool: "list_dir", result: "c" },
  ];
  const r = await a.refineSkill({ limit: 10, minFreq: 2 });
  assert.equal(r.created, 1);
  assert.equal(r.name, "file-reader");
  const skillPath = path.join(a.root, "skills", "file-reader", "SKILL.md");
  assert.ok(fs.existsSync(skillPath), "SKILL.md 应已落盘");
  const content = fs.readFileSync(skillPath, "utf8");
  assert.ok(content.includes("file-reader"), "frontmatter 应含 name");
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test("refineSkill: 成功轨迹不足则跳过", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: "不应被调用" }) };
  a.traces.read = () => [{ ok: true, tool: "get_time" }];
  const r = await a.refineSkill({ minFreq: 2 });
  assert.equal(r.created, 0);
  assert.equal(r.reason, "成功轨迹不足");
});

test("refineSkill: 无重复成功工具模式则跳过", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: "不应被调用" }) };
  a.traces.read = () => [
    { ok: true, tool: "read_file", result: "a" },
    { ok: true, tool: "list_dir", result: "b" },
  ];
  const r = await a.refineSkill({ minFreq: 2 });
  assert.equal(r.created, 0);
  assert.equal(r.reason, "无重复成功工具模式");
});

test("refine 工具已注册 (失败→经验闭环接线)", () => {
  const a = makeAgent();
  assert.ok(a.tools.has("refine"), "refine 工具应已注册");
  assert.ok(a.tools.has("refine_skill"), "refine_skill 工具应已注册");
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test("refine 工具调用 agent.refine 提炼经验", async () => {
  const a = makeAgent();
  let called = false;
  a.refine = async () => { called = true; return { distilled: 1, lesson: "测试教训" }; };
  const res = await a.tools.call("refine", { limit: 10 }, { agent: a });
  assert.ok(called, "refine 工具应调用 agent.refine");
  assert.ok(res.includes("distilled"), "应返回 JSON 结果: " + res);
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});
