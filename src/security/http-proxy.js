// src/security/http-proxy.js - 零依赖代理抓取 (国内访问 GitHub 等被墙站点) + 出站边界
// 2026-11-12 从 utils 迁入安全层: SSRF 校验 / 跨源凭据剥离 / 响应体上限都是安全职责,
// 不是通用工具函数。
// 设计:
//   - 代理解析顺序: config.network.proxy 显式配置 > 环境变量 (HTTPS_PROXY/HTTP_PROXY/ALL_PROXY)
//     > 自动探测本地常见代理端口 (clash 7890/7897, v2rayN 10808/10809, 通用 1080/8118/8889...)
//   - 抓取: 有代理时走系统自带 curl (-x 代理, --compressed 解 gzip, -m 超时), 零依赖且经过实战考验;
//     无代理或 curl 不可用 → 回退 Node 原生 fetch (原行为)。
//   - 返回 Response 兼容对象 { status, ok, headers:{get,has}, text(), json() }, 调用方无感替换 fetch。

import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const COMMON_LOCAL_PORTS = [7890, 7897, 10809, 10808, 1080, 8118, 8889, 33210];

function normalizeProxy(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!s) return "";
  return /^[a-z]+:\/\//i.test(s) ? s : "http://" + s;
}

// 显式配置 / 环境变量里的代理 (同步, 无探测)
export function configuredProxy(config = {}) {
  const c = (config && config.network && config.network.proxy) || "";
  if (c) return normalizeProxy(c);
  for (const k of PROXY_ENV_KEYS) {
    const v = process.env[k];
    if (v) return normalizeProxy(v);
  }
  return "";
}

// 探测本地常见代理端口是否在监听 (300ms 超时)
function detectLocalProxy(ports = COMMON_LOCAL_PORTS) {
  const probe = (port) => new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; s.destroy(); res(v); };
    s.setTimeout(300, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
  return (async () => {
    for (const port of ports) if (await probe(port)) return "http://127.0.0.1:" + port;
    return "";
  })();
}

// 完整解析: 显式 > 环境 > 探测 (auto_proxy !== false 时才探测, 默认开)
export async function resolveProxy(config = {}) {
  const c = configuredProxy(config);
  if (c) return c;
  const auto = !config || !config.network || config.network.auto_proxy !== false;
  if (auto) return await detectLocalProxy();
  return "";
}

// 模块级缓存 (同一进程配置稳定, 只解析一次, 避免每次工具调用都探测端口)
let _cached = null;
export function getProxy(config = {}) {
  if (_cached === null) {
    _cached = resolveProxy(config).then((p) => {
      // console 例外 (2026-11-08 登记): PPX_VERBOSE 环境变量门控的调试口, 刻意不走 logger
  // (logger 默认 info 级会吞掉 debug, 会改变 PPX_VERBOSE 的既有语义)。
  if (p && process.env.PPX_VERBOSE) console.error("[proxy] 使用代理:", p);
      return p || "";
    }).catch(() => "");
  }
  return _cached;
}

let _curlOk;
function curlAvailable() {
  if (_curlOk !== undefined) return _curlOk;
  try { execFileSync("curl", ["--version"], { stdio: "ignore" }); _curlOk = true; }
  catch { _curlOk = false; }
  return _curlOk;
}

// GitHub 镜像兜底 (无代理时的国内可用方案): 直连失败时改写 URL 走公共镜像
const GH_HOST_RE = /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/;
const GH_MIRROR_PREFIXES = ["https://ghproxy.net/", "https://ghfast.top/", "https://gh-proxy.com/"];
export function githubMirrorUrls(input) {
  let u;
  try { u = new URL(String(input)); } catch { return null; }
  if (!GH_HOST_RE.test(u.hostname)) return null;
  const raw = u.toString();
  return GH_MIRROR_PREFIXES.map((p) => p + raw);
}

// 2026-11-12 (出站抓取内存上限): 此前所有路径都把响应整包读进内存 —— 公网页面/被投毒
//   接口返回几个 GB 就能把 agent 进程打爆 (fetch_page/web_search 都直连不可信站点)。
//   init.maxBytes 覆盖上限; 超限即截断并主动断开上游, 返回值带 truncated 标记。
//   注意: 上限只作用于"读正文", 不影响大文件流式下载 (update/index.js 用原生 fetch)。
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function normalizeMaxBytes(v) {
  if (v === Infinity || v === 0) return Infinity;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_BYTES;
  return Math.floor(n);
}

