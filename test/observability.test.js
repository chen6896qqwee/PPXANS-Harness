// test/observability.test.js - 可观测性: agent.stats() 聚合 + 各层 stats()
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-obs-")); }

test("stats: agent.stats() 聚合记忆 L0-L3 / 工具 / 经验 / 轨迹", () => {
  const a = new PPXAgent({ root: tmp() });
  a.facts.add("兄弟喜欢量化交易", { source: "conversation" });
  const s = a.stats();
  assert.ok(s.agent && s.agent.name, "含 agent 信息");
  assert.ok(s.memory, "含 memory 分组");
  assert.ok(s.memory.l0 && typeof s.memory.l0.events_total === "number", "L0 事件数");
  assert.equal(s.memory.l1.total, 1, "L1 事实数");
  assert.equal(s.memory.l1.by_source.conversation, 1, "L1 来源分布");
  assert.ok(typeof s.memory.l2.scenes === "number", "L2 场景数");
  assert.ok(s.memory.l3, "L3 画像");
  assert.ok(typeof s.tools.total === "number", "工具总数");
  assert.ok(typeof s.experience.lessons === "number", "经验数");
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test("stats: 顶层展平 traces 字段 (向后兼容 web 前端)", () => {
  const a = new PPXAgent({ root: tmp() });
  const s = a.stats();
  assert.ok("count" in s, "顶层 count (traces 展平)");
  assert.ok("failed" in s, "顶层 failed");
  assert.ok("failRate" in s, "顶层 failRate");
  assert.ok(Array.isArray(s.slowTools), "顶层 slowTools");
  assert.equal(s.count, 0, "无轨迹时 count=0");
  assert.equal(s.failRate, "0%", "无轨迹时 failRate=0%");
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test("stats: FactStore.stats 来源分布 + PersonaStore.stats 更新时间", () => {
  const a = new PPXAgent({ root: tmp() });
  a.facts.add("x", { source: "conversation" });
  a.facts.add("y", { source: "document" });
  const fsStats = a.facts.stats();
  assert.equal(fsStats.by_source.conversation, 1);
  assert.equal(fsStats.by_source.document, 1);
  assert.equal(fsStats.total, 2);
  const ps = a.personaStore.stats();
  assert.ok(ps.user_updated, "用户画像更新时间非空");
  assert.ok(ps.agent_updated, "agent 画像更新时间非空");
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test("stats: traces.stats 空数据返回完整结构", () => {
  const a = new PPXAgent({ root: tmp() });
  const t = a.traces.stats();
  assert.equal(t.count, 0);
  assert.equal(t.failed, 0);
  assert.equal(t.failRate, "0%");
  assert.deepEqual(t.slowTools, []);
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});
