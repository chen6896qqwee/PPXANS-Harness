// src/aml-server.js - AML (Agent Memory Leaderboard) 适配服务
// 提供 Add + Search 契约, 映射进 FactStore (BM25 + bigram 检索, scope 隔离)
// 端点:
//   POST /v1/memories/add    同步存储 (消息完整落盘且可检索后才返回), 回显 request_id
//   POST /v1/memories/search query + scope + top_k 检索
//   GET  /health
// 鉴权: PPX_AML_AUTH = token|bearer|x-api-key|none (默认 none)
//       PPX_AML_AUTH_VALUE = 对应密钥
// 启动: node src/aml-server.js   (监听 PPX_AML_PORT, 默认 8900)
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { FactStore } from "./memory/fact-store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PPX_AML_PORT || 8900);
const AUTH_SCHEME = (process.env.PPX_AML_AUTH || "none").toLowerCase();
const AUTH_VALUE = process.env.PPX_AML_AUTH_VALUE || "";
const MAX_BODY = 1024 * 1024; // 1MB 请求体上限, 防滥用
const RATE_PER_MIN = 60;      // 每 IP 每分钟最大请求数 (令牌桶, 对齐 http.js)
const RATE_WINDOW_MS = 60_000;

// 数据目录: 每次调用现读环境变量 (不在模块加载期固化)
function amlDataDir() {
  return process.env.PPX_AML_DATA || path.join(ROOT, "data", "aml");
}

// 记忆库懒初始化 (2026-10-03 修复)
// 原先写的是模块顶层 `const store = new FactStore(DATA, {})` —— ESM 静态 import 会在任何
// 调用方代码之前执行, 于是测试里"先设 process.env.PPX_AML_DATA 再 createAmlServer()"完全无效:
// store 早已指向真实 <root>/data/aml。后果是**每跑一轮测试就往生产数据目录写记录**
// (实测 data/aml/memory/facts.json 每轮 +2 条, 内容与测试用例一致)。
// 改为懒加载: 首次真正用到时才读环境变量建库, import 本身零副作用。
let _store = null;
function getStore() {
  if (!_store) _store = new FactStore(amlDataDir(), {});
  return _store;
}
const _buckets = new Map(); // ip -> {tokens, last}

// 桶回收 (2026-10-03 修复): 变源 IP 长期运行时 _buckets 无界增长 → 超过阈值时
// 摊还回收 "2 倍窗口未活跃" 的过期桶 (对齐 utils/rate-limit.js 的 sweep 策略)
function sweepBuckets(now) {
  if (_buckets.size < 512) return;
  for (const [k, b] of _buckets) {
    if (now - b.last > RATE_WINDOW_MS * 2) _buckets.delete(k);
  }
}

// 简单令牌桶限流: 每 IP 60 req/min (对齐 channels/http.js) [P1#10]
function rateLimit(req, res) {
  const ip = req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  sweepBuckets(now);
  let b = _buckets.get(ip);
  if (!b) {
    b = { tokens: RATE_PER_MIN, last: now };
    _buckets.set(ip, b);
  }
  const refill = Math.floor((now - b.last) / RATE_WINDOW_MS);
  if (refill > 0) {
    b.tokens = Math.min(RATE_PER_MIN, b.tokens + refill * RATE_PER_MIN);
    b.last = now;
  }
  if (b.tokens <= 0) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
    res.end(JSON.stringify({ error: "rate limited" }));
    return false;
  }
  b.tokens -= 1;
  return true;
}

// 恒定时间比较 (2026-10-03 修复): 原 === 直接比较存在计时侧信道;
// 先 sha256 摘要拉平长度再 timingSafeEqual (对齐 channels/http.js 的 safeEqual)
function safeEqual(a, b) {
  const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
  try { return crypto.timingSafeEqual(sha(a), sha(b)); } catch { return false; }
}

function authOk(req) {
  if (AUTH_SCHEME === "none") return true;
  if (AUTH_SCHEME === "token") return safeEqual(req.headers.authorization, "Token " + AUTH_VALUE);
  if (AUTH_SCHEME === "bearer") return safeEqual(req.headers.authorization, "Bearer " + AUTH_VALUE);
  if (AUTH_SCHEME === "x-api-key") return safeEqual(req.headers["x-api-key"], AUTH_VALUE);
  return false;
}

