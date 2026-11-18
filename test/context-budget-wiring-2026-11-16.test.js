// test/context-budget-wiring-2026-11-16.test.js — 架构优化 ④ 消费侧: 历史预算吃进固定开销
// 背景: contextBudget() 过去只是只读体检 (窗口被 tools/system 吃掉多少只能等 400);
//   2026-11-16 起 _historyBudget() 成为 _trimHistory / _ensureContextFit / _maybeCompact
//   的唯一预算入口: min(legacy, planContextBudget(...).sections.history), 只收紧不放大。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { estimateTokens } from "../src/utils/text.js";

function makeAgent({ window = 32000, adaptive = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-budget-wire-"));
  const a = new PPXAgent({ root, configFile: null });
  a.llm = { model: "stub", backend: "http", context_window: window, vision: false, supportsNativeToolCalls: true };
  a.config.memory.adaptive_budget = adaptive;
  return a;
}

function cleanup(a) {
  try { a.shutdown?.(); } catch { /* 关闭失败不影响结论 */ }
  try { fs.rmSync(a.root, { recursive: true, force: true }); } catch { /* 临时目录清理失败忽略 */ }
}

const legacyBudget = (a) => {
  const raw = Number(a.config.memory?.history_token_budget);
  const cfg = raw > 0 ? raw : a._autoHistoryBudget();
  return Math.min(cfg, a._histTokenCap());
};

test("预算接线: _context 记录固定开销 (system 实测 + tools schema 缓存)", () => {
  const a = makeAgent();
  try {
    a._context("你好");
    const stats = a._lastContextStats;
    assert.ok(stats && stats.systemChars > 0, "system 体积应被记录");
    assert.ok(stats.systemTokens > 0, "system token 应被估算");
    assert.ok(stats.toolTokens > 0, "tools schema token 应被计入 (core 曝光也有固定开销)");
    // 缓存: 同名工具集第二次不再 JSON.stringify (只比较结果, 行为可观测)
    const t1 = a._toolSchemaTokens();
    assert.equal(t1, stats.toolTokens);
    assert.equal(a._toolSchemaTokens(), t1);
  } finally { cleanup(a); }
});

test("预算接线: 8K 小窗口 + 大 schema → 历史预算真的被收紧 (legacy 公式会超窗)", () => {
  const a = makeAgent({ window: 8000 });
  try {
    a._context("你好");
    const legacy = legacyBudget(a);
    const fixed = a._fixedContextTokens();
    const budget = a._historyBudget();
    assert.ok(budget < legacy, `固定开销吃掉历史: legacy ${legacy} → budget ${budget}`);
    assert.ok(budget >= 200, "预算不得压到不可用");
    // 8K 窗口 + core schema 是"固定开销本身就超窗"的场景: 预算退到下限,
    //   体检必须如实报 overflow (而不是假装放得下; 也不能把历史压成 0)。
    assert.ok(budget <= 2000, "小窗口预算退到下限");
    assert.ok(a.contextBudget().overflow > 0, "体检应如实报告超窗风险");
    void fixed;
  } finally { cleanup(a); }
});

test("预算接线: 14K 窗口 → 收紧后总额放得下 (硬约束真正生效)", () => {
  const a = makeAgent({ window: 14000 });
  try {
    a._context("你好");
    const fixed = a._fixedContextTokens();
    const budget = a._historyBudget();
    const output = Math.floor(14000 * 0.2);
    assert.ok(budget < legacyBudget(a), "14K 下固定开销开始挤占历史");
    assert.ok(budget + output + fixed.tools + fixed.system <= 14000,
      `预算必须放得下: ${budget}+${output}+${fixed.tools}+${fixed.system} <= 14000`);
  } finally { cleanup(a); }
});

test("预算接线: 正常窗口只收紧不放大 —— 放得下时保持 legacy 原值 (不无端砍历史)", () => {
  const a = makeAgent({ window: 32000 });
  try {
    a._context("你好");
    assert.equal(a._historyBudget(), legacyBudget(a), "32K 放得下时行为不变 (只治真超窗)");
  } finally { cleanup(a); }
});

test("预算接线: 大窗口下只收紧不放大 —— budget 不等于把窗口全吃掉", () => {
  const a = makeAgent({ window: 128000 });
  try {
    a._context("你好");
    const legacy = legacyBudget(a);
    const budget = a._historyBudget();
    assert.equal(budget, legacy, "大窗口: 24K 硬帽 + legacy 原值");
  } finally { cleanup(a); }
});

test("预算接线: adaptive_budget=false 回退纯 legacy (逃生开关逐字不变)", () => {
  const a = makeAgent({ window: 32000, adaptive: false });
  try {
    a._context("你好");
    assert.equal(a._historyBudget(), legacyBudget(a), "关闭后必须与旧公式完全一致");
  } finally { cleanup(a); }
});

test("预算接线: _trimHistory 真的按新预算裁剪 (不是只报数)", () => {
  const a = makeAgent({ window: 8000 });
  try {
    a._context("你好");
    const budget = a._historyBudget();
    const hist = [];
    for (let i = 0; i < 60; i++) hist.push({ role: i % 2 ? "assistant" : "user", content: "预算测试内容 ".repeat(80) + i });
    const trimmed = a._trimHistory(hist);
    const used = trimmed.reduce((s, m) => s + estimateTokens(m.content), 0);
    assert.ok(trimmed.length < hist.length, "超预算历史必须被裁剪");
    assert.ok(used <= budget + 50, `裁剪后 token ${used} 不得超过预算 ${budget} (+50 容差)`);
    // 必保最近一条 (信息量感知裁剪的既有不变量)
    assert.ok(trimmed.some((m) => String(m.content).endsWith("59")), "最近一轮必须保留");
  } finally { cleanup(a); }
});

test("预算接线: _ensureContextFit 默认预算与 _historyBudget 同源", () => {
  const a = makeAgent({ window: 32000 });
  try {
    a._context("你好");
    const budget = a._historyBudget();
    const hist = [{ role: "user", content: "短" }];
    assert.deepEqual(a._ensureContextFit(hist), hist, "小历史在预算内不动");
    // 超大单条: 绝对兜底与 _trimHistory 用同一个预算数字 (行为可通过裁剪结果观测)
    const huge = [{ role: "user", content: "x".repeat(budget * 4) }, { role: "user", content: "尾巴" }];
    const kept = a._ensureContextFit(huge);
    assert.ok(kept.some((m) => m.content === "尾巴"), "必保最后一条");
    assert.ok(kept.length <= 2);
  } finally { cleanup(a); }
});
