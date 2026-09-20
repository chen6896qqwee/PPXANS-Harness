// test/reflect-loop.test.js - B3 反思闭环: 自省闸门拦停 → 经验自动沉淀
// policy 发出 tool/self_review_stop → agent._onPolicyEvent → Experience.learn 记教训
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { Experience } from "../src/memory/experience.js";

function tmp(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-rc-${n}-`)); }

test("reflect: self_review_stop 事件自动沉淀经验教训", () => {
  const agent = new PPXAgent({ root: tmp("ag") });
  assert.ok(agent.experience, "agent 有经验库");
  const before = agent.experience.lessons.length;
  agent._onPolicyEvent("tool/self_review_stop", { reason: "硬拒绝类错误不应重试" });
  assert.ok(agent.experience.lessons.length >= before + 1, "拦停事件应沉淀一条经验");
  const last = agent.experience.lessons[agent.experience.lessons.length - 1];
  assert.ok(last.lesson.includes("不应重试"), `教训含核心语义: ${last.lesson}`);
  assert.ok(last.tags.includes("auto-self-review"), `标签正确: ${last.tags.join(",")}`);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("reflect: 幂等 — 同教训重复触发只会强化 uses 不新增", () => {
  const agent = new PPXAgent({ root: tmp("ag2") });
  const reason = "某命令被安全闸门拦截, 停止重试";
  agent._onPolicyEvent("tool/self_review_stop", { reason });
  const reason2 = "某命令被安全闸门拦截, 停止重试"; // 同理由 → 同教训
  agent._onPolicyEvent("tool/self_review_stop", { reason: reason2 });
  // 教训文本由统一模板拼出, 同 reason 应命中同一 lesson (去重, 不写放大)
  const lessons = agent.experience.lessons.filter((l) => l.lesson.includes(reason));
  assert.equal(lessons.length, 1, `同教训不应重复新增, got ${lessons.length}`);
  // learn 语义: 新增 uses=0, 命中 +1 → 二次触发后 uses=1 即证明走到去重加分而非新增
  assert.ok(lessons[0].uses >= 1, "命中加分 (uses+1): " + lessons[0].uses);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("reflect: 非拦停事件不沉淀经验 (不误记)", () => {
  const agent = new PPXAgent({ root: tmp("ag3") });
  const before = agent.experience.lessons.length;
  agent._onPolicyEvent("tool/error_retry", {});
  agent._onPolicyEvent("tool/overflow", {});
  agent._onPolicyEvent("read_file", {}); // 即使有 reason 字段也不是拦停类型
  assert.equal(agent.experience.lessons.length, before, "非拦停事件不写经验库");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("reflect: 无经验库时调用不崩 (fail-open)", () => {
  const agent = new PPXAgent({ root: tmp("ag4") });
  agent.experience = null; // 模拟经验库缺失
  agent._onPolicyEvent("tool/self_review_stop", { reason: "x" });
  agent._onPolicyEvent("tool/self_review_stop", { reason: "y" });
  assert.ok(true, "经验库缺失不抛错");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("reflect: context() 高频教训浮上来 (经验→长期准则 蒸馏接缝)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-rc-ctx-"));
  const exp = new Experience(dir);
  // 高频复发教训 (uses 高): B3 自动沉淀会反复触发 (同 lesson 去重命中 uses+1)
  exp.learn({ task: "a", lesson: "硬拒绝类错误不应重试, 停下说明", tags: ["auto-self-review"] });
  for (let i = 0; i < 6; i++) exp.learn({ task: "a", lesson: "硬拒绝类错误不应重试, 停下说明", tags: ["auto-self-review"] });
  // learn 用 withFileLock 重读文件生成新对象, 须重新查询而非用写入前捕获的旧引用
  const high = exp.lessons.find((l) => l.lesson.includes("不应重试"));
  assert.ok(high && high.uses >= 6, `复发让 uses 上涨: ${high?.uses}`);
  // 再放一条更新的普通经验
  exp.learn({ task: "b", lesson: "一条普通的新经验", tags: [] });
  const ctx = exp.context();
  const idxHigh = ctx.indexOf("硬拒绝类错误不应重试");
  const idxNew = ctx.indexOf("一条普通的新经验");
  assert.ok(idxHigh !== -1, "高频教训在 context 里");
  assert.ok(idxNew === -1 || idxHigh < idxNew, "高频教训排在前面 (uses 优先于时间)");
  fs.rmSync(dir, { recursive: true, force: true });
});