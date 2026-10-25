// src/channels/feishu.js - 飞书通道适配器 (零依赖, 原生 fetch)
// 需要配置: app_id, app_secret, verify_token (config/channels.yaml)
// 用法: 飞书开放平台配置事件订阅 URL 指向本服务的 /feishu/webhook
// 2026-10-24 加固 (对齐飞书开放平台"Encrypt Key 加密配置"官方规范):
//   ① encrypt_key 事件解密: AES-256-CBC, key=SHA256(encrypt_key), IV=密文前 16 字节, PKCS7 填充
//   ② 签名校验: X-Lark-Signature = sha256(timestamp+nonce+body+encrypt_key) (配了 encrypt_key 即强制)
//   ③ 防重放: event_id 去重缓存 (TTL 5 分钟), 重投递不再触发对话
import crypto from "node:crypto";
import { Channel } from "./base.js";

// 官方算法: base64 解码 → 前 16 字节为 IV, 其余为密文; key = sha256(encrypt_key)
// 2026-10-24 (R2) 修正: Node 的 decipher.final() 已自动去除 PKCS7 填充 (auto-padding 默认开),
//   此前 final() 之后又手动按尾字节剥一次 —— 遇到正文恰以 0x01-0x10 字节结尾的内容会误删真实数据。
export function feishuDecrypt(encryptKey, encrypt) {
  const buf = Buffer.from(String(encrypt || ""), "base64");
  if (buf.length <= 16) throw new Error("飞书加密事件密文过短");
  const key = crypto.createHash("sha256").update(String(encryptKey), "utf8").digest();
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString("utf8");
}

// 官方签名: sha256(timestamp + nonce + body + encrypt_key) 的 hex
export function feishuSign({ timestamp, nonce, body, encryptKey }) {
  return crypto.createHash("sha256")
    .update(String(timestamp) + String(nonce) + String(body) + String(encryptKey), "utf8")
    .digest("hex");
}

export class FeishuChannel extends Channel {
  constructor(agent, { appId, appSecret, verifyToken, encryptKey, encrypt_key, webhookPath = "/feishu/webhook" } = {}) {
    super("feishu", agent);
    this.appId = appId || process.env.FEISHU_APP_ID || "";
    this.appSecret = appSecret || process.env.FEISHU_APP_SECRET || "";
    this.verifyToken = verifyToken || process.env.FEISHU_VERIFY_TOKEN || "";
    this.encryptKey = encryptKey || encrypt_key || process.env.FEISHU_ENCRYPT_KEY || "";
    this.webhookPath = webhookPath;
    this.tenantToken = null;
    this.tokenExpire = 0;
    this.lastUser = null; // 最近收到消息的 open_id, 供主动提醒(广播)回发
    this._seenEvents = new Map(); // 防重放: event_id -> 首见时间 (TTL 清扫)
  }

  // 2026-10-10 (S6): 未配 verify_token 时是否允许放行 —— 仅当显式 opt-in
  _allowUnauthenticated() {
    return this.agent?.config?.security?.allow_unauthenticated_webhooks === true;
  }

  // 主动提醒广播 (to="*") 时回最近联系人; 无记录则报缺接收人
  _resolveTarget(to) {
    const target = !to || to === "*" ? this.lastUser : to;
    return target || null;
  }

