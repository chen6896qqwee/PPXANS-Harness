import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { Lifecycle } from "../src/ans/lifecycle.js";
import { isExpired } from "../src/ans/proactive.js";

function tmp(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-ans-${n}-`)); }

// ---- 价值对齐 ----
test("价值对齐: 默认 values 注入 system context", () => {
  const agent = new PPXAgent({ root: tmp("va") });
  assert.ok(Array.isArray(agent.config.agent.values), "有默认核心价值数组");
  assert.ok(agent.config.agent.values.length >= 3, "默认价值足够");
  const ctx = agent._context("你好");
  assert.ok(ctx.includes("核心价值"), "system 注入核心价值区");
  assert.ok(ctx.includes("保护用户隐私"), "默认价值文本在 context 里");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("价值对齐: 自定义 values 覆盖默认", () => {
  const root = tmp("va2");
  // 写入自定义 config 覆盖 values
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ agent: { values: ["永远不泄露密钥"] } }));
  const agent = new PPXAgent({ root });
  assert.deepEqual(agent.config.agent.values, ["永远不泄露密钥"], "自定义 values 生效");
  const ctx = agent._context("x");
  assert.ok(ctx.includes("永远不泄露密钥"));
  assert.ok(!ctx.includes("保护用户隐私"), "默认值被覆盖");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- 自主任务生成 ----
test("主动任务生成: 有待办记忆时返回建议 (无 LLM 走启发式)", async () => {
  const agent = new PPXAgent({ root: tmp("pa") });
  agent.facts.add("记得下周要研究 A 股策略", { importance: 15 });
  const msg = await agent.proactiveSuggest();
  assert.ok(msg, "有待办时返回主动提醒");
  assert.ok(msg.includes("A 股策略"), "提醒包含待办内容");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("主动任务生成: 无待办记忆返回 null", async () => {
  const agent = new PPXAgent({ root: tmp("pb") });
  agent.facts.add("今天天气不错", { importance: 5 });
  const msg = await agent.proactiveSuggest();
  assert.equal(msg, null, "无待办信号不打扰");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("主动任务生成: 定时器默认开启(温和), 显式关闭后不启动", () => {
  const agent = new PPXAgent({ root: tmp("pc") });
  const timer = agent.startProactiveTicker(() => {});
  assert.ok(timer, "默认 enabled=true 启动定时器(温和默认)");
  agent.stopProactiveTicker();
  assert.equal(agent._proactiveTimer, null, "可停止");
  agent.config.agent.proactive = { enabled: false, interval_ms: 60000 };
  assert.equal(agent.startProactiveTicker(() => {}), null, "显式 enabled=false 不启动");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

// ---- 主动提醒去重 + 完成跟踪 (P1) ----
test("主动提醒去重: 同待办在窗口内不重复提醒", async () => {
  const agent = new PPXAgent({ root: tmp("pd") });
  const f = agent.facts.add("记得下周研究 A 股策略", { importance: 15 });
  const first = await agent.proactiveSuggest();
  assert.ok(first, "首次提醒");
  // 立即再次调用: 24h 窗口内应返回 null (去重)
  const second = await agent.proactiveSuggest();
  assert.equal(second, null, "窗口内不重复提醒");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("主动提醒完成跟踪: markTaskDone 后不再提醒", async () => {
  const agent = new PPXAgent({ root: tmp("pe") });
  const f = agent.facts.add("记得备份数据", { importance: 15 });
  await agent.proactiveSuggest(); // 首次提醒 (已记录)
  assert.ok(agent.proactiveMarkDone(f.id), "标记完成");
  // 即使窗口已过 (模拟), done 的待办永不提醒
  assert.equal(await agent.proactiveSuggest(), null, "已完成待办不再提醒");
  // 不存在的 id 标记失败
  assert.equal(agent.proactiveMarkDone("f_not_exist"), false, "未知 id 返回 false");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

// ---- 过期待办过滤 (v1.0.7) ----
test("过期待办: 含'昨天'或已过日期的不提醒", () => {
  assert.ok(isExpired("昨天要交的报告"), "昨天 → 过期");
  assert.ok(isExpired("上周说要买的书"), "上周 → 过期");
  assert.ok(isExpired("记得 2020-01-01 的事"), "过去日期 → 过期");
  assert.ok(!isExpired("记得明天提交周报"), "明天 → 不过期");
  assert.ok(!isExpired("记得下周研究 A 股策略"), "下周 → 不过期");
});

// ---- 生命周期 ----
test("生命周期: born → growing → mature", () => {
  const agent = new PPXAgent({ root: tmp("lc") });
  assert.equal(agent.lifecycle.stage, "born", "构造后 born");
  for (let i = 0; i < 11; i++) agent._lifecycleTick();
  assert.equal(agent.lifecycle.chats, 11, "对话计数");
  assert.equal(agent.lifecycle.stage, "mature", "11 次后 mature");
  const st = agent.lifecycleStatus();
  assert.equal(st.stage, "mature");
  assert.equal(st.chats, 11);
  assert.ok(Array.isArray(st.recent) && st.recent.length >= 2, "阶段日志");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("生命周期: 进化和繁衍计数", () => {
  const agent = new PPXAgent({ root: tmp("lc2") });
  agent.lifecycle.evolved += 1;
  agent.lifecycle.reproduced += 1;
  const st = agent.lifecycleStatus();
  assert.equal(st.evolved, 1);
  assert.equal(st.reproduced, 1);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

// ---- 生命周期持久化 (P1: 跨进程/重启不归零) ----
test("生命周期持久化: 状态落盘, 新实例恢复 stage/chats", () => {
  const root = tmp("lc3");
  const a1 = new PPXAgent({ root });
  for (let i = 0; i < 11; i++) a1._lifecycleTick(); // → mature, chats=11
  a1.lifecycle.evolve(2);
  a1.lifecycle.reproduce(1);
  a1.shutdown();
  // 模拟重启: 重新构造 agent, 生命周期状态应从磁盘恢复
  const a2 = new PPXAgent({ root });
  assert.equal(a2.lifecycle.stage, "mature", "重启后 stage 不归零");
  assert.equal(a2.lifecycle.chats, 11, "重启后计数保持");
  assert.equal(a2.lifecycle.evolved, 2, "进化计数保持");
  assert.equal(a2.lifecycle.reproduced, 1, "繁衍计数保持");
  const st = a2.lifecycleStatus();
  assert.equal(st.stage, "mature");
  a2.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("生命周期持久化: 独立 file 参数可用, 文件缺失用初始状态", () => {
  const dir = tmp("lc4");
  const file = path.join(dir, "memory", "lifecycle.json");
  const lc = new Lifecycle({ file });
  assert.equal(lc.stage, "born", "文件不存在 → born");
  lc.tick();
  lc.tick();
  lc.to("mature", "手动晋级");
  const lc2 = new Lifecycle({ file });
  assert.equal(lc2.stage, "mature", "同文件新实例恢复阶段");
  assert.equal(lc2.chats, 2, "同文件新实例恢复计数");
  fs.rmSync(dir, { recursive: true, force: true });
});
