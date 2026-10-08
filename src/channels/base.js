// src/channels/base.js - 通道基类
// 统一通道接口: 每个通道实现 connect/send/disconnect
// 可选能力: test() 连通性探测 (配置是否可用), mount(server) 把 webhook 路由挂到 HTTP server
import { readBody, sendJson } from "../utils/http.js";

export class Channel {
  constructor(name, agent) {
    this.name = name;
    this.agent = agent;
    this.connected = false;
  }

  async connect() { throw new Error(`${this.name}: connect() 未实现`); }
  async send(to, text) { throw new Error(`${this.name}: send() 未实现`); }
  async disconnect() { this.connected = false; }

  // 连通性测试: 默认尝试 connect (验证配置能建立连接), 返回 { ok, detail }
  // 需要网络探测的通道可覆盖为更细的校验 (如验证 token)
  async test() {
    try {
      await this.connect();
      return { ok: true, detail: `${this.name} 配置有效` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }

  // 把 webhook 路由挂到 HTTP server (若通道是 webhook 型); 默认不挂载
  mount(/* httpServer */) { return null; }

  // ---- webhook 型通道的公共辅助 (2026-09-18 重构: feishu/wechat 原各抄一份) ----

  // 路由注册器: 优先注册到主 HTTP 通道的统一路由表 (单一 request handler 分发, 无多 listener 竞态);
  // 未提供主通道时退化为挂到 server 的 request 事件 (仅路径匹配, 调用方自行防双响应)
  _registrar(server, httpChannel) {
    if (httpChannel && typeof httpChannel.registerWebhook === "function") {
      return (path, fn) => httpChannel.registerWebhook(path, fn);
    }
    return (path, fn) => { if (server && typeof server.on === "function") server.on("request", fn); };
  }

  // 读满请求体 (webhook 回调用, 无大小限制 —— 各通道自行校验内容)
  _readBody(req) {
    return readBody(req);
  }

  // 统一的 JSON 响应
  _sendJson(res, code, obj) {
    sendJson(res, code, obj);
  }

  // P0 (2026-10-04): webhook 回调鉴权 fail-closed 判定。
  // 原实现形如 `if (this.token) { 验签 }` —— 密钥没配就等于跳过全部校验, 端口对任何能触达的人
  // 开放"驱动带工具 agent"的入口 (远程命令执行面)。
  // 返回 null = 可以继续 (已配密钥, 或本地调试显式放行); 返回字符串 = 拒绝理由。
  _webhookSecretGate(secret) {
    if (secret) return null;
    const sec = (this.agent && this.agent.config && this.agent.config.security) || {};
    if (sec.allow_unauthenticated_webhooks === true || sec.allowUnauthenticatedWebhooks === true) return null;
    return `${this.name} 回调未配置校验密钥, 已按 fail-closed 拒绝 (未鉴权的 webhook = 任何人可驱动带工具的 agent)。`
      + `请在 config.channels.${this.name} 配置 verify_token/token, 或显式设置 security.allow_unauthenticated_webhooks=true (仅本地调试)`;
  }

  // 收到消息 → 调 agent 处理 → 回发
  async handleMessage(from, text) {
    const reply = await this.agent.chat(text);
    await this.send(from, reply);
    return reply;
  }
}