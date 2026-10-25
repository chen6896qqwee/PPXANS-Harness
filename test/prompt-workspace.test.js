// test/prompt-workspace.test.js — system prompt 必须告诉模型"工作目录在哪" (2026-10-05)
// 病根: 工具 schema 一路写"路径相对工作目录", 但组装出的 system prompt 从没给出该目录的
// 绝对路径, 也从没说明"任务点名的文件就在里面"。真跑基准里 fix-syntax 因此 clarify 反问
// 人类要 broken.js 的位置, analyze-and-report 一次 read_file 都没发就凭猜写了报告。
// 这里守卫三件事: 段落存在 / 内容是绝对 root + 两条纪律 / 它位于静态前缀区 (前缀缓存不退化)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-prompt-${tag}-`));
const agentAt = (root) => new PPXAgent({ root, dataDir: path.join(root, ".ppx") });

test("【工作目录】段落注入, 且给出 root 的绝对路径", () => {
  const root = mk("ws");
  const agent = agentAt(root);
  try {
    const ctx = agent._context("修复 broken.js 的语法错误");
    assert.ok(ctx.includes("【工作目录】"), "应注入工作目录段");
    assert.ok(ctx.includes(path.resolve(root)), `应含绝对路径 ${path.resolve(root)}`);
    // 两条行为纪律都在: 点名文件先自己找 / 先读后改并确认落盘
    assert.match(ctx, /read_file \/ search_files \/ list_dir/, "应给出定位文件的手段");
    assert.ok(ctx.includes("不要向用户反问路径"), "应禁止反问路径");
    assert.match(ctx, /改文件前先 read_file/, "应先读后改");
    assert.match(ctx, /确认落盘/, "应要求确认写入结果");
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("【工作目录】位于静态前缀区: 换问题时它及它之前的内容逐字一致", () => {
  const root = mk("static");
  const agent = agentAt(root);
  try {
    const c1 = agent._context("如何优化内存回收机制");
    const c2 = agent._context("帮我写一个 JavaScript 快速排序实现");
    const i1 = c1.indexOf("【工作目录】");
    const i2 = c2.indexOf("【工作目录】");
    assert.ok(i1 >= 0 && i1 === i2, "同一段应出现在完全相同的位置 (静态)");
    // 工作目录段及其之前的全部内容 = 可缓存前缀的一部分, 必须逐字一致
    const endOfBlock = c1.indexOf("\n\n", i1);
    assert.equal(c1.slice(0, endOfBlock), c2.slice(0, endOfBlock));
    // 且必须在静态区 (前半段), 不能被挤到末尾的检索段之后
    assert.ok(i1 / c1.length < 0.5, `工作目录段应在前缀区, 实际位置 ${(i1 / c1.length).toFixed(2)}`);
    // root 恒定时, 同一 agent 两次组装完全一致 (纯静态)
    assert.equal(agent._workspacePrompt(), agent._workspacePrompt());
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("换 root 的 agent 各自报对自己的目录 (子 agent / 沙箱根不串)", () => {
  const r1 = mk("r1");
  const r2 = mk("r2");
  const a1 = agentAt(r1);
  const a2 = agentAt(r2);
  try {
    assert.ok(a1._workspacePrompt().includes(path.resolve(r1)));
    assert.ok(a2._workspacePrompt().includes(path.resolve(r2)));
    assert.notEqual(a1._workspacePrompt(), a2._workspacePrompt());
  } finally {
    a1.shutdown(); a2.shutdown();
    fs.rmSync(r1, { recursive: true, force: true });
    fs.rmSync(r2, { recursive: true, force: true });
  }
});

// 2026-10-05 真跑复盘 (fix-logic / write-function): 模型只在回复里贴代码从不落盘, 且把
// clarify 当"复述任务"的第一步烧掉整个回合。守卫新增纪律句在组装后的 system prompt 里,
// 且仍位于静态前缀区 (root 每进程恒定, 前缀缓存不退化)。语言无关: 句子只点名工具, 不偏袒任何语言。
test("落盘纪律 + 反 clarify-first 句已注入且位于静态前缀", () => {
  const root = mk("disc");
  const agent = agentAt(root);
  try {
    const c1 = agent._context("把 calc.js 的 add 修好");
    const c2 = agent._context("写一个 sum 函数放到 utils.js");
    assert.match(c1, /write_file 或 apply_patch 落盘后再作答/, "应要求真正落盘后再作答");
    assert.match(c1, /贴代码不算完成/, "应声明只在回复里贴代码不算完成");
    assert.match(c1, /clarify 不是第一步/, "应阻止把 clarify 当复述型第一步");
    assert.doesNotMatch(agent._workspacePrompt(), /java/i, "工作目录段须语言无关, 不点名具体语言");
    // 静态区: 同一 agent 换问题, 新句出现位置与所在段逐字一致
    assert.equal(c1.indexOf("clarify 不是第一步"), c2.indexOf("clarify 不是第一步"));
    const i = c1.indexOf("clarify 不是第一步");
    assert.ok(i / c1.length < 0.5, `新句应在前缀区, 实际位置 ${(i / c1.length).toFixed(2)}`);
    assert.equal(agent._workspacePrompt(), agent._workspacePrompt(), "root 恒定则段落恒定 (纯静态)");
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
