// test/telegram-channel-2026-11-16.test.js — Telegram 渠道适配器 (fetch 桩, 零真实网络)
// 钉住: _api 错误转译、connect/test 凭证语义、handleUpdate 白名单与 Trigger 工厂、
// 长轮询游标推进、send 分段与 replyTo 只挂首块、disconnect 幂等。
import test from "node:test";
import assert from "node:assert/strict";
import { TelegramChannel, splitTelegramMessage } from "../src/channels/telegram.js";

function useFetch(t, handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(url, opts);
  };
  t.after(() => { globalThis.fetch = orig; });
  return calls;
}
function tgJson(payload) {
  return new Response(JSON.stringify(payload), { status: 200 });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("telegram: _api 成功/失败转译/非JSON体", async (t) => {
  const ch = new TelegramChannel({}, { botToken: "tok" });
  useFetch(t, (url) => tgJson({ ok: true, result: { id: 1, username: "ppx" } }));
  const me = await ch._api("getMe");
  assert.equal(me.username, "ppx");
  useFetch(t, () => tgJson({ ok: false, description: "bad token" }));
  await assert.rejects(ch._api("getMe"), /Telegram getMe 失败: bad token/);
  useFetch(t, () => new Response("oops", { status: 500 }));
  await assert.rejects(ch._api("getMe"), /HTTP 500/);
});

test("telegram: connect 无 token 报错; 有 token 验证凭证", async (t) => {
  const noTok = new TelegramChannel({}, {});
  await assert.rejects(noTok.connect(), /未配置/);
  const ch = new TelegramChannel({}, { botToken: "tok" });
  useFetch(t, () => tgJson({ ok: true, result: { id: 1, username: "ppx" } }));
  await ch.connect();
  assert.equal(ch.connected, true);
  assert.equal(ch.me.username, "ppx");
  await ch.disconnect();
  assert.equal(ch.connected, false);
});

test("telegram: test() 返回 ok/fail 明细", async (t) => {
  const noTok = new TelegramChannel({}, {});
  const missing = await noTok.test();
  assert.equal(missing.ok, false);
  const ch = new TelegramChannel({}, { botToken: "tok" });
  useFetch(t, () => tgJson({ ok: true, result: { id: 1, username: "ppx" } }));
  const ok = await ch.test();
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /@ppx/);
  useFetch(t, () => tgJson({ ok: false, description: "expired" }));
  const fail = await ch.test();
  assert.equal(fail.ok, false);
  assert.match(fail.detail, /expired/);
});

test("telegram: handleUpdate 文本→Trigger, 白名单过滤, 非文本忽略", async (t) => {
  const ch = new TelegramChannel({}, { botToken: "tok" });
  const calls = [];
  ch.handleTrigger = async (trigger) => { calls.push(trigger); return "sent"; };
  useFetch(t, () => tgJson({ ok: true, result: [] }));
  ch._stopped = false;
  const textUpdate = { update_id: 1, message: { message_id: 10, date: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, text: "hi" } };
  await ch.handleUpdate(textUpdate);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "hi");
  assert.equal(ch.lastUser, "7");
  await ch.handleUpdate({ update_id: 2, message: { message_id: 11, date: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, text: null } });
  assert.equal(calls.length, 1, "非文本消息不触发");
  await ch.disconnect();

  const gated = new TelegramChannel({}, { botToken: "tok", allowed_chats: "9" });
  gated.handleTrigger = async (trigger) => { calls.push(trigger); };
  gated._stopped = false;
  await gated.handleUpdate({ update_id: 3, message: { message_id: 12, date: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, text: "no" } });
  assert.equal(calls.length, 1, "白名单外的 chat 不触发");
  await gated.handleUpdate({ update_id: 4, message: { message_id: 13, date: 1, chat: { id: 9, type: "private" }, from: { id: 9 }, text: "yes" } });
  assert.equal(calls.length, 2);
  await gated.disconnect();
});

test("telegram: 长轮询游标推进并分发 updates", async (t) => {
  const ch = new TelegramChannel({}, { botToken: "tok", poll_interval_ms: 60000, poll_timeout_seconds: 1 });
  const calls = [];
  ch.handleTrigger = async (trigger) => { calls.push(trigger); };
  let n = 0;
  useFetch(t, () => {
    n += 1;
    return n === 1
      ? tgJson({ ok: true, result: [{ update_id: 5, message: { message_id: 1, date: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, text: "hello" } }] })
      : tgJson({ ok: true, result: [] });
  });
  ch._stopped = false;
  await ch._pollOnce();
  assert.equal(ch._offset, 6, "offset 应推进到 update_id + 1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "hello");
  await ch.disconnect();
});

test("telegram: 轮询失败进退避并计数", async (t) => {
  const ch = new TelegramChannel({}, { botToken: "tok", poll_interval_ms: 60000 });
  useFetch(t, () => { throw new Error("network down"); });
  ch._stopped = false;
  await ch._pollOnce();
  assert.equal(ch._failStreak, 1);
  await ch.disconnect();
});

test("telegram: send 分段/星号回发/replyTo 只挂首块/缺目标报错", async (t) => {
  const calls = useFetch(t, (url) => tgJson({ ok: true, result: { message_id: calls.length } }));
  const ch = new TelegramChannel({}, { botToken: "tok" });
  const body = "a".repeat(3000) + "\n" + "b".repeat(3000);
  await ch.send("c1", body);
  const sends = calls.filter((c) => c.url.includes("sendMessage"));
  assert.equal(sends.length, 2);
  assert.ok(sends.every((s) => JSON.parse(s.opts.body).chat_id === "c1"));
  assert.equal(JSON.parse(sends[0].opts.body).reply_to_message_id, undefined);

  ch.lastUser = "77";
  await ch.send("*", "回复");
  const star = calls.filter((c) => c.url.includes("sendMessage")).at(-1);
  assert.equal(JSON.parse(star.opts.body).chat_id, "77");

  ch.lastUser = "77";
  const multi = await ch.send("c1", "x".repeat(4500), { replyTo: 99 });
  assert.equal(typeof multi.message_id, "number");
  const all = calls.filter((c) => c.url.includes("sendMessage"));
  const first = JSON.parse(all.at(-2).opts.body);
  const second = JSON.parse(all.at(-1).opts.body);
  assert.equal(first.reply_to_message_id, 99, "replyTo 只挂首块");
  assert.equal(second.reply_to_message_id, undefined);
  assert.ok(all.length >= 5);
  const noTarget = new TelegramChannel({}, { botToken: "tok" });
  await assert.rejects(noTarget.send("", "x"), /缺接收人/);
  const noToken = new TelegramChannel({}, {});
  await assert.rejects(noToken.send("c1", "x"), /未配置 botToken/);
});

test("telegram: disconnect 幂等且清轮询环", async (t) => {
  const ch = new TelegramChannel({}, { botToken: "tok" });
  useFetch(t, () => tgJson({ ok: true, result: [] }));
  await ch.connect();
  await ch.disconnect();
  await ch.disconnect();
  assert.equal(ch.connected, false);
  assert.equal(ch._pollTimer, null);
});
