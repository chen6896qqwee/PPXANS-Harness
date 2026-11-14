// src/channels/http-shared.js - HTTP 通道共享常量与纯函数
// 从 http.js 抽出, 供核心通道与各路由 mixin 共用; 避免 mixin 反向 import http.js 形成循环依赖。
import crypto from "node:crypto";

// SSE 心跳: 代理/浏览器会掐掉长时间无数据的连接; 25s 注释帧兼顾保活与低流量。
export const SSE_HEARTBEAT_MS = 25_000;

// REST 端点退役开关覆盖的路径 (channels.http.mcp.legacy_rest = false 时统一 410)
// 2026-11-08 口径: v5.0 前端仍依赖 /message/stream、/sessions*、/interrupt —— 默认保持开启,
// 开关真正瞄准的是无 UI 消费方的 Gen-1 非流式端点 (/message 单发 / /chat / /reset)。
export const LEGACY_REST_PATHS = ["/message", "/message/stream", "/chat", "/sessions", "/reset", "/interrupt"];

// 恒定时间字符串比较 (2026-09-17 安全修复):
// 直接 `a === b` 会在首个不同字节处提前返回, 理论上是可观测的计时侧信道。
// 先把两侧都摘要成定长 32 字节再比对, 长度差异也被消除。
// @param {string} a
// @param {string} b
// @returns {boolean}
export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const hb = crypto.createHash("sha256").update(String(b ?? "")).digest();
  try { return crypto.timingSafeEqual(ha, hb); } catch { return false; }
}

// 面向客户端的错误文案净化: 只保留业务语义, 屏蔽 Node/流内部实现细节
// (避免把 "Cannot write headers after they are sent to the client" 这类内部错误原文回给前端)
const INTERNAL_ERR_RE = /ERR_HTTP_HEADERS_SENT|ERR_STREAM_|Cannot (write headers|call write after)|write after end|EPIPE|ECONNRESET/i;
export function publicErrorMessage(e) {
  // 兼容三种入参: Error 实例 / 字符串 / 任意对象 (对象且无 message 时不该退化成 "[object Object]")
  const raw = (e && typeof e === "object" && typeof e.message === "string") ? e.message
    : (typeof e === "string" ? e : "");
  const msg = raw.trim();
  if (!msg) return "服务内部错误";
  if (INTERNAL_ERR_RE.test(msg)) return "连接状态异常, 请重试";
  return msg.slice(0, 300);
}
