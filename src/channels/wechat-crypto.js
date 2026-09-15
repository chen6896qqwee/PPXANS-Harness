// src/channels/wechat-crypto.js - 微信消息加解密 (企业微信/公众号) 零依赖
// 参考官方 WXBizMsgCrypt: AES-256-CBC + PKCS7 填充 + SHA1 签名校验
// 用 Node 原生 crypto, 无任何 npm 依赖。真实联调需企微/公众号凭据 (token + encodingAESKey)。
import crypto from "node:crypto";

// 43 字符 encodingAESKey → 32 字节 AES key (base64, 补 '=' 凑满 32 字节)
function keyOf(encodingAESKey) {
  return Buffer.from(String(encodingAESKey) + "=", "base64");
}

// SHA1 签名校验: sort([token, timestamp, nonce, encrypt]).join("") 的 sha1 与 signature 比对
export function verifySignature(token, timestamp, nonce, encrypt, signature) {
  const arr = [String(token), String(timestamp), String(nonce), String(encrypt)].sort();
  const sha1 = crypto.createHash("sha1").update(arr.join(""), "utf8").digest("hex");
  return sha1 === String(signature);
}

// 生成签名 (加密回包时用, 与 verifySignature 同一算法)
export function generateSignature(token, timestamp, nonce, encrypt) {
  const arr = [String(token), String(timestamp), String(nonce), String(encrypt)].sort();
  return crypto.createHash("sha1").update(arr.join(""), "utf8").digest("hex");
}

// 解密 <Encrypt> → { msg, receiveId } (receiveId 通常为 corpId)
export function decryptMsg(encodingAESKey, encryptedXml) {
  const m = String(encryptedXml).match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/);
  const enc = m ? m[1] : "";
  if (!enc) throw new Error("消息体无 <Encrypt>");
  const key = keyOf(encodingAESKey);
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const dec = Buffer.concat([decipher.update(enc, "base64"), decipher.final()]);
  // PKCS7 去填充
  const pad = dec[dec.length - 1];
  const plain = dec.slice(0, dec.length - pad);
  // 明文格式: random(16) + msgLen(4, 大端) + msg + receiveId
  const msgLen = plain.readUInt32BE(16);
  const msg = plain.slice(20, 20 + msgLen).toString("utf8");
  const receiveId = plain.slice(20 + msgLen).toString("utf8");
  return { msg, receiveId };
}

// 加密回复 → 返回 <Encrypt> 里的 base64 密文 (供拼回复 XML)
export function encryptMsg(encodingAESKey, msg, receiveId = "") {
  const key = keyOf(encodingAESKey);
  const iv = key.slice(0, 16);
  const msgBuf = Buffer.from(String(msg), "utf8");
  const idBuf = Buffer.from(String(receiveId), "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const plain = Buffer.concat([crypto.randomBytes(16), lenBuf, msgBuf, idBuf]);
  // PKCS7 填充到 32 字节倍数
  const padLen = 32 - (plain.length % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

// 加密被动回复: 生成企业微信加密模式回包 XML (含 MsgSignature/TimeStamp/Nonce)
// replyXml = 明文回复 XML, receiveId = corpId (解密时拿到的)
export function encryptReplyXml({ encodingAESKey, token, replyXml, receiveId = "", timestamp = null, nonce = null }) {
  const enc = encryptMsg(encodingAESKey, replyXml, receiveId);
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const nc = nonce ?? Math.random().toString(36).slice(2, 12);
  const sig = generateSignature(token, ts, nc, enc);
  return `<xml>
  <Encrypt><![CDATA[${enc}]]></Encrypt>
  <MsgSignature><![CDATA[${sig}]]></MsgSignature>
  <TimeStamp>${ts}</TimeStamp>
  <Nonce><![CDATA[${nc}]]></Nonce>
</xml>`;
}
