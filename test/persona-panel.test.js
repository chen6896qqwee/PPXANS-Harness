// test/persona-panel.test.js - 个性化面板后端契约 (2026-11-18, WorkBuddy 式对话体验吸收)
// 钉四件事:
//   1) agent.reply_style 进通用设置白名单且可校验 (回复风格注入的数据通道)
//   2) 【回复风格】静态段真的进 system prompt (非空才注入)
//   3) bot.manage personaRead/personaWrite 读写 config/identity.md + ishiki.md 并热重载 persona
//   4) GET /api/persona.preview 返回真实组装的 system prompt (且不污染 _lastContextStats)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateSettings, getSettings } from "../src/config/settings.js";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";

function tmpRoot(tag, cfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-persona-${tag}-`));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify(cfg));
  return root;
}

async function withChannel(fn) {
  const root = tmpRoot("api", { channels: { http: { mcp: { enabled: false } } } });
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`, { root, agent, channel: ch });
  } finally {
    await ch.disconnect();
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const auth = { Authorization: "Bearer tok", "Content-Type": "application/json" };

test("reply_style: 白名单内可写可读, 非字符串/超长被拒", () => {
  const root = tmpRoot("style");
  try {
    const s = updateSettings(root, { agent: { reply_style: "简洁直接, 先结论后证据" } });
    assert.equal(s.agent.reply_style, "简洁直接, 先结论后证据", "写入后安全视图可见");
    const again = getSettings(root);
    assert.equal(again.agent.reply_style, "简洁直接, 先结论后证据", "落盘后重读仍在");
    assert.throws(() => updateSettings(root, { agent: { reply_style: 123 } }), /字符串/);
    assert.throws(() => updateSettings(root, { agent: { reply_style: "x".repeat(2001) } }), /2000/);
    // 空串合法 = 不注入
    const empty = updateSettings(root, { agent: { reply_style: "" } });
    assert.equal(empty.agent.reply_style, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("【回复风格】静态段注入: 非空进 system prompt, 空则零 token", () => {
  const root = tmpRoot("inject", { agent: { reply_style: "只给结论和证据, 不要客套" } });
  const agent = new PPXAgent({ root, dataDir: path.join(root, ".ppx") });
  try {
    const ctx = agent._context("帮我看看这段代码");
    assert.ok(ctx.includes("【回复风格】"), "非空时应注入回复风格段");
    assert.ok(ctx.includes("只给结论和证据"), "段内应含用户设定的原文");
    // 静态段: 两次组装位置恒定 (前缀缓存契约)
    const ctx2 = agent._context("换一个问题");
    assert.equal(ctx.indexOf("【回复风格】"), ctx2.indexOf("【回复风格】"));
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("【回复风格】未设置时不占位", () => {
  const root = tmpRoot("nostyle");
  const agent = new PPXAgent({ root, dataDir: path.join(root, ".ppx") });
  try {
    assert.equal(agent._replyStylePrompt(), "", "空配置返回空串");
    assert.ok(!agent._context("问题").includes("【回复风格】"));
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bot.manage personaWrite/personaRead: 落盘 + persona 热重载", { timeout: 20000 }, async () => {
  await withChannel(async (base, { root, agent }) => {
    const wr = await fetch(base + "/api/bot.manage", {
      method: "POST", headers: auth,
      body: JSON.stringify({ action: "personaWrite", identity: "测试身份: 沙盘皮皮虾", ishiki: "- 沙盘性格" }),
    });
    const wj = await wr.json();
    assert.equal(wj.ok, true, "写入应成功");
    // 落盘验证 (写盘统一补尾换行)
    assert.equal(fs.readFileSync(path.join(root, "config", "identity.md"), "utf8"), "测试身份: 沙盘皮皮虾\n");
    assert.equal(fs.readFileSync(path.join(root, "config", "ishiki.md"), "utf8"), "- 沙盘性格\n");
    // 热重载验证: persona 实例已读到新内容, 下轮 system prompt 即生效
    assert.ok(agent.persona.identity.includes("沙盘皮皮虾"), "persona.identity 应热重载");
    assert.ok(agent.persona.systemPrompt("测试").includes("沙盘皮皮虾"));
    // 读回验证
    const rd = await fetch(base + "/api/bot.manage", {
      method: "POST", headers: auth, body: JSON.stringify({ action: "personaRead" }),
    });
    const rj = await rd.json();
    assert.equal(rj.ok, true);
    assert.equal(rj.identity, "测试身份: 沙盘皮皮虾\n", "personaRead 原样返回文件内容");
    assert.equal(rj.ishiki, "- 沙盘性格\n");
    // 人为空内容不写盘 (identity 缺省 → 不动文件)
    const none = await fetch(base + "/api/bot.manage", {
      method: "POST", headers: auth, body: JSON.stringify({ action: "personaWrite" }),
    });
    assert.equal(none.status, 400, "没有任何内容时应 400");
  });
});

test("GET /api/persona.preview 返回真实组装的 system prompt, 且不留 _lastContextStats 痕", { timeout: 20000 }, async () => {
  await withChannel(async (base, { agent }) => {
    const r = await fetch(base + "/api/persona.preview", { headers: auth });
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(j.chars > 0, "预览应有内容");
    assert.ok(j.preview.includes("【工作目录】"), "预览 = 真实 _context 输出 (含工作目录段)");
    assert.ok(j.preview.includes(agent.root.replace(/\\/g, "\\\\")) || j.preview.includes("工作目录"), "应含 root 相关内容");
    // 预览不污染历史预算: _lastContextStats 快照/恢复
    assert.equal(agent._lastContextStats, undefined, "预览前无 stats, 预览后仍应无");
    // 未授权拒绝
    const noAuth = await fetch(base + "/api/persona.preview");
    assert.notEqual(noAuth.status, 200);
  });
});
