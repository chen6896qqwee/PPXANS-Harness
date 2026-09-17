// src/services/memory-health.js - 记忆管线健康监控 (P1⑤)
// 吸收 HanaAgent (openhanako) 的记忆管线健康监控设计:
//   healthy / degraded / unhealthy 三态 + 分步失败计数 + 降级策略。
// 皮皮虾自研实现: 监控记忆管线各步 (滚动归档 roll / 压缩 compact / LLM 提炼 extract),
//   通过 wrap() 包裹原方法统计成败; 不健康时给出降级建议 (只写不压, 防上下文污染)。
// 纯代码可测, 不依赖 LLM。
export const HEALTH = { HEALTHY: "healthy", DEGRADED: "degraded", UNHEALTHY: "unhealthy" };

export class MemoryHealthMonitor {
  constructor({ degradeAfter = 3, unhealthyAfter = null, windowMs = 5 * 60 * 1000 } = {}) {
    this.degradeAfter = degradeAfter;   // 连续失败多少次进入 degraded
    // 修复 (2026-09-17): unhealthy 原先不可达 (status() 三元两分支都返回 HEALTHY)。
    // 现按窗口内失败数分为两档: >= degradeAfter → degraded, >= unhealthyAfter → unhealthy。
    // 默认取 degradeAfter 的两倍, 保持"降级先发生、重度降级随后"的渐进语义。
    this.unhealthyAfter = Number(unhealthyAfter) || degradeAfter * 2;
    this.windowMs = windowMs;           // 统计窗口 (默认 5 分钟)
    this.steps = new Map();             // stepName -> { ok, fail, lastError, lastAt, fails: [] }
    this.degraded = false;              // 降级开关 (只写不压)
    this.unhealthy = false;             // 重度降级 (持续失败)
    this._worst = 0;                    // 窗口内最差单步失败数 (可观测)
  }

  _step(name) {
    if (!this.steps.has(name)) {
      this.steps.set(name, { ok: 0, fail: 0, lastError: null, lastAt: 0, fails: [] });
    }
    return this.steps.get(name);
  }

  // 记录一步成功/失败
  record(name, { ok = true, error = null } = {}) {
    const s = this._step(name);
    const now = Date.now();
    s.ok += ok ? 1 : 0;
    s.lastAt = now;
    if (!ok) {
      s.fail++;
      s.lastError = error || "unknown";
      s.fails.push(now);
      // 滑动窗口裁剪
      s.fails = s.fails.filter((t) => now - t < this.windowMs);
    } else {
      s.fails = [];
    }
    this._recompute();
    return s;
  }

  // 连续失败 -> degraded / unhealthy (滑动窗口内失败数分档)
  _recompute() {
    const now = Date.now();
    let worst = 0;
    for (const s of this.steps.values()) {
      const recent = s.fails.filter((t) => now - t < this.windowMs).length;
      if (recent > worst) worst = recent;
    }
    this._worst = worst;
    this.degraded = worst >= this.degradeAfter;
    this.unhealthy = worst >= this.unhealthyAfter;
    return this.degraded;
  }

  // 包装原方法: 自动统计成败; ok 判定可自定义 (默认不抛错即成功)
  wrap(name, fn, { isOk = null } = {}) {
    return async (...args) => {
      try {
        const r = await fn(...args);
        const good = isOk ? isOk(r) : true;
        this.record(name, { ok: good });
        return r;
      } catch (e) {
        this.record(name, { ok: false, error: e?.message || String(e) });
        throw e;
      }
    };
  }

  // 状态汇总
  status() {
    const now = Date.now();
    const stepList = [...this.steps.entries()].map(([name, s]) => ({
      name,
      ok: s.ok,
      fail: s.fail,
      lastError: s.lastError,
      recentFails: s.fails.filter((t) => now - t < this.windowMs).length,
    }));
    const totalFail = stepList.reduce((a, s) => a + s.fail, 0);
    // 三态可达 (修复 2026-09-17): unhealthy > degraded > healthy
    const overall = this.unhealthy
      ? HEALTH.UNHEALTHY
      : (this.degraded ? HEALTH.DEGRADED : HEALTH.HEALTHY);
    return {
      overall,
      degraded: this.degraded,
      unhealthy: this.unhealthy,
      worstRecentFails: this._worst,
      thresholds: { degradeAfter: this.degradeAfter, unhealthyAfter: this.unhealthyAfter, windowMs: this.windowMs },
      totalFail,
      steps: stepList,
      updatedAt: now,
    };
  }

  // 降级建议 (供 memory ticker / agent 消费)
  advice() {
    if (!this.degraded) return { action: "normal" };
    if (this.unhealthy) {
      return {
        action: "degrade",
        severe: true,
        reason: `记忆管线持续失败 (窗口内 ${this._worst} 次, 已达重度阈值 ${this.unhealthyAfter}), 强制降级为只写不压`,
        // 只写不压: 跳过 LLM 压缩/提炼, 仅保留原始会话写入
        skip: ["compact", "extract"],
      };
    }
    return {
      action: "degrade",
      severe: false,
      reason: "记忆管线连续失败, 建议降级为只写不压",
      // 只写不压: 跳过 LLM 压缩/提炼, 仅保留原始会话写入
      skip: ["compact", "extract"],
    };
  }
}

export default MemoryHealthMonitor;