// 收集 Node Readable 到上限。destroyTargets: 截断时一并断开的对象 (解码器/上游 socket)。
function collectCapped(stream, maxBytes, destroyTargets = []) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let truncated = false;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err && !truncated) reject(err);
      else resolve({ buffer: Buffer.concat(chunks), truncated });
    };
    stream.on("data", (c) => {
      if (settled) return;
      const room = maxBytes - total;
      if (c.length > room) {
        if (room > 0) chunks.push(c.subarray(0, room));
        total = maxBytes;
        truncated = true;
        for (const t of destroyTargets) { try { t.destroy(); } catch { /* 已关闭 */ } }
        try { stream.destroy(); } catch { /* 已关闭 */ }
        finish();
        return;
      }
      chunks.push(c);
      total += c.length;
    });
    stream.on("end", () => finish());
    stream.on("close", () => finish());
    stream.on("error", (e) => finish(e));
  });
}

// 读取 Web ReadableStream 到上限 (原生 fetch 走这里)。超限时 cancel, 不再继续下载。
async function readWebStreamCapped(body, maxBytes) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const room = maxBytes - total;
      if (buf.length > room) {
        if (room > 0) chunks.push(buf.subarray(0, room));
        total = maxBytes;
        truncated = true;
        try { await reader.cancel(); } catch { /* 上游已断 */ }
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } catch (e) {
    if (!truncated) throw e;
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

function responseFromBuffer(resp, buffer, truncated) {
  const text = buffer.toString("utf8");
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return {
    status: resp.status,
    ok: resp.ok,
    headers: resp.headers,
    url: resp.url,
    truncated,
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => ab,
  };
}

// 原生 fetch 响应加读取上限。maxBytes=Infinity 时原样返回 (保留 body 流给调用方)。
async function capNativeResponse(resp, maxBytes) {
  if (!resp || typeof resp !== "object" || maxBytes === Infinity) return resp;
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const buf = Buffer.from(await resp.text(), "utf8");
    const truncated = buf.length > maxBytes;
    return responseFromBuffer(resp, truncated ? buf.subarray(0, maxBytes) : buf, truncated);
  }
  const { buffer, truncated } = await readWebStreamCapped(resp.body, maxBytes);
  return responseFromBuffer(resp, buffer, truncated);
}

// 通过代理或镜像抓取。返回与 fetch 兼容的轻量 Response。
// 有代理 → curl; 无代理 → 原生 fetch, GitHub 直连失败再试镜像。
export async function proxiedFetch(input, init = {}, proxy) {
  const maxBytes = normalizeMaxBytes(init && init.maxBytes);
  if (proxy) {
    if (!curlAvailable()) return capNativeResponse(await fetch(input, init), maxBytes);
    return curlFetch(input, init, proxy);
  }
  // 2026-11-12 (SSRF DNS 重绑定 TOCTOU): 调用方已解析并校验过目标 IP 时, 直连该 IP,
  //   不再让底层 fetch 重新解析 —— 否则攻击者可控 DNS 可以"校验时给公网、连接时给内网"。
  //   Host 头与 TLS servername 仍用原主机名, 虚拟主机与证书校验语义不变。
  if (init && init.pinnedAddress) {
    const { pinnedAddress, ...realInit } = init;
    try {
      return await pinnedFetch(input, realInit, pinnedAddress);
    } catch (e) {
      const mirrors = githubMirrorUrls(input);
      if (!mirrors) throw e;
      for (const m of mirrors) {
        try { return await capNativeResponse(await fetch(m, realInit), maxBytes); } catch { /* 下一镜像 */ }
      }
      throw e;
    }
  }
  try {
    return await capNativeResponse(await fetch(input, init), maxBytes);
  } catch (e) {
    const mirrors = githubMirrorUrls(input);
    if (!mirrors) throw e;
    for (const m of mirrors) {
      try { return await capNativeResponse(await fetch(m, init), maxBytes); } catch { /* 下一镜像 */ }
    }
    throw e;
  }
}

function decodeStream(res) {
  const enc = String(res.headers["content-encoding"] || "").toLowerCase().trim();
  if (enc === "gzip" || enc === "x-gzip") return zlib.createGunzip();
  if (enc === "deflate") return zlib.createInflate();
  if (enc === "br") return zlib.createBrotliDecompress();
  return null;
}

