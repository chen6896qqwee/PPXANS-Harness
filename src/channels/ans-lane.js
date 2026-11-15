// src/channels/ans-lane.js - ANS 车道运行时路由 (Step 5b, L3)
//
// 唯一职责: 把系统主动动作 (proactive/watchdog) 按 ans_lane.v1 投到显式目标。
//   enabled=false (默认) 时 handles() 恒 false, server.js 继续 manager.broadcast —— 行为不变 (I1)。
//   notify: 只产 delivery_* 回执 (身份 deliveryId), 不建工单 (I16), 不参与 DSH 完成判断。
//   submit: 经 agent.chatTracked → workgraph.submit 建单 (origin=ans), 结果按同一目标表回投。
// 去重: 显式 key 优先; period_bucket = <prefix>:<source>:<floor(now/bucket_ms)>; none = 关闭。
// 限流: 按 (source, 目标通道) 计; 超限丢弃并计 dropped, 不重试。
// 安全: internal_only 由 config 强制; extra_deny_tools 在 submit 期间按会话加严 (只增不减)。
import { warn as logWarn } from "../utils/logger.js";
import { ansLaneAllowsSource } from "../config/ans-lane.js";
import { shapeForChannel } from "./output.js";

const HOUR_MS = 3600000;
const RETRY_ON = Object.freeze(["timeout", "network", "rate_limit", "server_error"]);

