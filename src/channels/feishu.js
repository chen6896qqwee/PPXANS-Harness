// src/channels/feishu.js - 飞书通道适配器 (零依赖, 原生 fetch)
// 需要配置: app_id, app_secret, verify_token (config/channels.yaml)
// 用法: 飞书开放平台配置事件订阅 URL 指向本服务的 /feishu/webhook
import { Channel } from "./base.js";

export class FeishuChannel extends Channel {
  constructor(agent, { appId, appSecret, verifyToken, webhookPath = "/feishu/webhook" } = {}) {
    super("feishu", agent);
    this.appId = appId || process.env.FEISHU_APP_ID || "";
    this.appSecret = appSecret || process.env.FEISHU_APP_SECRET || "";
    this.verifyToken = verifyToken || process.env.FEISHU_VERIFY_TOKEN || "";
    this.webhookPath = webhookPath;
    this.tenantToken = null;
    this.tokenExpire = 0;
    this.lastUser = null; // 最近收到消息的 open_id, 供主动提醒(广播)回发
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
    const register = httpChannel && typeof httpChannel.registerWebhook === "function"
      ? (path, fn) => httpChannel.registerWebhook(path, fn)
      : (path, fn) => { /* 无主通道时挂到 server (仅路径匹配, 调用方负责防双响应) */ server && server.on?.("request", fn); };
    register(this.webhookPath, async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      // 飞书事件订阅用请求头 X-Lark-Request-Token 携带 verify_token (body 内 token 极少存在, 仅作纵深)
      if (this.verifyToken && req.headers["x-lark-request-token"] !== this.verifyToken) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid token" }));
        return;
      }
      try {
        const out = await this.handleWebhook(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  // 处理飞书 webhook 事件 (事件订阅回调)
  async handleWebhook(body) {
    // 校验 verify_token (纵深防御; 主校验在 mount 的 X-Lark-Request-Token 头)
    const data = typeof body === "string" ? JSON.parse(body) : body;
    if (data.token && data.token !== this.verifyToken) {
      return { code: 1, msg: "invalid token" };
    }
    // URL 验证 (飞书首次配置时)
    if (data.type === "url_verification") {
      return { challenge: data.challenge };
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