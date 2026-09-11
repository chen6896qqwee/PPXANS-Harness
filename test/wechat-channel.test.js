// test/wechat-channel.test.js - 微信通道 (主动推送 + 加密回包)
import test from "node:test";
import assert from "node:assert";
import { WechatWebhookChannel } from "../src/channels/wechat.js";
import { decryptMsg, verifySignature, generateSignature, encryptMsg } from "../src/channels/wechat-crypto.js";

const KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CORP = "wx1234567890";

function stubAgent() {
  return {
    chat: async (text) => `回复:${text}`,
  };
}

// 构造一个带凭据的微信通道
function makeChannel(agent = stubAgent(), overrides = {}) {
  return new WechatWebhookChannel(agent, {
    token: "mytoken",
    encodingAESKey: KEY,
    corpId: "wxcorp",
    corpSecret: "secret123",
    agentId: "1000002",
    ...overrides,
  });
}

// 生成带合法签名的 query (v1.0.8: 配置 token 后必须验签)
function authedQuery(body, ts = "1", nonce = "2") {
  return { msg_signature: generateSignature("mytoken", ts, nonce, body), timestamp: ts, nonce };
}

test("微信通道: 加密 webhook 解密并返回加密回包", async () => {
  const ch = makeChannel();
  const plain = "<xml><ToUserName><![CDATA[from]]></ToUserName><FromUserName><![CDATA[to]]></FromUserName><Content><![CDATA[你好]]></Content></xml>";
  const enc = encryptMsg(KEY, plain, CORP);
  const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
  const out = await ch.handleWebhook(body, authedQuery(enc));

  assert.ok(out.xml, "返回加密回包 XML");
  assert.match(out.xml, /<Encrypt><!\[CDATA\[/);
  // 解密回包内层, 应含助手回复文本
  const innerEnc = (out.xml.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/) || [])[1];
  const { msg } = decryptMsg(KEY, `<xml><Encrypt><![CDATA[${innerEnc}]]></Encrypt></xml>`);
  assert.match(msg, /回复:你好/);
});

test("微信通道: 明文 webhook 返回明文回复 XML", async () => {
  const ch = makeChannel();
  const body = "<xml><ToUserName><![CDATA[from]]></ToUserName><FromUserName><![CDATA[to]]></FromUserName><Content><![CDATA[hi]]></Content></xml>";
  const out = await ch.handleWebhook(body, authedQuery(body));
  assert.ok(out.xml, "返回明文回复 XML");
  assert.match(out.xml, /回复:hi/);
  assert.doesNotMatch(out.xml, /<Encrypt>/);
});

test("微信通道: 配置 token 后无签名/错误签名拒绝 (防伪造消息)", async () => {
  const ch = makeChannel();
  const body = "<xml><ToUserName><![CDATA[from]]></ToUserName><FromUserName><![CDATA[to]]></FromUserName><Content><![CDATA[hi]]></Content></xml>";
  // 无签名
  const noSig = await ch.handleWebhook(body, {});
  assert.match(noSig.error || "", /msg_signature/, "缺签名拒绝");
  // 错误签名
  const badSig = await ch.handleWebhook(body, { msg_signature: "deadbeef", timestamp: "1", nonce: "2" });
  assert.match(badSig.error || "", /签名校验失败/, "错签名拒绝");
  // 正确签名放行
  const ok = await ch.handleWebhook(body, authedQuery(body));
  assert.ok(ok.xml, "正确签名放行");
});

test("微信通道: 未配置 encodingAESKey 时加密消息报错", async () => {
  const ch = makeChannel(stubAgent(), { encodingAESKey: "" });
  const enc = encryptMsg(KEY, "<xml><Content><![CDATA[x]]></Content></xml>", CORP);
  const out = await ch.handleWebhook(`<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`, authedQuery(enc));
  assert.match(out.error, /encodingAESKey/);
});

test("微信通道: send 主动推送 (mock fetch)", async () => {
  const ch = makeChannel();
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("/gettoken")) {
      return { json: async () => ({ errcode: 0, access_token: "AT_123", expires_in: 7200 }) };
    }
    return { json: async () => ({ errcode: 0, msgid: "m1" }) };
  };
  try {
    const r = await ch.send("zhangsan", "你好");
    assert.equal(r.msgid, "m1");
    assert.equal(calls.length, 2, "先取 token 再发消息");
    assert.match(calls[0].url, /gettoken/);
    const msgBody = JSON.parse(calls[1].opts.body);
    assert.equal(msgBody.touser, "zhangsan");
    assert.equal(msgBody.agentid, 1000002);
    assert.equal(msgBody.text.content, "你好");
  } finally {
    globalThis.fetch = orig;
  }
});

test("微信通道: send 未配置凭据时抛中文引导", async () => {
  const ch = makeChannel(stubAgent(), { corpId: "", corpSecret: "" });
  await assert.rejects(() => ch.send("x", "hi"), /corp_id \+ corp_secret/);
});