// 直连指定 IP 的 fetch 兼容实现 (node:http/https, 零依赖)。
//   host 用已校验 IP; Host 头与 TLS servername 用原主机名 —— 与 fetch 对请求目标的语义一致。
//   解码走流式 zlib (解压炸弹同样受 maxBytes 截断), 不再 Buffer.concat 整包后一次性解压。
function pinnedFetch(input, init = {}, address) {
  return new Promise((resolve, reject) => {
    const u = new URL(String(input));
    const isHttps = u.protocol === "https:";
    const hostname = u.hostname.replace(/^\[|\]$/g, "");
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) {
      if (v == null) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    for (const k of Object.keys(headers)) if (k.toLowerCase() === "host") delete headers[k];
    headers.Host = u.host;
    const body = init.body == null ? null : String(init.body);
    if (body != null) headers["Content-Length"] = Buffer.byteLength(body);
    const timeoutMs = Number(init.timeoutMs) || 20000;
    const maxBytes = normalizeMaxBytes(init.maxBytes);
    const opts = {
      host: address,
      port: u.port || (isHttps ? 443 : 80),
      path: (u.pathname || "/") + (u.search || ""),
      method: String(init.method || "GET").toUpperCase(),
      headers,
      timeout: timeoutMs,
    };
    if (isHttps && !net.isIP(hostname)) opts.servername = hostname;
    if (init.signal) opts.signal = init.signal;
    const req = (isHttps ? https : http).request(opts, (res) => {
      const decoder = decodeStream(res);
      const src = decoder || res;
      if (decoder) {
        res.on("error", (e) => { try { decoder.destroy(e); } catch { /* 已销毁 */ } });
        res.pipe(decoder);
      }
      collectCapped(src, maxBytes, decoder ? [res, decoder] : [res]).then(({ buffer, truncated }) => {
        const text = buffer.toString("utf8");
        const headMap = new Map();
        for (const [k, v] of Object.entries(res.headers)) {
          headMap.set(k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v));
        }
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: {
            get: (n) => (headMap.has(String(n).toLowerCase()) ? headMap.get(String(n).toLowerCase()) : null),
            has: (n) => headMap.has(String(n).toLowerCase()),
          },
          truncated,
          text: async () => text,
          json: async () => JSON.parse(text),
          arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        });
      }).catch(reject);
    });
    req.on("timeout", () => { req.destroy(new Error("请求超时 (" + timeoutMs + "ms)")); });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function curlFetch(input, init, proxy) {
  const method = (init.method || "GET").toUpperCase();
  const timeoutMs = init.timeoutMs || 20000;
  const headers = init.headers || {};
  const args = ["-sS", "--compressed", "-D", "-", "-o", "-", "-m", String(Math.round(timeoutMs / 1000)), "-x", proxy, "-X", method];
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    args.push("-H", `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  let body = init.body;
  if (body != null) { args.push("--data-binary", "@-"); }
  args.push(String(input));

  let out;
  try {
    out = execFileSync("curl", args, {
      input: body != null ? Buffer.from(String(body)) : undefined,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    const hint = e && e.stderr ? String(e.stderr).slice(0, 300) : (e && e.message || "未知错误");
    throw new Error("代理抓取失败: " + hint);
  }

  const raw = Buffer.isBuffer(out) ? out : Buffer.from(out);
  const sep = raw.indexOf(Buffer.from("\r\n\r\n"));
  const headPart = sep >= 0 ? raw.subarray(0, sep).toString("latin1") : raw.toString("latin1");
  let bodyPart = sep >= 0 ? raw.subarray(sep + 4) : Buffer.alloc(0);
  const maxBytes = normalizeMaxBytes(init && init.maxBytes);
  let truncated = false;
  if (bodyPart.length > maxBytes) {
    bodyPart = bodyPart.subarray(0, maxBytes);
    truncated = true;
  }
  const status = Number((headPart.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0);
  const headMap = new Map();
  for (const line of headPart.split("\r\n").slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headMap.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const text = bodyPart.toString("utf8");
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (n) => headMap.get(String(n).toLowerCase()) || null,
      has: (n) => headMap.has(String(n).toLowerCase()),
    },
    truncated,
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => bodyPart.buffer.slice(bodyPart.byteOffset, bodyPart.byteOffset + bodyPart.byteLength),
  };
}
