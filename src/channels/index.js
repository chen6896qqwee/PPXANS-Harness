// src/channels/index.js - 通道管理器 (注册表, config 驱动, 可更换)
// 每个通道 = Channel 子类 (connect/send/disconnect); 新增通道类型 → 注册进 channelTypes 即可, 不改 manager
// 使用方: new ChannelManager(agent, config.channels) → await start()
// 2026-10-31 (队列⑦): 主动投递走投递队列 (delivery) —— 失败重试/TTL 丢弃/WAL 续投;
//   入站回复 (base.handleMessage) 仍直发不排队 (用户在等)。
import path from "node:path";
import { HttpChannel } from "./http.js";
import { FeishuChannel } from "./feishu.js";
import { WechatWebhookChannel } from "./wechat.js";
import { LogChannel } from "./log.js";
import { createDeliveryQueue } from "./delivery.js";

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
    this.delivery = null; // 投递队列 (start() 时创建, 队列⑦)
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
    // 投递队列 (2026-10-31 队列⑦): WAL 落 dataDir/channels/delivery.wal.jsonl, 启动 replay 续投
    //   未送出的主动消息。agent 无 dataDir (部分测试桩) 时退化为纯内存队列。
    const dcfg = { ...(this.config.delivery || {}) };
    if (dcfg.enabled !== false) {
      const dataDir = this.agent && this.agent.dataDir;
      // wal: false 显式关闭落盘续投 (默认开)
      const walPath = dataDir && dcfg.wal !== false ? path.join(dataDir, "channels", "delivery.wal.jsonl") : null;
      this.delivery = createDeliveryQueue({
        send: async (name, to, text, meta = null) => {
          const ch = this.get(name);
          if (!ch) throw new Error(`通道未启动: ${name} (可能启动失败或已停止)`);
          return ch.send(to, text, meta);
        },
        retryMax: Number(dcfg.retry_max) >= 0 ? Number(dcfg.retry_max) : 3,
        backoffMs: Number(dcfg.backoff_ms) > 0 ? Number(dcfg.backoff_ms) : 2000,
        ttlMs: Number(dcfg.ttl_ms) > 0 ? Number(dcfg.ttl_ms) : 3600000,
        maxQueue: Number(dcfg.max_queue) > 0 ? Number(dcfg.max_queue) : 200,
        walPath,
      });
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
  // 2026-10-31 (队列⑦): 默认经投递队列 —— 每通道一条 job, 失败指数退避重试, TTL/容量兜底,
  //   WAL 落 <dataDir>/channels/delivery.wal.jsonl (重启续投)。返回入队回执 [{channel, id, queued}],
  //   不等发送完成 (主动提醒无需阻塞); delivery.enabled=false 时回退旧同步直发 (返回 send 结果)。
  //   测试同步断言用 await mgr.delivery.idle() 等队列排空。
  async broadcast(text, { to = "*", delivery = null, meta = null } = {}) {
    const cfg = { ...(this.config.delivery || {}), ...(delivery || {}) };
    if (cfg.enabled === false || !this.delivery) {
      const out = [];
      for (const c of this.channels) {
        try { out.push(await c.send(to, text, meta)); } catch (e) { console.warn(`[channels] ${c.name} 发送失败: ${e.message}`); }
      }
      return out;
    }
    const out = [];
    for (const c of this.channels) {
      // 2026-10-31 (Super-agent 一期): meta 随 job 落 WAL —— 回投元数据 (来源会话/话题等)
      //   重启续投后不丢, 为"后台结果回原话题"铺路 (此前 enqueue 支持 meta 但恒传 null)
      const r = this.delivery.enqueue({ channel: c.name, to, text, meta });
      out.push({ channel: c.name, queued: !!r.queued, id: r.id || null, reason: r.reason || null });
    }
    return out;
  }

  // 投递队列可观测 (pending/sent/failed/dropped/retried + 最近 10 条终态失败)
  deliveryStats() {
    return this.delivery ? this.delivery.stats() : null;
  }

  async stop() {
    // 先停投递队列 (未送出的留在 WAL, 下次启动 replay 续投), 再断通道
    if (this.delivery) {
      const r = this.delivery.shutdown();
      if (r.abandoned > 0) console.warn(`[channels] 停止时有 ${r.abandoned} 条未投递消息, 已留在 WAL 待下次启动续投`);
      this.delivery = null;
    }
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