// 读取请求体, 带大小上限。
// 2026-10-03 修复: 原实现用字符串累加 `d += c`, 多字节 UTF-8 字符跨 TCP 分块边界
// 会被切成 U+FFFD, 中文消息静默损坏 (utils/http.js 修过一模一样的 bug)。
// 改为先 Buffer.concat 再整体 toString("utf8")。
// 返回: { ok: true, body } | { ok: false, tooBig } (tooBig → 413, 非法 JSON → 400)
function readBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return; // 已超限, 丢弃后续数据但不断连 (让 handler 回 413)
      size += c.length;
      if (size > maxBytes) { tooBig = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return resolve({ ok: false, tooBig: true });
      try { resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
      catch { resolve({ ok: false, tooBig: false }); }
    });
    req.on("error", () => resolve({ ok: false, tooBig: false }));
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// Add: messages[] -> 每条存为带 scope + 结构化元数据(role/seq/timestamp) 的 fact
// 保留 role/顺序/时间, 支撑 AML 多跳/时间/关系维度
// 同步语义 = 全部落盘且可检索后才返回
async function handleAdd(req, res) {
  const parsed = await readBody(req);
  if (!parsed.ok) return send(res, parsed.tooBig ? 413 : 400, { error: parsed.tooBig ? "request body too large" : "invalid JSON body" });
  const body = parsed.body;
  if (!body || !Array.isArray(body.messages)) return send(res, 422, { error: "messages[] required" });
  const { request_id, messages, scope, conversation_id, async_mode } = body;
  if (scope == null) return send(res, 422, { error: "scope required" });
  let stored = 0;
  messages.forEach((m, i) => {
    const content = String(m?.content || "").trim();
    if (!content) return;
    const meta = {
      seq: i, // 保留对话内顺序
    };
    if (m.role != null) meta.role = String(m.role); // 保留 speaker
    if (m.timestamp != null) meta.timestamp = m.timestamp; // 保留原始时间戳
    if (conversation_id != null) meta.conversation_id = String(conversation_id);
    getStore().add(content, { type: "message", source: "aml", dedupe: false, scope: String(scope), meta });
    stored += 1;
  });
  // request_id 原样回显; 同步模式已完成存储
  return send(res, 200, {
    request_id: request_id ?? null,
    status: "ok",
    stored,
    scope: String(scope),
    conversation_id: conversation_id ?? null,
    async_mode: async_mode || false,
  });
}

async function handleSearch(req, res) {
  const parsed = await readBody(req);
  if (!parsed.ok) return send(res, parsed.tooBig ? 413 : 400, { error: parsed.tooBig ? "request body too large" : "invalid JSON body" });
  const body = parsed.body;
  const query = String(body?.query || "").trim();
  const scope = body?.scope ?? null;
  const top_k = Math.min(Number(body?.top_k || 10), 100);
  if (!query) return send(res, 422, { error: "query required" });
  const hits = getStore().query(query, { limit: top_k || 10, scope: scope == null ? null : String(scope) });
  return send(res, 200, {
    query,
    scope: scope ?? null,
    count: hits.length,
    results: hits.map((h) => ({ id: h.id, content: h.content, score: Math.round(h.effectiveScore * 100) / 100 })),
  });
}

export function createAmlServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!rateLimit(req, res)) return;
    // /health 免鉴权 (2026-10-03 修复): 监控系统探活惯例不带业务 token。
    // 注意仍受限流约束 (在 rateLimit 之后), 与测试 "限流 429 (60/min 令牌桶)" 的口径一致。
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
    if (!authOk(req)) return send(res, 401, { error: "unauthorized" });
    const pathname = url.pathname;
    if (req.method === "POST" && pathname === "/v1/memories/add") return handleAdd(req, res);
    if (req.method === "POST" && pathname === "/v1/memories/search") return handleSearch(req, res);
    return send(res, 404, { error: "not found" });
  });
}

// CLI 入口: 直接运行本文件时启动服务器
// 2026-10-03 修复 (P0): 原判断 `import.meta.url === \`file:///${argv1.replace(/\\\\/g, "/")}\``
// 正则写成了 /\\\\/g (匹配两个连续反斜杠), Windows argv1 是单反斜杠 → 替换不生效 →
// 条件恒 false → `node src/aml-server.js` 静默退出。改用 pathToFileURL 规范比较。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = createAmlServer();
  server.listen(PORT, () => {
    console.log(`[aml-server] listening on :${PORT} | auth=${AUTH_SCHEME} | data=${amlDataDir()}`);
    console.log(`  POST /v1/memories/add    POST /v1/memories/search    GET /health`);
  });
}
