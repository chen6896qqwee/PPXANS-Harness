// webapp/src/api/client.js - 客户端统一请求层
// 自 public/api.js (2026-11-05) 移植, 语义保持:
//   1. GET 合流: 同路径并发 GET 共用一个 Promise;
//   2. 429 节流: 读 Retry-After 记全局窗口; quiet(轮询) 立即失败, 交互类短等待重试;
//   3. 状态订阅: 每秒广播剩余秒数, 窗口结束广播「已恢复」由 UI 补拉;
//   4. 统一错误: 401 交 unauthorized 钩子 (chat store 的刷新流程), 超时/断连给中文文案。
// 不缓存响应体 —— 面板显示的是会变的事实, 宁可多打一次也不显示旧账。

import { bootData, authToken } from "../boot.js";
import { apiUrl, authHeaders } from "./url.js";

const cfg = { base: "", unauthorized: null };
const inflight = Object.create(null);   // "GET /path" -> Promise
const throttle = { until: 0, timer: null, subs: [] };

export function base() {
  const b = bootData();
  return cfg.base || (b && b.base) || "";
}

function now() { return Date.now(); }

function statusSnapshot() {
  const left = Math.max(0, throttle.until - now());
  return { throttled: left > 0, retryInMs: left, retryInSec: Math.ceil(left / 1000) };
}
function emit() {
  const s = statusSnapshot();
  throttle.subs.slice().forEach((fn) => {
    try { fn(s); } catch { /* 订阅者异常不能反过来打断请求层 */ }
  });
}
function schedule() {
  if (throttle.timer) return;
  throttle.timer = setTimeout(() => {
    throttle.timer = null;
    if (!throttle.until) return;
    if (now() >= throttle.until) {
      throttle.until = 0;
      emit(); // 窗口结束: 订阅者据此补拉一轮
      return;
    }
    emit();  // 每秒刷新剩余秒数
    schedule();
  }, 1000);
}
function hold(ms) {
  const until = now() + Math.max(0, Math.min(Number(ms) || 0, 65000));
  if (until <= throttle.until + 250) { schedule(); return; }
  throttle.until = until;
  emit();
  schedule();
}
export function retryNow() {
  const was = throttle.until;
  throttle.until = 0;
  if (throttle.timer) { clearTimeout(throttle.timer); throttle.timer = null; }
  if (was) emit();
  return statusSnapshot();
}

function mkErr(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status || 0;
  e.retryAfter = extra.retryAfter || 0;
  e.throttled = !!extra.throttled;
  e.network = !!extra.network;
  return e;
}
function retryMs(res) {
  let raw = "";
  try { raw = res.headers && res.headers.get ? res.headers.get("Retry-After") : ""; } catch { raw = ""; }
  const sec = parseFloat(raw);
  return isFinite(sec) && sec >= 0 ? Math.min(sec * 1000, 65000) : 10000;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function doFetch(path, opts, attempt) {
  const method = String(opts.method || "GET").toUpperCase();
  // 2026-11-14 (战役遗留项 #8): 地址与鉴权头改走 url.js 纯函数 —— 与 sse.js 同一实现
  const headers = authHeaders(authToken(), opts.headers || {});
  if (opts.body != null && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const init = { method, headers, cache: "no-store" };
  if (opts.body != null) init.body = opts.body;
  let ctrl = null;
  let kill = null;
  const timeout = opts.timeout === 0 ? 0 : (opts.timeout || 30000);
  if (timeout && typeof AbortController !== "undefined") {
    ctrl = new AbortController();
    init.signal = ctrl.signal;
    kill = setTimeout(() => ctrl.abort(), timeout);
  }

  return fetch(apiUrl(base(), path), init).then(async (res) => {
    if (kill) { clearTimeout(kill); kill = null; }
    if (res.status === 401) {
      markUnauthorized();
      throw mkErr(401, "鉴权失败 (401): 访问令牌无效或已过期");
    }
    if (res.status === 429) {
      const ms = retryMs(res);
      hold(ms);
      const sec = Math.ceil(ms / 1000);
      // 只对「很快就能恢复」的窗口做自动重试; 令牌桶要等满一分钟时,
      // 让请求立刻失败并在界面上显示倒计时, 比把点击挂住 60 秒更诚实。
      if (!opts.quiet && attempt < (opts.retries == null ? 0 : opts.retries) && ms <= 5000) {
        await sleep(ms + 200 + Math.round(Math.random() * 300));
        return doFetch(path, opts, attempt + 1);
      }
      throw mkErr(429, "服务繁忙, 请稍后重试", { retryAfter: sec, throttled: true });
    }
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw mkErr(res.status, (j && (j.error || j.message)) || ("HTTP " + res.status));
    }
    return res.json().catch(() => null);
  }, (e) => {
    if (kill) clearTimeout(kill);
    if (e && (e.name === "AbortError" || e.code === 20)) {
      throw mkErr(0, "连接超时, 本地服务没有响应");
    }
    throw mkErr(0, "连不上本地服务, 请确认它还在运行", { network: true });
  });
}

export function request(path, opts = {}) {
  const method = String(opts.method || "GET").toUpperCase();
  const key = method + " " + path;
  const wait = Math.max(0, throttle.until - now());

  if (wait > 0) {
    if (opts.quiet) {
      return Promise.reject(mkErr(429, "本地限流中, 数据稍后自动补上", { retryAfter: Math.ceil(wait / 1000), throttled: true }));
    }
    // 交互请求: 只剩两三秒就等一等, 还很久就直接告诉用户, 由 UI 的重试按钮接管
    if (wait > 2500) {
      return Promise.reject(mkErr(429, "服务繁忙, 约 " + Math.ceil(wait / 1000) + " 秒后自动恢复", { retryAfter: Math.ceil(wait / 1000), throttled: true }));
    }
    return sleep(wait + 120).then(run);
  }
  return run();

  function run() {
    if (method === "GET" && inflight[key]) return inflight[key];
    const p = doFetch(path, opts, 0);
    if (method === "GET") {
      inflight[key] = p;
      const done = () => { if (inflight[key] === p) delete inflight[key]; };
      p.then(done, done);
    }
    return p;
  }
}

export function configure(o) {
  if (!o) return;
  if (o.base != null) cfg.base = String(o.base);
  if (typeof o.onUnauthorized === "function") cfg.unauthorized = o.onUnauthorized;
}

// 401 钩子的对外出口 (2026-11-14): sse.js 的流式请求也走统一鉴权口径 —— 流式拿到 401 时
//   同样触发 unauthorized 刷新流程, 不再只有常规请求享受。
export function markUnauthorized() {
  if (typeof cfg.unauthorized === "function") {
    try { cfg.unauthorized(); } catch { /* 刷新流程自己兜底 */ }
  }
}

export const get = (path, opts) => request(path, Object.assign({ timeout: 30000 }, opts || {}));
export const post = (path, body, opts) => request(path, Object.assign({ method: "POST", body: JSON.stringify(body || {}) }, opts || {}));
export const put = (path, body, opts) => request(path, Object.assign({ method: "PUT", body: JSON.stringify(body || {}) }, opts || {}));
export const del = (path, body, opts) => request(path, Object.assign({ method: "DELETE", body: body == null ? undefined : JSON.stringify(body) }, opts || {}));

export function onStatus(fn) {
  if (typeof fn !== "function") return () => {};
  throttle.subs.push(fn);
  try { fn(statusSnapshot()); } catch { /* 首次回调异常忽略 */ }
  return () => {
    const i = throttle.subs.indexOf(fn);
    if (i >= 0) throttle.subs.splice(i, 1);
  };
}
