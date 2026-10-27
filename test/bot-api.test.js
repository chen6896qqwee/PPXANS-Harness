// test/bot-api.test.js - 本体 (bot) 形态接口与档案
//
// 2026-10-27 前端改为 bot 形态时新增。这里钉的不是「界面好不好看」, 而是三件会真出事的事:
//   1) 档案写坏不能让界面崩 —— 人肉编辑 profile.json 是设计允许的行为, 打错一个括号不该白屏
//   2) 写操作必须走白名单 —— 前端传错字段不能把 settings 写成脏数据
//   3) 轨迹必须合并两个来源 —— 只读工具调用那一路, 没调工具的那天轨迹页就是空白
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotStore, BUILTIN_TYPES } from "../src/web/bot-store.js";
import { buildBotState, buildTraces, listTraceDays } from "../src/web/bot-api.js";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-bot-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config", "ppx.json"),
    JSON.stringify({ channels: { http: { mcp: { enabled: false } } } }),
  );
  return root;
}

async function withChannel(fn) {
  const root = mkRoot();
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
  }
}

const auth = { Authorization: "Bearer tok", "Content-Type": "application/json" };

// ---------- 档案 ----------

test("档案: 空目录自动派生一个默认本体, 并落盘", () => {
  const root = mkRoot();
  try {
    const store = new BotStore({ root, dataDir: path.join(root, "data") });
    const prof = store.ensure({ name: "皮皮虾", root });
    assert.equal(prof.bots.length, 1);
    assert.equal(prof.bots[0].id, "default");
    assert.equal(prof.bots[0].name, "皮皮虾");
    assert.equal(prof.bots[0].type, "assistant");
    assert.ok(fs.existsSync(store.file), "档案应落盘");
    // 内置四种类型恒在
    for (const t of BUILTIN_TYPES) {
      assert.ok(prof.types.some((x) => x.id === t.id), `缺少内置类型 ${t.id}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("档案: 坏 JSON 不抛错, 退回默认并留一份 .broken 备份", () => {
  const root = mkRoot();
  try {
    const dir = path.join(root, "data", "bots");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "profile.json"), "{ 这不是 JSON ");
    const store = new BotStore({ root, dataDir: path.join(root, "data") });
    const prof = store.load({ root });
    assert.equal(prof.bots.length, 1, "坏档应退回默认档案");
    // 第一次 ensure 时会把坏文件挪成 .broken
    store.ensure({ root });
    assert.ok(fs.existsSync(path.join(dir, "profile.json.broken")), "应保留损坏文件副本");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("档案: settings 走白名单, 不认识的 key 直接丢弃", () => {
  const root = mkRoot();
  try {
    const store = new BotStore({ root, dataDir: path.join(root, "data") });
    const prof = store.apply("settings", { patch: { limits: { maxToolCalls: 7 }, 恶意字段: "x", __proto__: { a: 1 } } });
    assert.equal(prof.settings.limits.maxToolCalls, 7);
    assert.equal(Object.prototype.hasOwnProperty.call(prof.settings, "恶意字段"), false);
    // 数值越界被夹到合法区间
    const p2 = store.apply("settings", { patch: { limits: { maxToolCalls: -5, dailyMinutes: 99999 } } });
    assert.equal(p2.settings.limits.maxToolCalls, 0, "负数应夹到 0");
    assert.equal(p2.settings.limits.dailyMinutes, 1440, "超上限应夹到 1440");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("档案: 日程增删改 + 内置类型不可删", () => {
  const root = mkRoot();
  try {
    const store = new BotStore({ root, dataDir: path.join(root, "data") });
    const p1 = store.apply("agendaAdd", { text: "看一遍 CI" });
    assert.equal(p1.agenda.length, 1);
    const id = p1.agenda[0].id;
    const p2 = store.apply("agendaDone", { agendaId: id });
    assert.equal(p2.agenda[0].done, true);
    const p3 = store.apply("agendaRemove", { agendaId: id });
    assert.equal(p3.agenda.length, 0);

    assert.throws(() => store.apply("typeRemove", { typeId: "assistant" }), /内置类型不可删除/);
    assert.throws(() => store.apply("type", { typeId: "不存在" }), /未知类型/);
    assert.throws(() => store.apply("rename", { name: "   " }), /名字不能为空/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("档案: 自定义类型删掉后, 用着它的本体回落到助手", () => {
  const root = mkRoot();
  try {
    const store = new BotStore({ root, dataDir: path.join(root, "data") });
    const p1 = store.apply("typeAdd", { name: "校对员", blurb: "抓错别字" });
    const custom = p1.types.find((t) => !t.builtin);
    assert.ok(custom, "应新增自定义类型");
    store.apply("type", { typeId: custom.id });
    const p3 = store.apply("typeRemove", { typeId: custom.id });
    assert.equal(p3.types.some((t) => t.id === custom.id), false);
    assert.equal(p3.bots[0].type, "assistant", "悬空类型引用应回落");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("档案: 头像按内容类型校验, 非法扩展名与超大文件被拒", () => {
  const root = mkRoot();
  try {
    const store = new BotStore({ root, dataDir: path.join(root, "data") });
    store.ensure({ root });
    store.saveAvatar("default", Buffer.from("fake-png"), ".png");
    assert.ok(store.avatarPath("default"), "保存后应能取到头像路径");
    assert.throws(() => store.saveAvatar("default", Buffer.from("x"), ".svg"), /仅支持/);
    assert.throws(() => store.saveAvatar("default", Buffer.alloc(5 * 1024 * 1024), ".png"), /4MB/);
    // 换格式时旧文件要清掉, 否则 avatarPath 会先命中旧扩展名
    store.saveAvatar("default", Buffer.from("fake-jpg"), ".jpg");
    assert.ok(store.avatarPath("default").endsWith(".jpg"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 轨迹 ----------

test("轨迹: 合并工具调用与事件流, 按时间倒序, 统计分开计数", () => {
  const root = mkRoot();
  try {
    const dir = path.join(root, "data", "logs", "traces");
    fs.mkdirSync(dir, { recursive: true });
    const day = "2026-01-02";
    fs.writeFileSync(path.join(dir, `${day}.jsonl`), [
      JSON.stringify({ ts: "2026-01-02T10:00:00.000Z", tool: "read_file", args: { path: "a.md" }, ok: true, durationMs: 12 }),
      JSON.stringify({ ts: "2026-01-02T10:00:05.000Z", tool: "run_command", args: { cmd: "npm test" }, ok: false, durationMs: 900, error: "exit 1" }),
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(dir, `events-${day}.jsonl`), [
      JSON.stringify({ ts: "2026-01-02T10:00:02.000Z", type: "tool/err0r_retry", round: 2, ok: true }),
    ].join("\n") + "\n");

    const out = buildTraces({ root, dataDir: path.join(root, "data") }, day, 100);
    assert.equal(out.day, day);
    assert.equal(out.stats.tools, 2);
    assert.equal(out.stats.notes, 1);
    assert.equal(out.stats.failed, 1);
    assert.equal(out.events.length, 3);
    // 时间倒序: 10:00:05 > 10:00:02 > 10:00:00
    assert.equal(out.events[0].name, "run_command");
    assert.equal(out.events[1].name, "tool/err0r_retry");
    assert.equal(out.events[2].name, "read_file");
    // detail 恒为参数摘要, 失败原因单独放 error —— 由前端决定显示哪一个
    assert.match(out.events[0].detail, /npm test/);
    assert.equal(out.events[0].error, 'exit 1');
    assert.ok(out.days.includes(day), "可用日期应包含刚写的这一天");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("轨迹: 没有记录时给空数组与零统计, 不抛错", () => {
  const root = mkRoot();
  try {
    const out = buildTraces({ root, dataDir: path.join(root, "data") }, "2020-01-01", 50);
    assert.deepEqual(out.events, []);
    assert.equal(out.stats.count, 0);
    assert.deepEqual(listTraceDays({ root, dataDir: path.join(root, "data") }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- HTTP ----------

test("接口: /api/bot.state 未带令牌返回 401 (不能开成匿名接口)", { timeout: 20000 }, async () => {
  await withChannel(async (base) => {
    const r = await fetch(base + "/api/bot.state");
    assert.equal(r.status, 401);
  });
});

test("接口: /api/bot.state 返回完整快照", { timeout: 20000 }, async () => {
  await withChannel(async (base) => {
    const r = await fetch(base + "/api/bot.state", { headers: auth });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(j.bot && j.bot.id, "应有当前本体");
    assert.ok(Array.isArray(j.types) && j.types.length >= 4, "应带类型列表");
    assert.ok(j.settings && j.settings.limits, "应带设置");
    assert.ok(j.live && typeof j.live.tone === "string", "应带运行态与状态色");
    assert.ok(Array.isArray(j.services), "应带服务列表");
    assert.ok(j.memory && typeof j.memory.factCount === "number", "应带记忆计数");
    // 版本号不能是 null: 文档里让人 `node bin/ppx-web.js` 直接起, 那条路径没有
    // npm_package_version, 只信环境变量会让设置页「关于」永远显示空。
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(j.version, pkg.version, "版本号应来自 package.json 而非环境变量");
  });
});

test("接口: POST /api/bot.manage 改名生效, 非法类型被拒", { timeout: 20000 }, async () => {
  await withChannel(async (base, { agent }) => {
    const r = await fetch(base + "/api/bot.manage", {
      method: "POST", headers: auth, body: JSON.stringify({ action: "rename", name: "小虾" }),
    });
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.state.bot.name, "小虾");
    // 落盘了才算数
    const onDisk = JSON.parse(fs.readFileSync(path.join(agent.dataDir, "bots", "profile.json"), "utf8"));
    assert.equal(onDisk.bots[0].name, "小虾");

    const bad = await fetch(base + "/api/bot.manage", {
      method: "POST", headers: auth, body: JSON.stringify({ action: "type", typeId: "nope" }),
    });
    assert.equal(bad.status, 400);
    const bj = await bad.json();
    assert.equal(bj.ok, false);
    assert.match(bj.error, /未知类型/);
  });
});

test("接口: /api/bot.traces 带 day 参数可翻历史", { timeout: 20000 }, async () => {
  await withChannel(async (base, { agent }) => {
    const dir = path.join(agent.dataDir, "logs", "traces");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2026-01-05.jsonl"),
      JSON.stringify({ ts: "2026-01-05T01:00:00.000Z", tool: "list_dir", ok: true, durationMs: 3, args: { path: "." } }) + "\n");
    const r = await fetch(base + "/api/bot.traces?day=2026-01-05", { headers: auth });
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.day, "2026-01-05");
    assert.equal(j.stats.tools, 1);
    assert.equal(j.events[0].name, "list_dir");
  });
});

test("接口: buildBotState 直调也能出快照 (不依赖 HTTP 层)", { timeout: 20000 }, async () => {
  await withChannel(async (base, { channel }) => {
    const j = buildBotState(channel);
    assert.equal(j.ok, true);
    assert.equal(j.bot.id, "default");
    assert.ok(j.live.tools.total > 0, "应取到工具数");
  });
});
