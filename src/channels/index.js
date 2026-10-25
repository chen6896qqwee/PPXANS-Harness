// src/channels/index.js - 通道管理器 (注册表, config 驱动, 可更换)
// 每个通道 = Channel 子类 (connect/send/disconnect); 新增通道类型 → 注册进 channelTypes 即可, 不改 manager
// 使用方: new ChannelManager(agent, config.channels) → await start()
import { HttpChannel } from "./http.js";
import { FeishuChannel } from "./feishu.js";
import { WechatWebhookChannel } from "./wechat.js";
import { LogChannel } from "./log.js";

// 内置通道类型注册表: name -> 通道类 (构造函数签名: (agent, configObj))
export const BUILTIN_CHANNEL_TYPES = {
  http: HttpChannel,
  feishu: FeishuChannel,
  wechat: WechatWebhookChannel,
  log: LogChannel,
};

// 启停策略: http 默认开, 其余默认关 (config.channels.<name>.enabled)
function isEnabled(name, cfg) {
  if (name === "http") return cfg.enabled !== false;
  return !!cfg.enabled;
}

export class ChannelManager {
  constructor(agent, config = {}, channelTypes = null) {
    this.agent = agent;
    this.config = config || {};              // config.channels
    this.channelTypes = channelTypes || BUILTIN_CHANNEL_TYPES; // 可注入自定义类型 (更换通道实现)
    this.channels = [];
    this.httpServer = null;
  }

  // 按注册表顺序启动所有启用的通道 (单个失败不影响其他)
  // 流程: 全部 connect → 若 HTTP 通道在跑, 给 webhook 型通道挂载路由
  async start() {
    const started = [];
    for (const [name, Ctor] of Object.entries(this.channelTypes)) {
      const cfg = { ...(this.config[name] || {}) };
      if (!isEnabled(name, cfg)) continue;
      try {
        const ch = new Ctor(this.agent, cfg);
        await ch.connect();
        this.channels.push(ch);
        if (ch.server) this.httpServer = ch.server;
        started.push(name);
      } catch (e) {
        console.warn(`[channels] ${name} 通道启动失败: ${e.message}`);
      }
    }
    // webhook 型通道挂到 HTTP server (若已启动); 传 http 通道实例供 registerWebhook 路由分发
    if (this.httpServer) {
      const httpCh = this.get("http") || null;
      for (const ch of this.channels) {
        if (ch.name !== "http" && typeof ch.mount === "function") {
          try { ch.mount(this.httpServer, httpCh); } catch (e) { console.warn(`[channels] ${ch.name} webhook 挂载失败: ${e.message}`); }
        }
      }
    }
    return started;
  }

  // 按 name 取已启动通道 (无则 null)
  get(name) {
    return this.channels.find((c) => c.name === name) || null;
  }

  // 列出所有可配置通道的状态 (含未启用的), 供 CLI/UI 展示
  list() {
    return Object.entries(this.channelTypes).map(([name, Ctor]) => {
      const cfg = this.config[name] || {};
      return { name, enabled: isEnabled(name, cfg), connected: !!this.get(name) };
    });
  }

  // 连通性测试: 用独立实例验证某通道配置 (不干扰已启动的通道)
  async test(name) {
    const Ctor = this.channelTypes[name];
    if (!Ctor) return { ok: false, detail: `未知通道类型: ${name}` };
    const cfg = { ...(this.config[name] || {}) };
    try {
      const ch = new Ctor(this.agent, cfg);
      const r = typeof ch.test === "function" ? await ch.test() : await ch.connect();
      return typeof r === "object" && r !== null ? r : { ok: true, detail: String(r) };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }

  // 广播到所有已启动通道 (主动提醒/系统消息投递入口)
  async broadcast(text, { to = "*" } = {}) {
    const out = [];
    for (const c of this.channels) {
      try { out.push(await c.send(to, text)); } catch (e) { console.warn(`[channels] ${c.name} 发送失败: ${e.message}`); }
    }
    return out;
  }

  async stop() {
    for (const c of this.channels) {
      try { await c.disconnect?.(); } catch {}
    }
    this.channels = [];
    this.httpServer = null;
  }
}

export { Channel } from "./base.js";
export { HttpChannel } from "./http.js";
export { FeishuChannel } from "./feishu.js";
export { WechatWebhookChannel } from "./wechat.js";
export { LogChannel } from "./log.js";
