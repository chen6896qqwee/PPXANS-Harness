// test/evolve.test.js - 自进化引擎 (src/selfheal/evolve.js)
// 验证: 1) 累计 every_calls 次工具调用后触发提炼  2) 失败轨迹→调用 refine 学经验
//       3) 计数不足时跳过  4) 无 LLM 跳过  5) 可配置关闭
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { EvolutionEngine } from "../src/selfheal/evolve.js";

function makeAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-evolve-"));
  return new PPXAgent({ root, configFile: null });
}

// 铺 N 条失败轨迹 + 放行 traces.read
function seedTraces(a, { fail = 0, ok = 0 } = {}) {
  const arr = [
    ...Array.from({ length: fail }, (_, i) => ({ ok: false, tool: "run_command", error: "boom" + i })),
    ...Array.from({ length: ok }, (_, i) => ({ ok: true, tool: "read_file", result: "r" + i })),
  ];
  a.traces.read = () => arr;
  return arr;
}

test("evolve: 达到 every_calls 次后触发 refine (失败→经验)", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: "教训: 检查路径存在再读文件" }) };
  seedTraces(a, { fail: 2 });
  let refined = 0;
  a.refine = async () => { refined++; return { distilled: 1, lesson: "x" }; };
  a.refineSkill = async () => ({ created: 0 });
  const ev = new EvolutionEngine(a, { every_calls: 3, min_interval_ms: 0 });
  ev.tick(); ev.tick();              // 不足 3 次
  assert.equal(refined, 0, "计数不足不应触发");
  ev.tick();                          // 第 3 次 → 触发
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(refined, 1, "达到次数应触发一次 refine");
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});

test("evolve: 成功轨迹充足时也触发 refineSkill (成功→技能)", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: '{"name":"reader","description":"d","content":"c"}' }) };
  seedTraces(a, { ok: 3 });
  let skilled = 0;
  a.refine = async () => ({ distilled: 0 });
  a.refineSkill = async () => { skilled++; return { created: 1, name: "reader" }; };
  const ev = new EvolutionEngine(a, { every_calls: 1, min_interval_ms: 0 });
  ev.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(skilled, 1, "成功轨迹足够应触发 refineSkill");
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});

test("evolve: 节流 - 同一次间隔内不重复触发", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: "x" }) };
  seedTraces(a, { fail: 2 });
  let refined = 0;
  a.refine = async () => { refined++; return { distilled: 1 }; };
  a.refineSkill = async () => ({ created: 0 });
  const ev = new EvolutionEngine(a, { every_calls: 1, min_interval_ms: 100000 }); // 大间隔
  ev.tick(); ev.tick(); ev.tick();    // 多次 tick
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(refined, 1, "节流期内只应触发一次");
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});

test("evolve: 无 LLM 时安全跳过", async () => {
  const a = makeAgent();
  a.llm = null;
  const ev = new EvolutionEngine(a, { every_calls: 1, min_interval_ms: 0 });
  let called = 0;
  a.refine = async () => { called++; };
  ev.tick(); ev.tick();
  assert.equal(called, 0, "无 LLM 不应提炼");
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});

test("evolve: enabled=false 完全禁用", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: "x" }) };
  seedTraces(a, { fail: 2 });
  let called = 0;
  a.refine = async () => { called++; return { distilled: 1 }; };
  a.refineSkill = async () => ({ created: 0 });
  const ev = new EvolutionEngine(a, { enabled: false, every_calls: 1, min_interval_ms: 0 });
  ev.tick(); ev.tick();
  assert.equal(called, 0, "关闭后不应提炼");
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});