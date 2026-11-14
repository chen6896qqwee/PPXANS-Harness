// src/channels/telegram.js - Telegram 渠道适配器 (long polling, 零依赖原生 fetch, 2026-11-14)
// 动机: 渠道生态补全 —— 此前仅 HTTP/飞书/微信。Telegram 用 getUpdates 长轮询,
//   不需要公网 webhook (个人机器友好), 唯一凭据是 botToken (@BotFather 创建 bot)。
// 架构: 只实现 connect/send/disconnect + Trigger 工厂, 整条准入/建单/投递/回执链路与
//   渠道无关 (base.handleTrigger), 两级过滤/工单去重/REPLAY/THREAD/异步回投/WAL 全部免费继承。
// 诚实边界:
//   - allowed_updates 只订阅 "message" —— edited_message/channel_post 不收不触发
//     (消息编辑不重跑, 与飞书/微信"每条消息一次执行"同口径);
//   - 媒体消息 (photo/voice/document...) 只取 caption 文本, 本体不下载;
//   - 渠道层不做语义判定: 群/发送者黑白名单走跨渠道 agent.trigger_policy (flow/policy.js),
//     这里只提供 allowed_chats 渠道级首道白名单 (省得为单人 bot 配全局策略)。
// 出站口径: 全局 fetch + AbortSignal.timeout (与 feishu/wechat 同款), 不走 net-guard
//   (那是 agent 工具的 SSRF 防线; 渠道端点是运维配置不是模型可控输入)。
import { Channel } from "./base.js";
import { triggerFromTelegramEvent } from "../flow/trigger.js";
import { backoffDelay } from "./delivery.js";
import { noteCatch } from "../utils/catch-log.js";

