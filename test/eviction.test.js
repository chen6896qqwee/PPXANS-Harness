import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { scan, status, loadState } from "../src/ans/eviction.js";

function tmp(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-evict-${n}-`)); }

test("Eviction: 空记忆扫描零异常", () => {
  const agent = new PPXAgent({ root: tmp("empty") });
  const r = scan(agent);
  assert.equal(r.total, 0);
  assert.equal(r.redundant.length, 0);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Eviction: 高相似记忆识别为冗余候选", () => {
  const agent = new PPXAgent({ root: tmp("dup") });
  agent.facts.add("止损设置为5%后清仓离场", { importance: 10 });
  agent.facts.add("止损5%触发后清仓离场", { importance: 8 });
  const r = scan(agent);
  assert.ok(r.total >= 2, "应有至少2条记忆");
  assert.ok(r.redundantCount >= 1, "高相似对应被识别为冗余, got "+r.redundantCount);
  // 保真对比: importance 高者 (第一条) 应保留
  const red = r.redundant.find((x) => x.importance < 10);
  assert.ok(red, "低 importance 那条被标为冗余候选");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Eviction: 治理状态持久化", () => {
  const root = tmp("persist");
  const agent = new PPXAgent({ root });
  agent.facts.add("止损5%清仓离场", { importance: 5 });
  agent.facts.add("止损5%后清仓离场", { importance: 6 });
  const r = scan(agent);
  assert.ok(r.redundantCount >= 1);
  // 状态已存盘
  assert.ok(loadState(agent).lastRun, "state 有 lastRun");
  assert.equal(loadState(agent).lastRun.total, r.total);
  const st = status(agent);
  assert.ok(st.lastRun, "status 可读");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("Eviction: agent 暴露入口 (runMemoryEviction + evictionStatus)", () => {
  const agent = new PPXAgent({ root: tmp("api") });
  agent.facts.add("记忆内容ABCDE", { importance: 10 });
  const r = agent.runMemoryEviction();
  assert.ok(typeof r === "object" && "total" in r, "runMemoryEviction 返回报告");
  const st = agent.evictionStatus();
  assert.ok(st && typeof st === "object", "evictionStatus 可读");
  // 每日治理任务应已注册 (幂等防重复)
  const jobs = agent.scheduler ? agent.scheduler.list() : [];
  const evJ = jobs.filter((j) => j.name === "eviction-daily");
  assert.ok(evJ.length <= 1, "每日排遗任务不重复注册");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});