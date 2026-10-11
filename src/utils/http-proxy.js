// src/utils/http-proxy.js - 零依赖代理抓取 (国内访问 GitHub 等被墙站点)
// 设计:
//   - 代理解析顺序: config.network.proxy 显式配置 > 环境变量 (HTTPS_PROXY/HTTP_PROXY/ALL_PROXY)
//     > 自动探测本地常见代理端口 (clash 7890/7897, v2rayN 10808/10809, 通用 1080/8118/8889...)
//   - 抓取: 有代理时走系统自带 curl (-x 代理, --compressed 解 gzip, -m 超时), 零依赖且经过实战考验;
//     无代理或 curl 不可用 → 回退 Node 原生 fetch (原行为)。
//   - 返回 Response 兼容对象 { status, ok, headers:{get,has}, text(), json() }, 调用方无感替换 fetch。

import { execFileSync } from "node:child_process";
import net from "node:net";

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
export function detectLocalProxy(ports = COMMON_LOCAL_PORTS) {
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
      if (p && process.env.PPX_VERBOSE) console.error("[proxy] 使用代理:", p);
      return p || "";
    }).catch(() => "");
  }
  return _cached;
}

// 供测试重置缓存
export function _resetProxyCache() { _cached = null; }

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

// 通过代理或镜像抓取。返回与 fetch 兼容的轻量 Response。
// 有代理 → curl; 无代理 → 原生 fetch, GitHub 直连失败再试镜像。
export async function proxiedFetch(input, init = {}, proxy) {
  if (proxy) {
    if (!curlAvailable()) return fetch(input, init);
    return curlFetch(input, init, proxy);
  }
  try {
    return await fetch(input, init);
  } catch (e) {
    const mirrors = githubMirrorUrls(input);
    if (!mirrors) throw e;
    for (const m of mirrors) {
      try { return await fetch(m, init); } catch { /* 下一镜像 */ }
    }
    throw e;
  }
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
  const bodyPart = sep >= 0 ? raw.subarray(sep + 4) : Buffer.alloc(0);
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
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}