  async _getTenantToken() {
    if (this.tenantToken && Date.now() < this.tokenExpire) return this.tenantToken;
    const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(15000), // v1.0.8: 网络挂起不永久阻塞
    });
    const data = await r.json();
    if (data.code !== 0) throw new Error(`飞书 token 失败: ${data.msg}`);
    this.tenantToken = data.tenant_access_token;
    this.tokenExpire = Date.now() + (data.expire - 60) * 1000;
    return this.tenantToken;
  }

  async connect() {
    if (!this.appId || !this.appSecret) {
      throw new Error("飞书通道未配置: 需要 app_id + app_secret (config/channels.yaml 或环境变量)");
    }
    await this._getTenantToken(); // 验证凭证
    this.connected = true;
    return this;
  }

  // 连通性测试: 用已配置凭证换取 tenant token (真实网络验证)
  async test() {
    if (!this.appId || !this.appSecret) {
      return { ok: false, detail: "未配置 app_id + app_secret" };
    }
    try {
      const token = await this._getTenantToken();
      return { ok: true, detail: `飞书凭证有效 (tenant_token 获取成功, ${String(token).slice(0, 6)}...)` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }

  // 把 /feishu/webhook 挂到 HTTP server (webhook 型通道)
  // v1.0.8: 注册到 HttpChannel 的 webhook 路由 (单一 request handler 分发, 无多 listener 竞态);
  // 校验飞书事件订阅头 X-Lark-Request-Token
  mount(server, httpChannel = null) {
    const register = this._registrar(server, httpChannel);
    register(this.webhookPath, async (req, res) => {
      const body = await this._readBody(req);
      // 2026-10-10 安全修复 (S6): 未配置 verify_token = 无法鉴权 = fail closed (原为完全放行)。
      //   本地调试需显式设 security.allow_unauthenticated_webhooks=true。
      if (!this.verifyToken) {
        if (this._allowUnauthenticated()) {
          try { return this._sendJson(res, 200, await this.handleWebhook(body)); }
          catch (e) { return this._sendJson(res, 500, { error: e.message }); }
        }
        return this._sendJson(res, 403, { error: "未配置 verify_token, 拒绝处理 webhook。本地调试请设 security.allow_unauthenticated_webhooks=true" });
      }
      // 飞书事件订阅用请求头 X-Lark-Request-Token 携带 verify_token (body 内 token 极少存在, 仅作纵深)
      if (req.headers["x-lark-request-token"] !== this.verifyToken) {
        return this._sendJson(res, 403, { error: "令牌无效" });
      }
      // 2026-10-24: 签名校验 (配了 encrypt_key 即强制) —— timestamp+nonce+body+encrypt_key 的 sha256。
      //   防伪造请求源; 与防重放 (handleWebhook 内 event_id 去重) 互补。
      if (this.encryptKey) {
        const ts = req.headers["x-lark-request-timestamp"] || "";
        const nonce = req.headers["x-lark-request-nonce"] || "";
        const sig = req.headers["x-lark-signature"] || "";
        const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
        if (!ts || !sig) return this._sendJson(res, 403, { error: "缺少飞书签名头 (X-Lark-Request-Timestamp/X-Lark-Signature)" });
        if (feishuSign({ timestamp: ts, nonce, body: bodyStr, encryptKey: this.encryptKey }) !== sig) {
          return this._sendJson(res, 403, { error: "签名校验失败" });
        }
      }
      try {
        return this._sendJson(res, 200, await this.handleWebhook(body));
      } catch (e) {
        return this._sendJson(res, 500, { error: e.message });
      }
    });
  }

  // 处理飞书 webhook 事件 (事件订阅回调)
  async handleWebhook(body) {
    let data = typeof body === "string" ? JSON.parse(body) : body;
    // 2026-10-24: 加密事件解密 (官方 Encrypt Key 规范) —— 配置了 encrypt_key 时,
    //   飞书把整个事件体包成 {encrypt: <base64>}。未配密钥却收到密文 = fail closed。
    if (data && typeof data.encrypt === "string") {
      if (!this.encryptKey) return { code: 1, msg: "收到加密事件但未配置 encrypt_key" };
      try {
        data = JSON.parse(feishuDecrypt(this.encryptKey, data.encrypt));
      } catch (e) {
        return { code: 1, msg: "事件解密失败: " + e.message };
      }
    }
    // 校验 verify_token (纵深防御; 主校验在 mount 的 X-Lark-Request-Token 头)
    if (data.token && data.token !== this.verifyToken) {
      return { code: 1, msg: "令牌无效" };
    }
    // URL 验证 (飞书首次配置时)
    if (data.type === "url_verification") {
      return { challenge: data.challenge };
    }
    // 2026-10-24: 防重放 —— 同一 event_id 5 分钟内只处理一次 (飞书至少一次投递会重发)。
    //   v2 schema 的 event_id 在 header.event_id; 旧 schema 落到 event.event_id / message_id。
    const eventId = data.header?.event_id || data.event_id || data.event?.message?.message_id || null;
    if (eventId) {
      this._sweepSeenEvents();
      if (this._seenEvents.has(eventId)) return { code: 0, msg: "duplicate" };
      this._seenEvents.set(eventId, Date.now());
    }
    // 事件: 消息
    const event = data.event;
    if (event && event.type === "im.message.receive_v1" && event.message) {
      const text = event.message.content ? JSON.parse(event.message.content).text || "" : "";
      const openId = event.sender?.sender_id?.open_id || "";
      if (openId) this.lastUser = openId; // 记录最近联系人, 供主动提醒回发
      if (text) {
        const reply = await this.agent.chat(text);
        await this.send(openId || "*", reply);
      }
    }
    return { code: 0 };
  }

  // 防重放缓存清扫: 过期剔除 + 容量上限 (防长跑进程内存膨胀)
  _sweepSeenEvents({ ttlMs = 5 * 60 * 1000, maxEntries = 5000 } = {}) {
    const now = Date.now();
    for (const [k, t] of this._seenEvents) {
      if (now - t > ttlMs) this._seenEvents.delete(k);
    }
    if (this._seenEvents.size > maxEntries) {
      const excess = this._seenEvents.size - maxEntries;
      let i = 0;
      for (const k of this._seenEvents.keys()) { if (i++ >= excess) break; this._seenEvents.delete(k); }
    }
  }

  async send(to, text) {
    const target = this._resolveTarget(to);
    if (!target) throw new Error("飞书主动推送缺接收人: 先收到过一条用户消息记录 open_id, 或用 send(openId, ...)");
    const token = await this._getTenantToken();
    const r = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ receive_id: target, msg_type: "text", content: JSON.stringify({ text }) }),
      signal: AbortSignal.timeout(15000), // v1.0.8: 网络挂起不永久阻塞
    });
    const data = await r.json();
    if (data.code !== 0) throw new Error(`飞书发送失败: ${data.msg}`);
    return data;
  }
}