// src/channels/wechat.js - 微信通道适配器 (企业微信/公众号 webhook)
// 已实现:
//   - 加密消息解密 (AES-256-CBC) + 验签 (wechat-crypto.js)
//   - 明文/加密模式被动回复 (加密模式回包 encryptReplyXml)
//   - 主动推送 send(): 企业微信应用消息 API (corp_id + corp_secret + agent_id)
// 凭据: 接收回调用 token + encodingAESKey; 主动推送用 corp_id + corp_secret + agent_id
//   (config.channels.wechat 或环境变量 WECHAT_*)
import { Channel } from "./base.js";
import { decryptMsg, verifySignature, encryptReplyXml } from "./wechat-crypto.js";

export class WechatWebhookChannel extends Channel {
  constructor(agent, {
    path = "/wechat/webhook",
    token = "",
    encodingAESKey = "",
    corpId = "",
    corpSecret = "",
    agentId = "",
  } = {}) {
    super("wechat", agent);
    this.path = path;
    this.token = token || process.env.WECHAT_WEBHOOK_TOKEN || "";
    this.encodingAESKey = encodingAESKey || process.env.WECHAT_ENCODING_AES_KEY || "";
    // 主动推送凭据 (企业微信应用消息)
    this.corpId = corpId || process.env.WECHAT_CORP_ID || "";
    this.corpSecret = corpSecret || process.env.WECHAT_CORP_SECRET || "";
    this.agentId = agentId || process.env.WECHAT_AGENT_ID || "";
    this.accessToken = null;
    this.tokenExpire = 0;
    this.lastUser = null; // 最近收到消息的用户 ID, 供主动提醒(广播)回发
  }

  async connect() {
    this.connected = true;
    return this;
  }

  // 连通性测试: 配置了主动推送凭据则验证 access_token; 仅回调模式返回提示
  async test() {
    if (!this.corpId || !this.corpSecret) {
      return { ok: true, detail: "回调模式配置完整 (回调无法离线探测, 需公网/平台侧验证); 未配置主动推送凭据 (corp_id/corp_secret/agent_id)" };
    }
    try {
      const token = await this._getAccessToken();
      return { ok: true, detail: `企业微信推送通道通 (access_token 获取成功, ${String(token).slice(0, 6)}...)` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }

  // 把 /wechat/webhook 挂到 HTTP server (webhook 型通道, 支持明文/加密回包 + GET echostr URL 验证)
  // v1.0.8: 注册到 HttpChannel 的 webhook 路由 (单一 request handler 分发); 支持 GET echostr
  mount(server, httpChannel = null) {
    const register = httpChannel && typeof httpChannel.registerWebhook === "function"
      ? (path, fn) => httpChannel.registerWebhook(path, fn)
      : (path, fn) => { server && server.on?.("request", fn); };
    register(this.path, async (req, res) => {
      const u = new URL(req.url || "/", "http://localhost");
      let body = "";
      if (req.method === "POST") {
        for await (const c of req) body += c;
      }
      const query = {
        msg_signature: u.searchParams.get("msg_signature") || "",
        timestamp: u.searchParams.get("timestamp") || "",
        nonce: u.searchParams.get("nonce") || "",
        echostr: u.searchParams.get("echostr") || "",
      };
      try {
        const out = await this.handleWebhook(body, query);
        if (out.xml) { res.writeHead(200, { "Content-Type": "text/xml" }); res.end(out.xml); }
        else if (typeof out === "string") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(out); } // echostr 明文回显 (企业微信 URL 验证要求)
        else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out)); }
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  // 企业微信回调: URL query 带 msg_signature/timestamp/nonce; body 为 XML
  // 加密模式: 外层 XML 含 <Encrypt>, 解密得内层明文消息
  // v1.0.8 安全加固: 配置了 token 时所有模式都必须验签 (明文/加密/echostr), 防伪造消息驱动 agent
  async handleWebhook(body, query = {}) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const { msg_signature, timestamp, nonce } = query;

    // URL 验证 (GET echostr, 明文模式验签后直接回显)
    if (query.echostr) {
      if (this.token) {
        if (!msg_signature) return { error: "缺少 msg_signature" };
        const ok = verifySignature(this.token, timestamp || "", nonce || "", query.echostr, msg_signature);
        if (!ok) return { error: "签名校验失败" };
      }
      return query.echostr;
    }

    // 加密消息: 验签 + 解密 + 加密回包
    if (/<Encrypt>/.test(raw)) {
      const enc = (raw.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/) || [])[1] || "";
      // 配置了 token 就必须验签 (防无 token 时跳过)
      if (this.token) {
        if (!msg_signature) return { error: "缺少 msg_signature" };
        const ok = verifySignature(this.token, timestamp || "", nonce || "", enc, msg_signature);
        if (!ok) return { error: "签名校验失败" };
      }
      if (!this.encodingAESKey) return { error: "未配置 encodingAESKey, 无法解密" };
      const { msg, receiveId } = decryptMsg(this.encodingAESKey, raw);
      const reply = await this._replyFromXml(msg);
      // 加密模式: 把明文回复 XML 加密成回包 (含签名/时间戳/随机数)
      if (reply.xml) {
        return { xml: encryptReplyXml({
          encodingAESKey: this.encodingAESKey,
          token: this.token,
          replyXml: reply.xml,
          receiveId,
          timestamp: timestamp || null,
          nonce: nonce || null,
        }) };
      }
      return reply;
    }

    // 明文 XML 模式: 配置了 token 就必须验签 (防伪造消息)
    if (/<Content>/.test(raw)) {
      if (this.token) {
        if (!msg_signature) return { error: "缺少 msg_signature" };
        const ok = verifySignature(this.token, timestamp || "", nonce || "", raw, msg_signature);
        if (!ok) return { error: "签名校验失败" };
      }
      return this._replyFromXml(raw);
    }

    return { error: "未识别的微信消息" };
  }

