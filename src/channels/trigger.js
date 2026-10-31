// src/channels/trigger.js - Trigger 结构化事件对象 (2026-10-31 Super-agent 一期地基)
//
// 对照 DeepSeek《Super-agent 设计探索》§3: Agent 的主输入不再是"人类逐条键入的提示词",
// 而是环境中持续产生的半结构化事件 (Trigger)。此前皮皮虾的入站链路把消息退化成裸字符串
// (from, text) —— 来源渠道、群组、话题、发送者、消息 ID 在通道层即被丢弃,
// 所有 feishu/wechat 消息全部混进同一个 "default" 会话, 群聊不同话题彼此串台。
//
// 本模块只做三件事 (纯函数, 零依赖):
//   ① 把各渠道原始事件归一成 Trigger 对象 (source/from/group/thread/messageId/text);
//   ② 每条 Trigger 一个稳定唯一 id (供审计留痕与二期订阅直通/引用图);
//   ③ Trigger → 会话键映射: 复用 utils/session-key.js 的四段式键
//      (feishu/wechat surface 早已预声明, 此前零调用) —— 会话互斥/记忆分区/重定向全部白拿。
//
// 设计取舍:
//   - 话题归组连接符用 "-" (session-key.js seg 消毒字符集天然存活; "~" 只用于 roomKey
//     体系且不经过 sessionKeyFor, 在会话键里用 "~" 会被洗掉) —— 群/话题 ID 均为平台
//     前缀 ID (oc_/om_), "-" 歧义碰撞在真实 ID 空间里可忽略;
//   - session_mapping="shared" 时返回 null, 由调用方不传 sessionKey —— 精确回退旧行为
//     (直接调 agent.chat(text), 连键形态都不变, 老会话历史不搬家)。
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
 * 此前只提取 text 和 open_id —— chat_id/chat_type/root_id/parent_id/message_id 全部丢弃。
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
