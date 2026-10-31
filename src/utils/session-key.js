// src/orchestrator/session-key.js - 会话键编码 scheme (2026-10-07 吸收自 TencentCloud/Octop)
//
// 吸收来源: Octop `docs/architecture.md` 的 "Conversation surfaces" 表。
//   它把每个入口的会话键编码成同一套形状:
//     <agent_id>:<surface>:<session>:<dm|group>
//   例如 `aid:dashboard:user_7:dm` / `aid:feishu:oc_xxx:group` / `aid:cli:user_7:dm`。
//
// 为什么值得单独成模块 (PPX 原来 sessionKey 是各处随手拼的字符串):
//   ① 一个会话键要同时回答四个问题: 谁在用、从哪来、哪个会话、单聊还是群聊。
//      拼错的代价是隐蔽的 —— 群聊消息串进单聊历史、两个用户的会话互相覆盖, 都不会立刻报错。
//   ② 记忆/审计/看板都以 sessionKey 为分区键。键一旦不统一, "同一段对话"在不同子系统里
//      是两个不同的东西, 排查时根本对不上。
//   ③ 反解析(从键还原出处)是刚需: 消息要回推给正确的通道, 靠的就是键里的 surface。
//
// 设计取舍: **纯函数 + 不做隐式归一**。键是跨进程/跨天持久化的标识, 悄悄改写历史键会让
// 老会话凭空消失; 因此解析失败一律返回 null 并保留原键, 由调用方决定怎么兜。

export const SURFACES = ["cli", "web", "http", "api", "feishu", "wechat", "cron", "legion", "worker", "test", "unknown"];
export const SCOPES = ["dm", "group"];

// 安全段字符: 刻意**不含 ':'** —— 冒号是段分隔符, 一旦出现在段里, 反解析就会错位
// (群聊消息串进单聊历史、两个用户互相覆盖, 都不会立刻报错, 是最难查的一类)。
const SAFE = /^[A-Za-z0-9_.\-@]{1,120}$/;

function seg(v, fallback) {
  const s = String(v ?? "").trim();
  if (!s) return fallback;
  if (!SAFE.test(s)) {
    // 分隔符与非法字符一律替换为 '-' (保证段内永远不含 ':')
    return s.replace(/[^A-Za-z0-9_.\-@]/g, "-").slice(0, 120) || fallback;
  }
  return s;
}

/**
 * 组装会话键。四段缺一不可 —— 缺了就用默认值补, 而不是少一段。
 *   agentId  智能体/专家 id (谁在服务)
 *   surface  入口 (从哪来): cli / web / http / feishu / wechat / cron / legion / worker / test
 *   session  会话标识 (单聊=用户, 群聊=群/房间 id, cron=任务名)
 *   scope    dm | group
 */
export function sessionKeyFor({ agentId = "ppx", surface = "cli", session = "default", scope = "dm" } = {}) {
  const a = seg(agentId, "ppx");
  const s = seg(surface, "unknown");
  const ss = seg(session, "default");
  const sc = SCOPES.includes(String(scope)) ? String(scope) : "dm";
  return `${a}:${s}:${ss}:${sc}`;
}

// 反解析: 失败返回 null (调用方保留原键, 不做隐式改写)
export function parseSessionKey(key) {
  const k = String(key || "");
  const parts = k.split(":");
  if (parts.length !== 4) return null;
  const [agentId, surface, session, scope] = parts;
  if (!agentId || !surface || !session) return null;
  if (!SCOPES.includes(scope)) return null;
  return { agentId, surface, session, scope, raw: k };
}

// 是否已是规范形态的键 (老键/随手拼的键会返回 false)
export function isSessionKey(key) {
  return parseSessionKey(key) !== null;
}

// 兼容读法: 已是规范键就用它, 否则按默认上下文补成规范键。
// 用途: 老代码路径传进来的裸字符串 (如 "default") 不炸, 但新写入统一走规范形态。
export function normalizeSessionKey(key, { agentId = "ppx", surface = "cli", scope = "dm" } = {}) {
  const p = parseSessionKey(key);
  if (p) return p.raw;
  const session = String(key || "").trim() || "default";
  return sessionKeyFor({ agentId, surface, session, scope });
}

// 同 surface + 同 session 但换 scope (群聊里的私聊通道这类场景)
export function withScope(key, scope, { agentId = "ppx", surface = null } = {}) {
  const p = parseSessionKey(key);
  if (!p) return sessionKeyFor({ agentId, surface: surface || "unknown", session: String(key || "default"), scope });
  return sessionKeyFor({ agentId: p.agentId, surface: surface || p.surface, session: p.session, scope });
}

// 团队房间键 (主持人 thread = 房间 id; 成员 checkpoint = 房间~成员)
export function roomKey(roomId, memberId = null) {
  const base = seg(roomId, "room");
  return memberId ? `${base}~${seg(memberId, "member")}` : base;
}

export function parseRoomKey(key) {
  const k = String(key || "");
  const i = k.indexOf("~");
  return i < 0 ? { roomId: k, memberId: null, raw: k } : { roomId: k.slice(0, i), memberId: k.slice(i + 1), raw: k };
}

export default { SURFACES, SCOPES, sessionKeyFor, parseSessionKey, isSessionKey, normalizeSessionKey, withScope, roomKey, parseRoomKey };
