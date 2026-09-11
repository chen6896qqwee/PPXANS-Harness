import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryTicker } from "../src/memory/memory-ticker.js";
import { FactStore } from "../src/memory/fact-store.js";
import { SessionStore } from "../src/memory/session.js";

function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(),"ppx-ex-")); }

test("P1#9: 高信号对话触发 extractor 提炼", async () => {
  const d = tmp();
  const facts = new FactStore(d, {});
  const sess = new SessionStore(d);
  const mt = new MemoryTicker(d, facts, null, sess);
  let extracted = 0;
  mt.setExtractor(async (u, a) => { extracted++; return ["用户偏好实时数据", "用户关注A股"]; });
  await mt.recordTurn("我关注A股，偏好实时数据", "好的，我会记住");
  assert.ok(extracted >= 1, "高信号应触发提取");
  // 提炼结果应入 fact store
  const q = facts.query("实时数据", { limit: 5 });
  assert.ok(q.some((f) => f.content.includes("实时数据")), "提炼结果已入记忆");
});

test("P1#9: 低信号(寒暄)不触发 extractor, 退回启发式", async () => {
  const d = tmp();
  const facts = new FactStore(d, {});
  const sess = new SessionStore(d);
  const mt = new MemoryTicker(d, facts, null, sess);
  let extracted = 0;
  mt.setExtractor(async () => { extracted++; return []; });
  await mt.recordTurn("你好", "在的兄弟");
  assert.equal(extracted, 0, "寒暄不触发 LLM 提炼");
});

test("P1#9: 无 extractor 时退回启发式 addMemory", async () => {
  const d = tmp();
  const facts = new FactStore(d, {});
  const sess = new SessionStore(d);
  const mt = new MemoryTicker(d, facts, null, sess);
  const before = facts.count();
  await mt.recordTurn("我喜欢看A股盘面", "好");
  assert.ok(facts.count() > before, "启发式仍能存记忆");
});
