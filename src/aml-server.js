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
import { FactStore } from "./memory/fact-store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY = 1024 * 1024; // 1MB 请求体上限, 防滥用
const RATE_PER_MIN = 60;      // 每 IP 每分钟最大请求数 (令牌桶, 对齐 http.js)
const RATE_WINDOW_MS = 60_000;

// ---- 惰性初始化 (2026-10-09) ----
// 原先这几个值在【模块顶层】读取 env 并即刻 new FactStore —— 而 ESM 的静态 import 早于
// 调用方任何代码执行, 于是测试里"先设 process.env.PPX_AML_DATA=tmp, 再 import"完全无效,
// 实例仍指向 <项目>/data/aml, 每跑一次测试就往生产数据目录写一条夹具事实。
// 改为惰性: import 保持零副作用, 首次真正用到时才读 env 建实例。
// 同时支持 env 在运行期变化 (测试逐个用例切换目录) —— 目录变了就重建。
let _store = null;
let _storeDir = null;
function amlDataDir() {
  return process.env.PPX_AML_DATA || path.join(ROOT, "data", "aml");
}
function getStore() {
  const dir = amlDataDir();
  if (!_store || _storeDir !== dir) {
    _store = new FactStore(dir, {});
    _storeDir = dir;
  }
  return _store;
}
function authScheme() { return String(process.env.PPX_AML_AUTH || "none").toLowerCase(); }
function authValue() { return process.env.PPX_AML_AUTH_VALUE || ""; }

const _buckets = new Map(); // ip -> {tokens, last}

// 简单令牌桶限流: 每 IP 60 req/min (对齐 channels/http.js) [P1#10]
function rateLimit(req, res) {
  const ip = req.socket?.remoteAddress || "unknown";
  const now = Date.now();
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
    res.end(JSON.stringify({ error: "请求过于频繁, 请稍后重试" }));
    return false;
  }
  b.tokens -= 1;
  return true;
}

function authOk(req) {
  const scheme = authScheme(), value = authValue();
  if (scheme === "none") return true;
  if (scheme === "token") return req.headers.authorization === "Token " + value;
  if (scheme === "bearer") return req.headers.authorization === "Bearer " + value;
  if (scheme === "x-api-key") return req.headers["x-api-key"] === value;
  return false;
}

// 读取请求体, 带大小上限。
// 2026-10-10 修复 (P1): 原实现对"超限"与"JSON 非法"一律返回 null, handler 只能笼统回 413 ——
//   客户端拿到 413 会以为"体太大"而截断重试, 但真正的问题是 JSON 写错 (应回 400 提示修正)。
//   现返回结构化结果区分三种情形, 由 handler 映射到 413 / 400 / 500。
// @returns {Promise<{ok:true, data:any} | {ok:false, reason:"too-large"|"bad-json"|"io"}>}
function readBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve) => {
    let d = "";
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return; // 已超限, 丢弃后续数据但不断连
      d += c;
      if (Buffer.byteLength(d) > maxBytes) { tooBig = true; d = ""; }
    });
    req.on("end", () => {
      if (tooBig) return resolve({ ok: false, reason: "too-large" });
      if (!d.trim()) return resolve({ ok: false, reason: "bad-json" }); // 空体视为非法
      try { resolve({ ok: true, data: JSON.parse(d) }); }
      catch { resolve({ ok: false, reason: "bad-json" }); }
    });
    req.on("error", () => resolve({ ok: false, reason: "io" }));
  });
}

// 把 readBody 的失败原因映射到 HTTP 状态码 + 可判读文案
function bodyErrorResponse(res, reason) {
  if (reason === "too-large") return send(res, 413, { error: "请求体过大" });
  if (reason === "bad-json") return send(res, 400, { error: "请求体不是合法 JSON" });
  return send(res, 500, { error: "读取请求体失败" });
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
  const body = await readBody(req);
  if (!body.ok) return bodyErrorResponse(res, body.reason);
  const { request_id, messages, scope, conversation_id, async_mode } = body.data || {};
  if (!Array.isArray(messages)) return send(res, 422, { error: "缺少 messages[] 字段" });
  if (scope == null) return send(res, 422, { error: "缺少 scope 字段" });
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
  const body = await readBody(req);
  if (!body.ok) return bodyErrorResponse(res, body.reason);
  const data = body.data || {};
  const query = String(data.query || "").trim();
  const scope = data.scope ?? null;
  const top_k = Math.min(Number(data.top_k || 10), 100);
  if (!query) return send(res, 422, { error: "缺少 query 字段" });
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
    if (!authOk(req)) return send(res, 401, { error: "未授权: 请提供有效的访问令牌" });
    if (!rateLimit(req, res)) return;
    const pathname = url.pathname;
    if (req.method === "POST" && pathname === "/v1/memories/add") return handleAdd(req, res);
    if (req.method === "POST" && pathname === "/v1/memories/search") return handleSearch(req, res);
    if (req.method === "GET" && pathname === "/health") return send(res, 200, { status: "ok" });
    return send(res, 404, { error: "未找到该端点" });
  });
}

// CLI 入口: 直接运行本文件时启动服务器
// 2026-10-10 修复 (P0): 原判定 `import.meta.url === file:///${argv[1].replace(/\\\\/g,"/")}`
//   恒为 false —— ① 该正则实为匹配单个反斜杠, ② import.meta.url 是 file:///C:/... (正斜杠 + 三斜杠),
//   而手工拼出的串在 Windows 上形态对不上, 于是 `node src/aml-server.js` 静默不监听 (P0-1 复现)。
//   改用 pathToFileURL 规范化两侧: 跨平台一致, 且能正确处理盘符/空格/非 ASCII 路径。
const _isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return import.meta.url === pathToFileURL(entry).href; } catch { return false; }
})();
if (_isMain) {
  const server = createAmlServer();
  const port = Number(process.env.PPX_AML_PORT || 8900);
  server.listen(port, () => {
    console.log(`[aml-server] listening on :${port} | auth=${authScheme()} | data=${amlDataDir()}`);
    console.log(`  POST /v1/memories/add    POST /v1/memories/search    GET /health`);
  });
}