export function createAnsLane({
  lane = null,
  manager = null,
  agent = null,
  now = () => Date.now(),
  warn = (m) => logWarn(`[ans-lane] ${m}`),
} = {}) {
  const recent = new Map(); // key -> 过期时间 (去重窗口)
  const rate = new Map();   // `${source}:${channel}` -> { hourStart, count, lastAt }
  let seq = 0;
  const stats = {
    notified: 0, submitted: 0, queued: 0, sent: 0, failed: 0,
    dropped: 0, deduped: 0, rateLimited: 0, skipped: 0,
  };

  function handles(source) {
    if (!lane || lane.enabled !== true || lane.internal_only !== true) return false;
    return ansLaneAllowsSource(lane, source);
  }

  // 去重计划: key 与窗口分离, 避免用字符串前缀猜策略。
  function _dedupePlan(source, explicitKey, t) {
    if (explicitKey != null && String(explicitKey) !== "") {
      const window = Math.max(0, Number(lane.dedupe.window_ms) || 0);
      return { key: String(explicitKey), expiresAt: t + window };
    }
    const d = lane.dedupe;
    if (d.strategy === "none" || d.strategy === "explicit") return { key: null, expiresAt: 0 };
    const bucket = Math.max(1, Number(d.bucket_ms) || 1);
    return {
      key: `${d.key_prefix}:${source}:${Math.floor(t / bucket)}`,
      expiresAt: (Math.floor(t / bucket) + 1) * bucket,
    };
  }

  // 返回 true 表示命中已见过的 key (应丢弃); 首次出现时登记窗口。
  function _seen(key, expiresAt, t) {
    if (!key) return false;
    const exp = recent.get(key);
    if (exp !== undefined) {
      if (exp > t) return true;
      recent.delete(key);
    }
    if (expiresAt > t) recent.set(key, expiresAt);
    if (recent.size > 256) {
      for (const [k, e] of recent) if (e <= t) recent.delete(k);
    }
    return false;
  }

  function _forget(key) {
    if (key) recent.delete(key);
  }

  function _rateBlocked(source, channel, t) {
    const key = `${source}:${channel}`;
    let st = rate.get(key);
    if (!st || t - st.hourStart >= HOUR_MS) {
      st = { hourStart: t, count: 0, lastAt: null };
      rate.set(key, st);
    }
    const rl = lane.rate_limit;
    if (st.lastAt != null && rl.min_interval_ms > 0 && t - st.lastAt < rl.min_interval_ms) return true;
    return st.count >= rl.max_per_hour;
  }

  function _rateCommit(source, channel, t) {
    const st = rate.get(`${source}:${channel}`);
    if (!st) return;
    st.count += 1;
    st.lastAt = t;
  }

  function _targets() {
    return Array.isArray(lane?.targets) ? lane.targets : [];
  }

  function _channelReady(name) {
    if (!manager || typeof manager.get !== "function") return true;
    return !!manager.get(name);
  }

  function _meta(source, target, deliveryId, extra = {}) {
    return {
      origin: "ans",
      ansSource: source,
      deliveryId,
      thread: target.thread || null,
      replyTo: target.replyTo || null,
      ...extra,
    };
  }

  function _asyncPolicy() {
    const d = lane.delivery;
    return {
      kind: "async",
      max_attempts: d.max_attempts,
      backoff_ms: d.backoff_ms,
      backoff_cap_ms: d.backoff_cap_ms,
      jitter_ratio: d.jitter_ratio,
      ttl_ms: d.ttl_ms,
      retry_on: [...RETRY_ON],
    };
  }

  async function _send(target, text, meta, dedupeKey) {
    const channel = target.channel;
    const to = target.to;
    if (!_channelReady(channel)) {
      stats.skipped += 1;
      warn(`目标通道未启动, 跳过: ${channel}:${to}`);
      return { channel, to, skipped: true, reason: "channel_not_started" };
    }
    const shaped = shapeForChannel(channel, text, manager?.config?.output || {});
    const route = lane.delivery.route;

    if (route === "sync") {
      if (manager?.delivery?.sendSyncJob) {
        try {
          const result = await manager.delivery.sendSyncJob({
            channel, to, text: shaped, meta, deadlineMs: lane.delivery.deadline_ms,
          });
          stats.sent += 1;
          return { channel, to, sent: true, result };
        } catch (e) {
          stats.failed += 1;
          return { channel, to, sent: false, error: String(e?.message || e) };
        }
      }
      const ch = manager?.get?.(channel);
      if (ch && typeof ch.send === "function") {
        try {
          await ch.send(to, shaped, meta);
          stats.sent += 1;
          return { channel, to, sent: true };
        } catch (e) {
          stats.failed += 1;
          return { channel, to, sent: false, error: String(e?.message || e) };
        }
      }
      stats.failed += 1;
      return { channel, to, sent: false, error: "no_send_path" };
    }

    if (manager?.delivery?.enqueue) {
      try {
        const r = manager.delivery.enqueue({
          channel, to, text: shaped, meta, key: dedupeKey, policy: _asyncPolicy(),
        });
        if (r.queued) stats.queued += 1;
        else if (r.reason === "duplicate") stats.deduped += 1;
        else stats.dropped += 1;
        return { channel, to, queued: !!r.queued, id: r.id || null, reason: r.reason || null };
      } catch (e) {
        stats.failed += 1;
        warn(`入队失败: ${channel}:${to} ← ${e?.message || e}`);
        return { channel, to, queued: false, error: String(e?.message || e) };
      }
    }

    // delivery 被显式关闭: 退回直发 (与 manager.broadcast 的降级路径同口径)。
    const ch = manager?.get?.(channel);
    if (ch && typeof ch.send === "function") {
      try {
        await ch.send(to, shaped, meta);
        stats.sent += 1;
        return { channel, to, sent: true };
      } catch (e) {
        stats.failed += 1;
        return { channel, to, sent: false, error: String(e?.message || e) };
      }
    }
    stats.failed += 1;
    return { channel, to, sent: false, error: "no_delivery" };
  }

  async function _fanout(source, text, { dedupeKey = null, expiresAt = 0, ticketId = null, assignmentId = null } = {}) {
    const t = now();
    const out = [];
    for (const target of _targets()) {
      const targetKey = dedupeKey ? `${dedupeKey}:${target.channel}:${target.to}` : null;
      if (targetKey && _seen(targetKey, expiresAt, t)) {
        stats.deduped += 1;
        out.push({ channel: target.channel, to: target.to, deduped: true });
        continue;
      }
      if (_rateBlocked(source, target.channel, t)) {
        stats.rateLimited += 1;
        stats.dropped += 1;
        out.push({ channel: target.channel, to: target.to, rateLimited: true });
        continue;
      }
      const deliveryId = targetKey || `ans:${source}:${++seq}:${target.channel}:${target.to}`;
      const extra = {};
      if (ticketId) extra.ticketId = ticketId;
      if (assignmentId) extra.assignmentId = assignmentId;
      const meta = _meta(source, target, deliveryId, extra);
      const r = await _send(target, text, meta, targetKey);
      if (r.queued || r.sent) _rateCommit(source, target.channel, t);
      else if (targetKey) _forget(targetKey); // 没交出去: 不占去重窗口
      out.push({ ...r, deliveryId });
    }
    return out;
  }

  async function notify({ source, text, key = null } = {}) {
    const src = String(source || "");
    if (!handles(src)) return { handled: false, reason: "lane_disabled_or_source_not_allowed" };
    const body = String(text ?? "");
    if (!body) return { handled: true, mode: "notify", source: src, reason: "empty_text", targets: [] };
    const plan = _dedupePlan(src, key, now());
    stats.notified += 1;
    const targets = await _fanout(src, body, { dedupeKey: plan.key, expiresAt: plan.expiresAt });
    return {
      handled: true, mode: "notify", source: src, dedupeKey: plan.key,
      deduped: targets.length > 0 && targets.every((r) => r.deduped),
      targets,
    };
  }

  async function submit({ source, text, key = null } = {}) {
    const src = String(source || "");
    if (!handles(src)) return { handled: false, reason: "lane_disabled_or_source_not_allowed" };
    const body = String(text ?? "");
    if (!body) return { handled: true, mode: "submit", source: src, reason: "empty_text" };
    const plan = _dedupePlan(src, key, now());
    const submitKey = plan.key ? `${plan.key}:submit` : null;
    if (submitKey && _seen(submitKey, plan.expiresAt, now())) {
      stats.deduped += 1;
      return { handled: true, mode: "submit", source: src, dedupeKey: plan.key, deduped: true };
    }
    const t = now();
    if (_rateBlocked(src, "*", t)) {
      stats.rateLimited += 1;
      stats.dropped += 1;
      return { handled: true, mode: "submit", source: src, rateLimited: true };
    }
    if (typeof agent?.chatTracked !== "function") {
      warn("mode=submit 但 agent.chatTracked 不可用, 已跳过");
      return { handled: true, mode: "submit", source: src, submitted: false, reason: "no_agent" };
    }
    _rateCommit(src, "*", t);
    stats.submitted += 1;
    const sessionKey = `ppx:ans:${src}`;
    const deny = Array.isArray(lane.security?.extra_deny_tools) ? lane.security.extra_deny_tools : [];
    const restore = _installDeny(agent, sessionKey, deny);
    let result;
    try {
      result = await agent.chatTracked(body, {
        source: src, from: "ans", sessionKey, cause: "ans",
        origin: "ans", dedupeKey: plan.key, skipIfDeduped: true,
      });
    } catch (e) {
      restore();
      if (submitKey) _forget(submitKey); // 失败不占窗口, 允许人工/下轮重试
      const message = String(e?.message || e);
      const targets = await _fanout(src, `[ANS ${src} 执行失败] ${message}`, {
        dedupeKey: plan.key, expiresAt: plan.expiresAt,
        ticketId: e?.ticketId || null, assignmentId: e?.assignmentId || null,
      });
      stats.failed += 1;
      return {
        handled: true, mode: "submit", source: src, submitted: false, error: message,
        ticketId: e?.ticketId || null, assignmentId: e?.assignmentId || null, targets,
      };
    }
    restore();
    if (result.deduped) {
      stats.deduped += 1;
      return {
        handled: true, mode: "submit", source: src, dedupeKey: plan.key, deduped: true,
        ticketId: result.ticketId || null, assignmentId: result.assignmentId || null,
      };
    }
    const reply = result.reply == null ? "" : String(result.reply);
    const targets = reply
      ? await _fanout(src, reply, {
        dedupeKey: plan.key, expiresAt: plan.expiresAt,
        ticketId: result.ticketId || null, assignmentId: result.assignmentId || null,
      })
      : [];
    return {
      handled: true, mode: "submit", source: src, submitted: true, dedupeKey: plan.key,
      ticketId: result.ticketId || null, assignmentId: result.assignmentId || null, targets,
    };
  }

  // 按会话加严工具黑名单: 只叠加、不改全局; 并发会话互不影响。
  function _installDeny(a, sessionKey, tools) {
    if (!tools.length || !a) return () => {};
    if (!a._ansDenyToolsBySession) a._ansDenyToolsBySession = new Map();
    const prev = a._ansDenyToolsBySession.get(sessionKey);
    a._ansDenyToolsBySession.set(sessionKey, new Set([...(prev || []), ...tools]));
    return () => {
      if (prev) a._ansDenyToolsBySession.set(sessionKey, prev);
      else a._ansDenyToolsBySession.delete(sessionKey);
    };
  }

  function statsSnapshot() {
    return { ...stats, recentKeys: recent.size, rateKeys: rate.size };
  }

  return { handles, notify, submit, stats: statsSnapshot };
}
