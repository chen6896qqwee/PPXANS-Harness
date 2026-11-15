// electron/liveness.js — 内核服务的外部存活监督 (2026-11-05)
//
// 为什么需要它: 任务级看门狗跑在 agent 进程内 (setInterval), 进程一死就一起死;
//   崩溃只能靠用户点"重启服务"。本模块跑在 Electron 主进程 (= agent 进程之外),
//   只做两件事: 探活 (HTTP /health) 与自动拉起 (指数退避, 限次)。
// 边界: 不重放任务、不碰工单状态 —— 恢复语义仍归 workgraph (mark-only 默认)。
// 全部依赖注入 (probe/restart/sleep/now), 因此可离线单测。
export function nextRestartDelay(attempt, { base = 1000, cap = 30000 } = {}) {
  const n = Math.max(1, Math.trunc(Number(attempt) || 1));
  return Math.min(cap, base * (2 ** (n - 1)));
}

export function createLivenessSupervisor({
  probe, restart, onExhausted = null, onEvent = null, isQuitting = () => false,
  maxRestarts = 3, windowMs = 5 * 60000,
  baseDelayMs = 1000, capDelayMs = 30000,
  probeIntervalMs = 15000, probeFailures = 3,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let restarts = [];
  let busy = false;
  let timer = null;
  let probeFails = 0;

  const ev = (type, payload = {}) => {
    try { onEvent?.(type, payload); } catch { /* 观测不阻断监督 */ }
  };

  async function restartOnce(reason) {
    if (busy || isQuitting()) return false;
    busy = true;
    try {
      const t = now();
      restarts = restarts.filter((x) => t - x < windowMs);
      if (restarts.length >= maxRestarts) {
        ev("supervisor/exhausted", { reason, attempts: restarts.length });
        try { onExhausted?.(reason); } catch { /* 兜底 UI 失败不抛 */ }
        return false;
      }
      restarts.push(t);
      const attempt = restarts.length;
      const delay = nextRestartDelay(attempt, { base: baseDelayMs, cap: capDelayMs });
      ev("supervisor/restarting", { reason, attempt, delay });
      if (delay > 0) await sleep(delay);
      if (isQuitting()) return false;
      const ok = await restart();
      ev(ok ? "supervisor/restarted" : "supervisor/restart_failed", { attempt });
      return ok;
    } finally {
      busy = false;
    }
  }

  // 子进程 exit/spawn error 直接触发 (比探活快)
  function noteGone(reason = "exit") {
    return restartOnce(reason);
  }

  // 探活循环: 覆盖"进程活着但服务卡死"的情况 (exit 事件永远不来)
  function startProbeLoop() {
    if (timer || typeof probe !== "function") return;
    timer = setInterval(async () => {
      if (busy || isQuitting()) return;
      let ok = false;
      try {
        const h = await probe();
        ok = !!h && h.app === "ppxans-harness" && h.__verified !== false;
      } catch { ok = false; }
      probeFails = ok ? 0 : probeFails + 1;
      if (probeFails >= probeFailures) {
        const failures = probeFails;
        probeFails = 0;
        ev("supervisor/probe_failed", { failures });
        await restartOnce("probe");
      }
    }, probeIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    noteGone,
    startProbeLoop,
    stop,
    getStats: () => ({ restarts: restarts.length, busy, probeFails }),
  };
}
