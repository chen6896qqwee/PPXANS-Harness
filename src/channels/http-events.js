// src/channels/http-events.js - SSE 事件流/票据/广播 (从 http.js 拆出, mixin 挂回 prototype)
import crypto from "node:crypto";
import { SSE_HEADERS } from "../utils/http.js";
import { safeEqual, SSE_HEARTBEAT_MS } from "./http-shared.js";

export const eventsHttpMethods = {
// ---- 路由域 1.5: SSE 事件流 (/events) ----
// 鉴权 (token 查询参数 或 单次 ticket) + 主动提醒广播 + EQ 结构化事件桥接。
// 2026-10-10 补齐: 此前 /events 从未实现 —— send() 是 no-op, 协议总线 EQ 零消费者。
// 2026-10-24: 支持 ticket 参数 —— EventSource 无法带 Authorization 头, 旧方案把长效
//   token 放 URL query 易进访问日志/Referer。新方案: 先 POST /events-ticket (bearer 鉴权)
//   换 60 秒一次性 ticket, SSE 用 ticket 连接。token query 保留兼容旧客户端。
_routeEvents(req, res, get, reqPath) {
  if (!get || reqPath !== "/events") return false;
  // 鉴权: 无 token 或 token 不匹配 → 401 (拒绝不得返 200)
  if (!this.authToken) return this._json(res, 401, { error: "未配置鉴权 token" }), true;
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const qToken = u.searchParams.get("token");
  const qTicket = u.searchParams.get("ticket");
  let authed = false;
  if (qTicket) {
    authed = this._consumeEventsTicket(qTicket);
    if (!authed) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ticket 无效/过期/已使用" }));
      return true;
    }
  } else if (qToken && safeEqual(qToken, this.authToken)) {
    authed = true;
  }
  if (!authed) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "鉴权失败" }));
    return true;
  }
  // 建 SSE 流并登记
  res.writeHead(200, SSE_HEADERS);
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  this._sseClients.add(res);
  // 订阅 EQ 结构化事件 → 桥接为 SSE 事件 (协议总线不再零消费者)
  // 2026-11-01 (二期① 收口): 查询参数 since/types/thread —— 浏览器断线重连带
  //   ?since=<最后seq> 即补播错过的事件 (subscribe 内置回放+实时无缝衔接), 不再整页刷新;
  //   ?types=turn_started,tool_called 白名单; ?thread=<话题键> 只收该话题。
  //   SSE 帧附 seq/thread 顶层字段, 客户端据此推进自己的 since 水位。
  const qSince = Number(u.searchParams.get("since"));
  const qTypes = (u.searchParams.get("types") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const qThread = u.searchParams.get("thread");
  // 2026-11-02 (桌面长运行修复): eq.subscribe 返回的退订函数原先被丢弃 ——
  //   每次浏览器断开/重连都留下一个闭包订阅者, 实测 25 次连接后 25 个僵尸订阅,
  //   且它们一直向已销毁的 res 写。现在断连统一走 cleanup: 退订 + 移出广播集合 + 停心跳。
  let off = null;
  let heartbeat = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    try { off?.(); } catch { /* 退订异常不影响清理 */ }
    this._sseClients.delete(res);
    delete res.__ppxSseCleanup;
  };
  const onEq = (ev) => {
    if (cleaned || res.destroyed || res.writableEnded) { cleanup(); return; }
    try {
      res.write(`data: ${JSON.stringify({ type: ev.type, payload: ev.payload, seq: ev.seq, thread: ev.thread ?? null })}\n\n`);
    } catch { cleanup(); }
  };
  off = this.agent?.protocolBus?.eq?.subscribe?.(onEq, {
    since: Number.isFinite(qSince) && qSince > 0 ? qSince : null,
    types: qTypes.length ? qTypes : null,
    thread: qThread || null,
  }) || null;
  // 回放期间客户端可能已断开 (subscribe 是同步回放), 先补一次状态判断
  if (res.destroyed || res.writableEnded) { cleanup(); return true; }
  res.__ppxSseCleanup = cleanup;
  heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) { cleanup(); return; }
    try { res.write(": ping\n\n"); } catch { cleanup(); }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.(); // 心跳不阻止进程退出
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
  return true;
},

// ---- SSE ticket 签发 (POST /events-ticket, bearer 鉴权) ----
// 60 秒一次性: 换取后只能连一次 /events?ticket=...。泄露面从"长效 token 进 URL"缩到
// "60 秒单次凭据进 URL"。挂靠 /events 同域 (不经 /api/* 门禁, REST 退役开关不影响)。
_routeEventsTicket(req, res, post, reqPath) {
  if (!post || reqPath !== "/events-ticket") return false;
  if (!this._requireAuth(req, res)) return true;
  const ticket = crypto.randomBytes(24).toString("hex");
  this._eventsTickets.set(ticket, Date.now() + 60000);
  this._sweepEventsTickets();
  this._json(res, 200, { ticket, expires_in: 60 });
  return true;
},

// 消费 ticket: 一次性 (取出即删), 过期无效
_consumeEventsTicket(ticket) {
  if (!ticket || !this._eventsTickets.has(ticket)) return false;
  const exp = this._eventsTickets.get(ticket);
  this._eventsTickets.delete(ticket);
  return Date.now() <= exp;
},

_sweepEventsTickets() {
  const now = Date.now();
  for (const [t, exp] of this._eventsTickets) {
    if (now > exp) this._eventsTickets.delete(t);
  }
},

// 向所有 /events 客户端广播一条 SSE 事件
_broadcastSse(type, payload) {
  const line = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const res of this._sseClients) {
    if (res.destroyed || res.writableEnded) { res.__ppxSseCleanup?.(); continue; }
    try { res.write(line); } catch { res.__ppxSseCleanup?.(); }
  }
}
};