// Telegram sendMessage 文本硬限 4096 字符; 留余量按 4000 切, 优先在换行处断 (纯函数, 导出供测试)
export function splitTelegramMessage(text, limit = 4000) {
  const s = String(text ?? "");
  if (s.length <= limit) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.3) cut = limit; // 换行点太靠前 (或没有) → 硬切
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class TelegramChannel extends Channel {
  constructor(agent, {
    botToken,
    api_base = "https://api.telegram.org",
    poll_timeout_seconds = 50,
    poll_interval_ms = 0,
    allowed_chats = "",
  } = {}) {
    super("telegram", agent);
    this.botToken = botToken || process.env.TELEGRAM_BOT_TOKEN || "";
    this.apiBase = String(api_base || "https://api.telegram.org").replace(/\/+$/, "");
    // 长轮询挂起秒数: Telegram 官方建议 ≤50 (网关/代理可能掐更长的连接)
    this.pollTimeoutSec = Math.max(1, Math.min(60, Number(poll_timeout_seconds) || 50));
    this.pollIntervalMs = Math.max(0, Number(poll_interval_ms) || 0);
    // 渠道级首道白名单: 逗号分隔 chat_id 字符串 (validateChannel 只支持 string); 空 = 不限
    this.allowedChats = new Set(String(allowed_chats || "").split(",").map((s) => s.trim()).filter(Boolean));
    this.lastUser = null; // 最近收到消息的 chat_id, 供主动提醒(广播)回发
    this.me = null;
    this._offset = 0;        // getUpdates 游标 (update_id + 1), 进程内持久
    this._pollTimer = null;
    this._stopped = true;
    this._failStreak = 0;
  }

  // Bot API 调用: 永不返回非 ok —— 失败 throw 带方法名的中文可读错误
  async _api(method, body = null, { timeoutMs = 15000 } = {}) {
    const r = await fetch(`${this.apiBase}/bot${this.botToken}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!data || data.ok !== true) {
      throw new Error(`Telegram ${method} 失败: ${(data && data.description) || `HTTP ${r.status}`}`);
    }
    return data.result;
  }

  async connect() {
    if (!this.botToken) {
      throw new Error("Telegram 通道未配置: 需要 botToken (找 @BotFather 创建 bot 取 token, 配 channels.telegram.botToken 或环境变量 TELEGRAM_BOT_TOKEN)");
    }
    this.me = await this._api("getMe"); // 验证凭证 (真实网络探测)
    this.connected = true;
    this._stopped = false;
    this._scheduleNext(0); // 长轮询自续环 (不 await —— connect 不等挂起的 getUpdates)
    return this;
  }

  // 连通性测试: getMe 真实验证 (接入 ppx channels test telegram / Web 设置页)
  async test() {
    if (!this.botToken) return { ok: false, detail: "未配置 botToken (找 @BotFather 创建 bot)" };
    try {
      const me = await this._api("getMe");
      return { ok: true, detail: `Telegram 凭证有效 (@${me.username || me.id})` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }

  // 长轮询: setTimeout 自续 + unref (仿 scheduler.js 的定时模式; disconnect 清环)。
  //   挂起的 getUpdates 不强杀 —— 断开后返回的 updates 因 _stopped 直接丢弃。
  _scheduleNext(delayMs = 0) {
    if (this._stopped) return;
    clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => this._pollOnce(), delayMs);
    if (this._pollTimer && typeof this._pollTimer.unref === "function") this._pollTimer.unref();
  }

  async _pollOnce() {
    if (this._stopped) return;
    try {
      // offset 游标 + 服务端 allowed_updates 过滤 (edited_message 等 never deliver)
      const updates = await this._api("getUpdates", {
        offset: this._offset,
        timeout: this.pollTimeoutSec,
        allowed_updates: ["message"],
      }, { timeoutMs: (this.pollTimeoutSec + 10) * 1000 });
      if (this._stopped) return;
      this._failStreak = 0;
      for (const u of updates || []) {
        this._offset = Math.max(this._offset, (Number(u && u.update_id) || 0) + 1);
        try { await this.handleUpdate(u); } catch (e) { noteCatch("telegram#handleUpdate", e); }
      }
      this._scheduleNext(this.pollIntervalMs);
    } catch (e) {
      if (this._stopped) return;
      // 网络抖动/限流退避重连 (复用 delivery 退避公式: base × 2^(n-1) 封顶 60s)
      this._failStreak = Math.min(this._failStreak + 1, 6);
      noteCatch("telegram#poll", e);
      this._scheduleNext(backoffDelay(this._failStreak, {
        backoffMs: Math.max(1000, this.pollIntervalMs),
        backoffCapMs: 60000,
        jitterRatio: 0,
      }));
    }
  }

  // update → Trigger → 标准入站主路径 (两级准入/工单/回投全部在 base.handleTrigger)
  async handleUpdate(update) {
    if (this._stopped) return null;
    const trigger = triggerFromTelegramEvent(update);
    if (!trigger || !trigger.text) return null; // 非文本消息/编辑事件 → 忽略 (诚实边界)
    const chatId = trigger.group || trigger.from;
    if (this.allowedChats.size && !this.allowedChats.has(String(chatId))) return null;
    if (trigger.from) this.lastUser = String(trigger.group || trigger.from);
    return this.handleTrigger(trigger);
  }

  async send(to, text, meta = null) {
    if (!this.botToken) throw new Error("Telegram 通道未配置 botToken");
    const target = !to || to === "*" ? this.lastUser : String(to);
    if (!target) {
      throw new Error("Telegram 主动推送缺接收人: 先收到过一条用户消息记录 chat_id, 或用 send(chatId, ...)");
    }
    const chunks = splitTelegramMessage(text);
    let last = null;
    for (let i = 0; i < chunks.length; i++) {
      const body = { chat_id: target, text: chunks[i] };
      // meta.replyTo = 原消息 message_id → 回到原消息下 (话题串不散); 只首块携带
      if (meta && meta.replyTo && i === 0) body.reply_to_message_id = Number(meta.replyTo) || undefined;
      last = await this._api("sendMessage", body);
    }
    return last;
  }

  async disconnect() {
    this._stopped = true;
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
    this.connected = false;
  }
}
