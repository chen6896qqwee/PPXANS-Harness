// src/utils/rate-limit.js - 每来源令牌桶限流 (唯一实现, 2026-09-18 重构收敛)
// 原先 channels/http.js 与 aml-server.js 各写一份同逻辑令牌桶 (后者注释自述"对齐 http.js"),
// 且 aml 那份缺过期回收 —— 桶表只增不减, 长期运行 + 多变源地址会持续吃内存。
// 统一后两处共享同一实现与回收策略。
//
// 用法:
//   const limiter = new TokenBucket({ perMin: 60 });
//   if (!limiter.take(ip)) { /* 回 429 */ }
export const RATE_WINDOW_MS = 60_000;
// 桶数超过此值时顺带回收过期桶 (摊还 O(1), 不引入定时器)
const DEFAULT_SWEEP_AT = 512;

export class TokenBucket {
  constructor({ perMin = 60, windowMs = RATE_WINDOW_MS, sweepAt = DEFAULT_SWEEP_AT } = {}) {
    this.perMin = perMin;
    this.windowMs = windowMs;
    this.sweepAt = sweepAt;
    // 公开 Map: 调用方可直接观测/清理 (http 通道的测试据此注入过期桶)
    this.buckets = new Map(); // key -> { tokens, last }
  }

  // 取一个令牌。返回 false 表示本窗口已耗尽 (调用方负责写 429)。
  take(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      this.sweep(now);
      b = { tokens: this.perMin, last: now };
      this.buckets.set(key, b);
    }
    // 按窗口整数倍补充令牌 (上限 perMin)
    const refill = Math.floor((now - b.last) / this.windowMs);
    if (refill > 0) {
      b.tokens = Math.min(this.perMin, b.tokens + refill * this.perMin);
      b.last = now;
    }
    if (b.tokens <= 0) return false;
    b.tokens -= 1;
    return true;
  }

  // 回收连续两个窗口未活动的桶 (摊还成本, 防内存无界增长)
  sweep(now = Date.now()) {
    if (this.buckets.size <= this.sweepAt) return;
    const stale = now - this.windowMs * 2;
    for (const [k, b] of this.buckets) {
      if (b.last < stale) this.buckets.delete(k);
    }
  }
}
