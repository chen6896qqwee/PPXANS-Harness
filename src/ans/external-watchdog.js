// src/ans/external-watchdog.js - 任务级外部看门狗 (2026-11-05 Step 8)
//
// 动机: 进程内 watchdog (ans/watchdog.js) 与主服务同生共死 —— 主进程卡死/事件循环
//   被长任务占满时, 它自己也不会心跳。Super-agent 的外部控制回路要求监督者独立于
//   被监督进程。本模块只依赖 HTTP 只读接口 (/api/tickets?assignments=1) 与可选的人工
//   接管动作 (/api/tickets POST cancel), 可以跑在另一台机器/另一个进程里。
//
// 安全边界:
//   - 默认**只报告不处置**; 只有显式 act=true (CLI --act cancel) 才发取消请求,
//     且受 maxActions 上限约束 —— 不静默重跑, 不做批量清理。
//   - 判定口径与进程内看门狗共用 detectWorkerDrift, 不另写一套"漂移"定义。
//   - 所有网络失败都变成结构化 {ok:false,error}, 不抛异常吞掉。
import { detectWorkerDrift } from "./watchdog.js";

export const EXTERNAL_WATCHDOG_DEFAULTS = Object.freeze({
  stallMinutes: 15,
  driftRepeat: 6,
  driftRounds: 18,
  maxActions: 1,
  timeoutMs: 5000,
});

const clampInt = (v, min, def) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= min ? n : def;
};

// 纯函数: 从工单列表算停滞/漂移信号。ticket.assignment 由
// GET /api/tickets?assignments=1 附加 (rounds/steps/tools 只存在于指派上)。
export function evaluateTickets(tickets, {
  now = Date.now(),
  stallMinutes = EXTERNAL_WATCHDOG_DEFAULTS.stallMinutes,
  driftRepeat = EXTERNAL_WATCHDOG_DEFAULTS.driftRepeat,
  driftRounds = EXTERNAL_WATCHDOG_DEFAULTS.driftRounds,
  limit = 20,
} = {}) {
  const stallMin = clampInt(stallMinutes, 1, EXTERNAL_WATCHDOG_DEFAULTS.stallMinutes);
  const repeat = clampInt(driftRepeat, 2, EXTERNAL_WATCHDOG_DEFAULTS.driftRepeat);
  const spin = clampInt(driftRounds, 4, EXTERNAL_WATCHDOG_DEFAULTS.driftRounds);
  const max = clampInt(limit, 1, 20);
  const list = Array.isArray(tickets) ? tickets.filter((t) => t && typeof t.id === "string") : [];
  const live = list.filter((t) => t.status === "working" || t.status === "waiting");
  const working = live.filter((t) => t.status === "working");
  const stalled = [];
  const drifting = [];
  for (const t of working) {
    const a = t.assignment && typeof t.assignment === "object" ? t.assignment : {};
    const ref = Math.max(
      Number(t.updatedAt) || 0, Number(a.updatedAt) || 0,
      Number(t.startedAt) || 0, Number(a.startedAt) || 0,
      Number(t.createdAt) || 0,
    );
    const idleMin = Math.max(0, Math.round((now - ref) / 60000));
    if (idleMin >= stallMin) {
      stalled.push({
        id: t.id,
        worker: t.worker || a.worker || null,
        idleMin,
        text: String(t.textPreview || t.text || "").slice(0, 60),
        rounds: Number(a.rounds ?? t.rounds) || 0,
        steps: Number(a.steps ?? t.steps) || 0,
      });
    }
    const d = detectWorkerDrift({
      ...t,
      tools: a.tools ?? t.tools,
      rounds: a.rounds ?? t.rounds,
      steps: a.steps ?? t.steps,
    }, { repeatThreshold: repeat, roundSpinRounds: spin });
    if (d) {
      drifting.push({
        id: t.id,
        worker: t.worker || a.worker || null,
        kind: d.kind,
        detail: d.kind === "tool_repeat" ? `${d.tool}×${d.count}` : `轮次${d.rounds}/步数${d.steps}`,
        rounds: Number(a.rounds ?? t.rounds) || 0,
        steps: Number(a.steps ?? t.steps) || 0,
      });
    }
  }
  stalled.sort((x, y) => y.idleMin - x.idleMin);
  return {
    ts: now,
    level: stalled.length || drifting.length ? "warn" : "ok",
    counts: { live: live.length, working: working.length, waiting: live.length - working.length },
    stalled: stalled.slice(0, max),
    drifting: drifting.slice(0, max),
    thresholds: { stallMinutes: stallMin, driftRepeat: repeat, driftRounds: spin },
  };
}

