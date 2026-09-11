// test/wechat-crypto.test.js - 微信消息加解密 (AES-256-CBC + PKCS7 + SHA1)
import test from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import { verifySignature, decryptMsg, encryptMsg, encryptReplyXml, generateSignature } from "../src/channels/wechat-crypto.js";

// 43 字符 encodingAESKey (官方格式)
const KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CORP = "wx1234567890";

test("wechat-crypto: 加密解密往返", () => {
  const enc = encryptMsg(KEY, "你好, 皮皮虾", CORP);
  const { msg, receiveId } = decryptMsg(KEY, `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`);
  assert.equal(msg, "你好, 皮皮虾");
  assert.equal(receiveId, CORP);
});

test("wechat-crypto: 空 receiveId 往返", () => {
  const enc = encryptMsg(KEY, "hello world");
  const { msg, receiveId } = decryptMsg(KEY, `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`);
  assert.equal(msg, "hello world");
  assert.equal(receiveId, "");
});

test("wechat-crypto: SHA1 签名校验", () => {
  const enc = encryptMsg(KEY, "hello", CORP);
  const arr = ["mytoken", "1409659813", "1372623149", enc].sort();
  const sig = crypto.createHash("sha1").update(arr.join("")).digest("hex");
  assert.equal(verifySignature("mytoken", "1409659813", "1372623149", enc, sig), true, "正确签名通过");
  assert.equal(verifySignature("mytoken", "1409659813", "1372623149", enc, "bad"), false, "错误签名拒绝");
});

test("wechat-crypto: 无 Encrypt 抛错", () => {
  assert.throws(() => decryptMsg(KEY, "<xml><ToUserName>xx</ToUserName></xml>"), /无 <Encrypt>/);
});

test("wechat-crypto: 加密回包可被验签并解密回原文", () => {
  const replyXml = "<xml><ToUserName><![CDATA[user]]></ToUserName><Content><![CDATA[你好]]></Content></xml>";
  const out = encryptReplyXml({ encodingAESKey: KEY, token: "mytoken", replyXml, receiveId: CORP });
  // 回包结构完整
  assert.match(out, /<Encrypt><!\[CDATA\[/);
  assert.match(out, /<MsgSignature>/);
  assert.match(out, /<TimeStamp>/);
  assert.match(out, /<Nonce>/);
  // 提取签名并校验
  const enc = (out.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/) || [])[1];
  const sig = (out.match(/<MsgSignature><!\[CDATA\[([\s\S]*?)\]\]><\/MsgSignature>/) || [])[1];
  const ts = (out.match(/<TimeStamp>(\d+)<\/TimeStamp>/) || [])[1];
  const nonce = (out.match(/<Nonce><!\[CDATA\[([\s\S]*?)\]\]><\/Nonce>/) || [])[1];
  assert.equal(verifySignature("mytoken", ts, nonce, enc, sig), true, "回包签名可验");
  // 解密回包得原文
  const { msg } = decryptMsg(KEY, `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`);
  assert.equal(msg, replyXml);
});

test("wechat-crypto: generateSignature 与 verifySignature 同算法", () => {
  const enc = encryptMsg(KEY, "x", CORP);
  const sig = generateSignature("tok", "111", "222", enc);
  assert.equal(verifySignature("tok", "111", "222", enc, sig), true);
});
