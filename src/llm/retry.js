// src/llm/retry.js - 错误重试内核 (设计溯源 docs/PROVENANCE.md#openclaw retry/operation-retry 精华)
// 设计要点:
//  - 瞬态分类: 429/5xx/timeout/网络错误 才重试; 400/401/403/404 等客户端错误立即失败
//  - 指数退避 + full jitter (避免惊群); 尊重 Retry-After 头
//  - 可取消 (AbortSignal)
//  - LLM 失败不 throw 的契约由上层 (provider 回退) 承担, 本模块只负责"单次调用内"的重试
//
// 2026-11-01 (v4.2, 雷仔对齐): 新增错误三态分类 classifyHttp + 诊断落盘 dumpLlmDiag ——
//  零依赖项目没有 APM, "文件即可观测性": 每次失败归类 {reason, retryable, needsUserAction},
//  needsUserAction (凭据/余额/404) 驱动 UI 明确提示而不是无限重试; 失败请求脱敏落盘供排障。

import { noteCatch } from "../utils/catch-log.js";
import fs from "node:fs";
import path from "node:path";

// 从错误对象/消息提取 HTTP 状态码
export function httpStatusOf(err) {
  if (!err) return null;
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  const m = String(err.message || err).match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}

// ========================= 错误三态分类 (v4.2, 雷仔 classifyHttp 对齐) =========================
// 返回 {reason, retryable, needsUserAction, userHint?}:
//   reason          机器可读归因 (auth/balance/not_found/rate_limit/server/timeout/network/aborted/...)
//   retryable       上层 provider 回退链是否值得再试
//   needsUserAction true = 继续重试无意义, 必须用户处理 (驱动 UI 常驻提示, 不做静默重试)
export function classifyHttp(err) {
  if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
    return { reason: "aborted", retryable: false, needsUserAction: false };
  }
  const status = httpStatusOf(err);
  if (status === 401 || status === 403) {
    return { reason: "auth", retryable: false, needsUserAction: true, userHint: "API Key 无效或无权限 — 请检查该提供商的密钥配置" };
  }
  if (status === 402) {
    return { reason: "balance", retryable: false, needsUserAction: true, userHint: "账户余额不足 — 请前往提供商控制台充值" };
  }
  if (status === 404) {
    return { reason: "not_found", retryable: false, needsUserAction: true, userHint: "接口 404 — 请检查 base_url / API 协议 / 模型 ID 是否匹配" };
  }
  if (status === 429) return { reason: "rate_limit", retryable: true, needsUserAction: false };
  if (status >= 500) return { reason: "server", retryable: true, needsUserAction: false };
  if (status === 400 || status === 422) return { reason: "bad_request", retryable: false, needsUserAction: false };
  if (status) return { reason: "http_" + status, retryable: false, needsUserAction: false };
  const msg = String(err?.message || err || "");
  if (/timeout|timed?\s*out|ETIMEDOUT|socket hang up/i.test(msg)) {
    return { reason: "timeout", retryable: true, needsUserAction: false };
  }
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch failed|network|undici/i.test(msg)) {
    return { reason: "network", retryable: true, needsUserAction: false };
  }
  return { reason: "unknown", retryable: isTransientError(err), needsUserAction: false };
}

// ========================= 诊断落盘 (文件即可观测性) =========================
// 密钥脱敏: Bearer/x-api-key 头、sk- 形态 key、显式传入的敏感值统一打码
export function redactSecrets(text, extraKeys = []) {
  let s = String(text ?? "");
  for (const k of extraKeys) {
    if (k && k.length > 6) s = s.split(k).join("***REDACTED***");
  }
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***");
  s = s.replace(/(x-api-key["':=\s]+)[A-Za-z0-9._-]+/gi, "$1***");
  s = s.replace(/\bsk-[A-Za-z0-9]{8,}\b/g, "sk-***");
  return s;
}

// 诊断目录解析: PPX_DATA_DIR > 测试临时根 (test-run 注入) > <cwd>/data
// 测试里若没显式设 PPX_DATA_DIR, 失败诊断不再写进仓库 data/ (污染工作树)
function diagDir() {
  if (process.env.PPX_DATA_DIR) return process.env.PPX_DATA_DIR;
  if (process.env.PPX_TEST_TMP_ROOT) return path.join(process.env.PPX_TEST_TMP_ROOT, "data");
  return path.join(process.cwd(), "data");
}

// 失败请求落盘: <dataDir>/logs/llm/last-error.json (覆写) + 保留最近 3 份带时间戳快照。
// 任何 IO 失败静默吞掉 (诊断绝不能把主链路带崩)。
export function dumpLlmDiag({ providerId, model, protocol, url, status, classified, requestBody, responseText, secret }) {
  try {
    const dir = path.join(diagDir(), "logs", "llm");
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      ts: new Date().toISOString(),
      provider: providerId || null,
      model: model || null,
      protocol: protocol || null,
      url: url ? redactSecrets(url, secret ? [secret] : []) : null,
      status: status ?? null,
      classified: classified || null,
      request: requestBody ? redactSecrets(typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody), secret ? [secret] : []).slice(0, 4000) : null,
      response: responseText ? redactSecrets(responseText, secret ? [secret] : []).slice(0, 2000) : null,
    };
    const file = path.join(dir, "last-error.json");
    // 轮转: 已有 last-error → 快照 (保留 3 份)
    try {
      if (fs.existsSync(file)) {
        const snap = path.join(dir, `last-error-${Date.now()}.json`);
        fs.renameSync(file, snap);
        const snaps = fs.readdirSync(dir).filter((f) => /^last-error-\d+\.json$/.test(f)).sort();
        while (snaps.length > 3) fs.unlinkSync(path.join(dir, snaps.shift()));
      }
    } catch (e) { noteCatch(e); /* 轮转失败不阻断落盘 */ }
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
  } catch (e) { noteCatch(e); /* 静默 */ }
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