// 一次 HTTP JSON 请求: 失败返回结构化错误 (不抛), 供 CLI 以退出码表达。
async function requestJson(fetchImpl, baseUrl, pathname, {
  method = "GET", body = null, token = null, timeoutMs = EXTERNAL_WATCHDOG_DEFAULTS.timeoutMs,
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(100, Number(timeoutMs) || EXTERNAL_WATCHDOG_DEFAULTS.timeoutMs));
  if (typeof timer.unref === "function") timer.unref();
  try {
    const headers = { accept: "application/json" };
    if (body != null) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(new URL(pathname, baseUrl), {
      method, headers, signal: ctrl.signal,
      ...(body == null ? {} : { body }),
    });
    const text = await res.text();
    let json = null;
    let parseError = null;
    if (text) {
      try { json = JSON.parse(text); } catch (e) { parseError = e?.message || "JSON 解析失败"; }
    }
    if (!res.ok) {
      return {
        ok: false, status: res.status,
        error: (json && (json.error || json.reason)) || parseError || text.slice(0, 200) || `HTTP ${res.status}`,
      };
    }
    if (parseError) return { ok: false, status: res.status, error: parseError };
    return { ok: true, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === "AbortError" ? "请求超时" : (e?.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 外部看门狗客户端 (可注入 fetch, 便于离线测试)。
 *   pollOnce({ act, maxActions }) → 结构化报告; 自愈/取消只在 act=true 时发生。
 *   未显式给 token 时先读 /api/bootstrap (仅回环请求会下发 authToken)。
 */
export function createExternalWatchdog({
  baseUrl = "http://127.0.0.1:8899",
  token = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = EXTERNAL_WATCHDOG_DEFAULTS.timeoutMs,
  now = Date.now,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("external-watchdog: 运行环境缺少 fetch (需要 Node >= 20)");
  let authToken = token ? String(token) : null;
  const base = String(baseUrl || "http://127.0.0.1:8899");

  async function ensureToken() {
    if (authToken) return authToken;
    const r = await requestJson(fetchImpl, base, "/api/bootstrap", { timeoutMs });
    if (r.ok && r.json && typeof r.json.authToken === "string" && r.json.authToken) {
      authToken = r.json.authToken;
    }
    return authToken;
  }

  async function pollOnce({
    act = false,
    maxActions = EXTERNAL_WATCHDOG_DEFAULTS.maxActions,
    stallMinutes = EXTERNAL_WATCHDOG_DEFAULTS.stallMinutes,
    driftRepeat = EXTERNAL_WATCHDOG_DEFAULTS.driftRepeat,
    driftRounds = EXTERNAL_WATCHDOG_DEFAULTS.driftRounds,
    reason = "external_watchdog",
  } = {}) {
    const tk = await ensureToken();
    const list = await requestJson(fetchImpl, base,
      "/api/tickets?status=working,waiting&limit=200&assignments=1",
      { token: tk, timeoutMs });
    if (!list.ok) {
      return {
        ok: false, level: "crit", error: list.error, status: list.status,
        auth: { token: Boolean(tk) },
        counts: { live: 0, working: 0, waiting: 0 }, stalled: [], drifting: [], actions: [],
      };
    }
    const report = evaluateTickets(list.json?.tickets, { now: now(), stallMinutes, driftRepeat, driftRounds });
    const actions = [];
    if (act) {
      const cap = Math.max(0, Math.trunc(Number(maxActions) || 0));
      const candidates = [
        ...report.stalled.map((x) => ({ ...x, kind: "stall" })),
        ...report.drifting.map((x) => ({ ...x, kind: x.kind })),
      ];
      const seen = new Set();
      for (const c of candidates) {
        if (actions.length >= cap) break;
        if (seen.has(c.id)) continue; // 同一工单停滞且漂移只处置一次
        seen.add(c.id);
        const r = await requestJson(fetchImpl, base, "/api/tickets", {
          method: "POST", token: tk, timeoutMs,
          body: JSON.stringify({ op: "cancel", id: c.id, reason: `${reason}:${c.kind}` }),
        });
        const rejected = r.ok && !(r.json && r.json.ok);
        actions.push({
          id: c.id, kind: c.kind,
          ok: r.ok && !rejected,
          status: r.status,
          error: r.ok ? (rejected ? (r.json?.reason || r.json?.error || "rejected") : null) : r.error,
        });
      }
    }
    return {
      ok: true,
      ts: report.ts,
      level: report.level,
      auth: { token: Boolean(tk) },
      counts: report.counts,
      stalled: report.stalled,
      drifting: report.drifting,
      thresholds: report.thresholds,
      actions,
    };
  }

  return { pollOnce, baseUrl: base, hasToken: () => Boolean(authToken) };
}
