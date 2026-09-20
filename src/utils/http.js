// src/utils/http.js - HTTP 请求/响应小工具 (唯一实现, 2026-09-18 重构收敛)
// 收敛前重复情况:
//   - readBody 在 channels/base、channels/http、mcp/http、aml-server 各写一份 (读循环 + 上限判定)
//   - JSON 响应样板 (writeHead + Content-Type + JSON.stringify + end) 在四处共约 20 处手写
// 提取后语义由本文件单点决定; 各调用方保留自己的错误码/降级策略 (413 写响应 vs 返回 null vs 抛错)。

// 读满请求体。
//   maxBytes > 0 时: 累计字节数超限即停止累积并返回 null, 由调用方决定回 413 / 抛错。
//   注意: 超限后仍把剩余数据读完 (只丢弃不累积), 不能中途 break —— 提前跳出 for await
//   会销毁请求流, 客户端还在上传时收不到响应, 表现为请求挂死而非 413。
// 2026-09-18 修复: 原实现按块 `body += chunk` 逐块 toString, TCP 分块边界落在多字节
//   UTF-8 字符中间时产生 U+FFFD, 中文请求体被静默损坏。现先 Buffer.concat 再整体 decode。
export async function readBody(req, { maxBytes = 0 } = {}) {
  const chunks = [];
  let total = 0;
  let overflow = false;
  for await (const chunk of req) {
    if (overflow) continue; // 已超限: 只消费不累积, 保证连接正常关闭
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buf);
    total += buf.length;
    if (maxBytes > 0 && total > maxBytes) { overflow = true; chunks.length = 0; total = 0; }
  }
  return overflow ? null : Buffer.concat(chunks).toString("utf8");
}

// 读满请求体并解析 JSON。
//   空体 → {} (与 channels/http 既有语义一致); 超限 → null; JSON 非法 → 抛错 (调用方转 400)。
export async function readJsonBody(req, { maxBytes = 0 } = {}) {
  const body = await readBody(req, { maxBytes });
  if (body === null) return null;
  return JSON.parse(body || "{}");
}

// SSE 响应头 (channels/http 与 mcp/http 的流式响应共用, 原先各写一份字面量)
// 冻结以防调用方误改共享对象; flushHeaders 的时机仍由调用方决定 (发头后应立即 flush)。
export const SSE_HEADERS = Object.freeze({
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
});

// 统一 JSON 响应。
//   obj === undefined 时只结束响应不写 body (channels/http 的 204 语义)。
//   contentLength=true 时补 Content-Length (aml-server 需要)。
export function sendJson(res, code, obj, { headers = {}, contentLength = false } = {}) {
  const body = obj === undefined ? "" : JSON.stringify(obj);
  const h = { "Content-Type": "application/json", ...headers };
  if (contentLength) h["Content-Length"] = Buffer.byteLength(body);
  res.writeHead(code, h);
  res.end(body);
}
