// src/llm/retry.js - 错误重试内核 (吸收 OpenClaw retry/operation-retry 精华)
// 设计要点:
//  - 瞬态分类: 429/5xx/timeout/网络错误 才重试; 400/401/403/404 等客户端错误立即失败
//  - 指数退避 + full jitter (避免惊群); 尊重 Retry-After 头
//  - 可取消 (AbortSignal)
//  - LLM 失败不 throw 的契约由上层 (provider 回退) 承担, 本模块只负责"单次调用内"的重试

// 从错误对象/消息提取 HTTP 状态码
export function httpStatusOf(err) {
  if (!err) return null;
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  const m = String(err.message || err).match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}

// 瞬态分类: 值得重试的错误 (openclaw operation-retry: 429/5xx/ENOTFOUND/timeout/fetch failed)
export function isTransientError(err) {
  // v1.0.9: AbortError (用户主动取消 / 内部超时中止) 一律不重试 — 原把 message "aborted" 判瞬态, 取消后仍退避重试
  if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) return false;
  const status = httpStatusOf(err);
  if (status) {
    if (status === 429 || status >= 500) return true;
    if (status >= 400 && status < 500) return false; // 客户端错误不重试
  }
  const msg = String(err?.message || err || "");
  if (/timeout|timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up|undici/i.test(msg)) return true;
  return false;
}

// Retry-After (秒), 无则 null (上限 30s 防恶意长退避)
export function retryAfterSeconds(err) {
  const raw = err?.headers?.get?.("retry-after") ?? err?.retryAfter ?? err?.retry_after;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(n, 30);
  return null;
}

// 指数退避 + full jitter
export function backoffMs(attempt, { baseMs = 500, factor = 2, maxMs = 10000 } = {}) {
  const exp = Math.min(maxMs, baseMs * Math.pow(factor, attempt));
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

// 可取消 sleep (AbortSignal)
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); cleanup(); reject(abortError()); };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    function cleanup() { if (signal) signal.removeEventListener("abort", onAbort); }
  });
}

function abortError() { const e = new Error("aborted"); e.name = "AbortError"; return e; }

// 重试执行器: fn 抛瞬态错误时按退避重试, 非瞬态直接抛
export async function withRetry(fn, { maxRetries = 3, baseMs = 500, factor = 2, maxMs = 10000, signal = null, shouldRetry = isTransientError } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= maxRetries || !shouldRetry(e)) throw e;
      const ra = retryAfterSeconds(e);
      const ms = ra != null ? ra * 1000 : backoffMs(attempt, { baseMs, factor, maxMs });
      await sleep(ms, signal);
    }
  }
  throw lastErr;
}