  // 从明文 XML 提取文本并生成被动回复
  async _replyFromXml(xml) {
    const g = (tag) => ((String(xml).match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`)) || [])[1] || "").trim();
    const text = g("Content");
    if (!text) return { error: "无文本内容" };
    const reply = await this.agent.chat(text);
    const toUser = g("FromUserName");
    if (toUser) this.lastUser = toUser; // 记录最近联系人, 供主动提醒回发
    const fromUser = g("ToUserName");
    return {
      xml: `<xml>
  <ToUserName><![CDATA[${toUser}]]></ToUserName>
  <FromUserName><![CDATA[${fromUser}]]></FromUserName>
  <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${reply}]]></Content>
</xml>`,
    };
  }

  // 获取企业微信 access_token (主动推送用), 带缓存
  async _getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpire) return this.accessToken;
    if (!this.corpId || !this.corpSecret) {
      throw new Error("微信主动推送未配置: 需 corp_id + corp_secret (config.channels.wechat 或环境变量 WECHAT_CORP_ID/WECHAT_CORP_SECRET)");
    }
    const r = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.corpSecret)}`,
      { signal: AbortSignal.timeout(15000) },
    );
    const data = await r.json();
    if (data.errcode !== 0) throw new Error(`微信 access_token 失败: ${data.errmsg} (errcode=${data.errcode})`);
    this.accessToken = data.access_token;
    this.tokenExpire = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  // 主动推送 (企业微信应用消息): 需 corp_id + corp_secret + agent_id; to="*" 时回最近联系人
  async send(to, text) {
    const token = await this._getAccessToken();
    if (!this.agentId) {
      throw new Error("微信主动推送未配置 agent_id (config.channels.wechat.agent_id 或环境变量 WECHAT_AGENT_ID)");
    }
    const target = !to || to === "*" ? this.lastUser : to;
    if (!target) throw new Error("微信主动推送缺接收人: 先收到过一条用户消息记录用户 ID, 或用 send(userId, ...)");
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: String(target),
        msgtype: "text",
        agentid: Number(this.agentId),
        text: { content: String(text) },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (data.errcode !== 0) throw new Error(`微信发送失败: ${data.errmsg} (errcode=${data.errcode})`);
    return data;
  }
}
