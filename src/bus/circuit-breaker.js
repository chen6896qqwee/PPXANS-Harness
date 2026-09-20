// src/bus/circuit-breaker.js - 订阅者/策略订阅者熔断器 (P0④)
// 吸收 Aegis/HookBus 的熔断器模式: Closed → Open → Half-Open 三态, 保护总线/策略链不被故障订阅者拖垮。
// 与 src/agent/index.js 的"探索循环熔断"(agent 行为层) 互补: 这里是基础设施层 (订阅者健康)。
// 设计:
//   - Closed: 正常调用, 失败计数累加; 窗口内失败超阈值 → Open
//   - Open:   短路拒绝调用 (走 failPolicy: fail-closed 抛错 / fail-open 透传默认), 冷却期后 → Half-Open
//   - Half-Open: 放行单个探测调用; 成功 → Closed; 失败 → Open
// 零依赖, 纯 Node 原生。
export class CircuitBreaker {
  constructor({ threshold = 3, windowMs = 60000, cooldownMs = 10000, failPolicy = "fail-open" } = {}) {
    this.threshold = threshold;          // 窗口内失败次数阈值
    this.windowMs = windowMs;            // 统计窗口 (默认 60s)
    this.cooldownMs = cooldownMs;        // Open 冷却期 (默认 10s)
    this.failPolicy = failPolicy;        // Open 期间行为: fail-open (放行/返回fallback) | fail-closed (抛错)
    this._state = "closed";              // closed | open | half_open
    this._failures = [];                 // 窗口内失败时间戳
    this._openedAt = 0;
    this._probeAt = 0;                   // half_open 探测放行时刻 (探测超时兜底用)
    this._calls = 0;
    this._opens = 0;
    this._probeFailures = 0;
  }

  get state() { return this._state; }

  // 清理窗口外的失败记录 (滑动窗口)
  _prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this._failures = this._failures.filter((t) => t >= cutoff);
  }

  // 调用前判断是否允许放行; 不允许时按 failPolicy 返回 { allowed:false, fallback }
  before() {
    const now = Date.now();
    this._calls++;
    if (this._state === "closed") return { allowed: true };
    if (this._state === "open") {
      if (now - this._openedAt >= this.cooldownMs) {
        this._state = "half_open";
        this._probeAt = now;
        return { allowed: true, probe: true }; // 探测放行
      }
      if (this.failPolicy === "fail-closed") return { allowed: false, reason: "circuit-open" };
      return { allowed: true, degraded: true }; // fail-open: 放行但标记降级
    }
    // half_open: 只放一个探测, 其余短路。
    // 2026-09-18 修复 (P2): 探测方若从不回报 after() (调用方遗漏/崩溃), 原实现永久卡死在
    //   half_open 全拒绝。兜底: 探测放行超过一个冷却期仍无回报, 允许重新探测。
    if (now - this._probeAt >= this.cooldownMs) {
      this._probeAt = now;
      return { allowed: true, probe: true, reprobe: true };
    }
    return { allowed: false, reason: "circuit-half-open" };
  }

  // 调用结果上报: ok = 调用是否成功 (订阅者是否健康)
  after(ok) {
    const now = Date.now();
    if (this._state === "half_open") {
      if (ok) { this._state = "closed"; this._failures = []; }
      else { this._state = "open"; this._openedAt = now; this._opens++; this._probeFailures++; }
      return this._state;
    }
    if (!ok) {
      this._failures.push(now);
      this._prune(now);
      if (this._failures.length >= this.threshold) {
        this._state = "open";
        this._openedAt = now;
        this._opens++;
      }
    } else {
      // 成功可重置部分失败计数 (不立即关闭, 防抖动)
      this._prune(now);
    }
    return this._state;
  }

  // 手动复位
  reset() {
    this._state = "closed";
    this._failures = [];
    this._openedAt = 0;
    return this;
  }

  // 统计 (可观测)
  stats() {
    return {
      state: this._state,
      calls: this._calls,
      opens: this._opens,
      probeFailures: this._probeFailures,
      threshold: this.threshold,
      windowMs: this.windowMs,
      cooldownMs: this.cooldownMs,
      failPolicy: this.failPolicy,
      recentFailures: this._failures.length,
    };
  }

  // 包装器: 把任意 async fn 包上熔断。open 时按 failPolicy 返回 fallback 或抛错。
  wrap(fn, { fallback = null } = {}) {
    return async (...args) => {
      const verdict = this.before();
      if (!verdict.allowed || verdict.degraded) {
        // open 期: fail-closed 抛错; fail-open (含降级标记) 返回 fallback
        if (this.failPolicy === "fail-closed") throw new Error(`circuit ${verdict.reason}`);
        return typeof fallback === "function" ? fallback(...args) : fallback;
      }
      try {
        const r = await fn(...args);
        this.after(true);
        return r;
      } catch (e) {
        this.after(false);
        throw e;
      }
    };
  }
}

export default CircuitBreaker;
