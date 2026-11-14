// src/flow/trigger.js - 入站事件归一 (原生入站流 L2)
//
// 设计目标: 智能体的主输入不是"人类逐条键入的提示词", 而是环境中持续产生的半结构化事件。
// 消息一旦被降级成裸字符串 (from, text), 来源渠道/群组/话题/发送者/消息 ID 就在通道层丢失,
// 所有消息混进同一个 default 会话, 群聊不同话题彼此串台。这里把原始事件归一成 Trigger 对象,
// 并给出稳定的会话键映射 —— 会话互斥/记忆分区/重定向都建立在同一份事实之上。
//
// 本模块只做三件事 (纯函数, 零依赖):
//   ① 各渠道原始事件 → Trigger (source/from/group/thread/messageId/text/ts/meta);
//   ② 每条 Trigger 一个稳定唯一 id (审计留痕与事件引用);
//   ③ Trigger → 四段式会话键 (复用 utils/session-key.js), 群聊按 群/话题 切, 私聊按发送者切。
//
// 设计取舍:
//   - 话题归组连接符用 "-" (session-key.js 的 seg 消毒字符集天然存活; "~" 只用于 roomKey
//     体系且不经过 sessionKeyFor, 在会话键里会被洗掉) —— 群/话题 ID 均为平台前缀 ID
//     (oc_/om_), "-" 歧义碰撞在真实 ID 空间里可忽略;
//   - session_mapping="shared" 时返回 null, 由调用方不传 sessionKey —— 精确回退旧行为
//     (直接调 agent.chat(text), 连键形态都不变, 老会话历史不搬家)。
//
// 设计溯源: docs/PROVENANCE.md#superagent (仅设计思想对照, 本文件源码自研)。
import { sessionKeyFor } from "../utils/session-key.js";

let _seq = 0;

/**
 * 构造 Trigger 事件对象。
 *   source    渠道名 (feishu/wechat/http/log/…)
 *   from      发送者 ID (飞书 open_id / 微信 FromUserName)
 *   group     群组 ID (群聊才有; 飞书 chat_id, 私聊为空)
 *   thread    话题 ID (同一话题串的归组键; 飞书取 root_id, 独立消息为空)
 *   messageId 渠道侧消息 ID (防重放/引用)
 *   text      文本内容
 */
export function createTrigger({ source = "unknown", from = "", group = "", thread = "", messageId = "", text = "", ts = null, meta = null } = {}) {
  const t = {
    id: `tg-${Date.now().toString(36)}-${(++_seq).toString(36)}`,
    source: String(source || "unknown"),
    from: String(from || ""),
    group: String(group || ""),
    thread: String(thread || ""),
    messageId: String(messageId || ""),
    text: String(text ?? ""),
    ts: Number(ts) || Date.now(),
    meta: meta || null,
  };
  t.scope = t.group ? "group" : "dm";
  return t;
}

/**
 * 从飞书 v2 事件 (im.message.receive_v1 的 event 段) 构造 Trigger。
 * chat_id/chat_type/root_id/parent_id/message_id 全部保留 —— 它们是会话键与回投落点。
 */
export function triggerFromFeishuEvent(event) {
  const msg = event?.message || {};
  let text = "";
  try { text = msg.content ? JSON.parse(msg.content).text || "" : ""; } catch { text = ""; }
  const chatType = String(msg.chat_type || "");
  const chatId = String(msg.chat_id || "");
  return createTrigger({
    source: "feishu",
    from: String(event?.sender?.sender_id?.open_id || ""),
    group: chatType === "group" ? chatId : "", // 群聊才有归组; p2p 归到个人会话
    thread: String(msg.root_id || msg.parent_id || ""), // 话题回复归到话题串
    messageId: String(msg.message_id || ""),
    text,
    meta: { chatType },
  });
}

/**
 * 从微信回调 XML 提取字段构造 Trigger (公众号/企业微信回调无群组概念, group 恒空)。
 * msgId 由调用方传入 (含防重放兜底哈希), 保证与通道侧去重键一致。
 */
export function triggerFromWechatFields({ from = "", messageId = "", text = "", createTime = null } = {}) {
  return createTrigger({
    source: "wechat",
    from: String(from || ""),
    messageId: String(messageId || ""),
    text: String(text ?? ""),
    ts: (Number(createTime) > 0 ? Number(createTime) * 1000 : null),
  });
}

/**
 * 从 Telegram Bot API update 的 message 对象构造 Trigger (2026-11-14 渠道补全)。
 * 诚实边界: 只服务 message —— edited_message/channel_post 由 getUpdates allowed_updates
 *   在服务端过滤, 这里再兜一道 (非 message 一律 null); 媒体消息取 caption 文本。
 * 归组: chat.type ∈ {group, supergroup} 归群 (group=chat_id); private 归个人会话。
 * thread: message_thread_id (论坛话题) 优先, 回复串取 reply_to_message.message_id ——
 *   与飞书 root_id 优先同构 (话题串根优先)。
 */
export function triggerFromTelegramEvent(update) {
  const msg = update?.message || null;
  if (!msg) return null;
  const chat = msg.chat || {};
  const chatType = String(chat.type || "");
  const isGroup = chatType === "group" || chatType === "supergroup";
  return createTrigger({
    source: "telegram",
    from: String(msg.from?.id || ""),
    group: isGroup ? String(chat.id || "") : "",
    thread: String(msg.message_thread_id || msg.reply_to_message?.message_id || ""),
    messageId: String(msg.message_id || ""),
    text: String(msg.text ?? msg.caption ?? ""),
    ts: Number(msg.date) > 0 ? Number(msg.date) * 1000 : null,
    meta: { chatType },
  });
}

/**
 * Trigger → 四段式会话键 (复用 session-key.js, 让会话互斥/记忆分区按"谁在哪个群哪个话题"切分)。
 *   群聊: session = chat_id (话题回复 = chat_id-root_id); 私聊: session = 发送者 ID。
 *   session_mapping="shared" 返回 null —— 调用方不传 sessionKey, 精确回退旧行为。
 */
export function sessionKeyForTrigger(trigger, { sessionMapping = "chat", agentId = "ppx" } = {}) {
  const t = trigger || {};
  if (String(sessionMapping) === "shared") return null;
  const base = t.group || t.from || "default";
  const session = (t.group && t.thread) ? `${t.group}-${t.thread}` : base;
  return sessionKeyFor({ agentId, surface: t.source, session, scope: t.group ? "group" : "dm" });
}
