// src/tools/net-guard.js - 出站 HTTP 的 SSRF 防线 (fetch_page / http_request / browse 共用)
// 2026-11-12 自 advanced.js 拆出: 防护判据与工具注册无关, 独立成模块后 browse / document
//   等其它出站路径可以只依赖这一层, 不把整个工具集拖进来。
import net from "node:net";
import dns from "node:dns/promises";
import { proxiedFetch, DEFAULT_MAX_BYTES } from "../security/http-proxy.js";

// 2026-09-18 修复 (P1): 原实现只按 IPv4 点分十进制判断, IPv6 字面量 (parts.length !== 4)
//   直接返回 false → http://[::1]/ http://[fe80::x]/ http://[fc00::x]/ 全部被当"公网"放行,
//   可打本机回环与内网服务。现补齐 IPv6 判定 (回环/未指定/链路本地/唯一本地 fc00::/7),
//   并处理 IPv4-mapped IPv6 (::ffff:127.0.0.1 等)。导出供回归测试使用。
// 2026-10-30 二次加固: 旧实现只认 `::ffff:a.b.c.d` 点分写法, 而 URL 解析器会把
//   `http://[::ffff:127.0.0.1]/` 规范化成 `[::ffff:7f00:1]` —— 十六进制写法直接绕过。
//   现改为完整解析 8 组 16-bit 段, 覆盖 IPv4-mapped / IPv4-compatible / NAT64 (64:ff9b::/96)
//   / 6to4 (2002::/16) / Teredo / ULA / 链路本地 / 站点本地 / 组播 / 文档网段, 并对
//   内嵌 IPv4 的过渡机制继续做 v4 私网判定。
const V4_META = [[169, 254, 169, 254], [100, 100, 100, 200]]; // AWS/GCP/Azure + 阿里云元数据

function isPrivateIPv4(a, b, c, d) {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (a === 0) return true;                                   // 0.0.0.0/8
  if (a === 10) return true;                                  // 10/8
  if (a === 127) return true;                                 // 127/8 回环
  if (a === 169 && b === 254) return true;                    // 169.254/16 链路本地/云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
  if (a === 192 && b === 168) return true;                    // 192.168/16
  if (a === 192 && b === 0 && c === 0) return true;           // 192.0.0/24
  if (a === 192 && b === 0 && c === 2) return true;           // 192.0.2/24 文档
  if (a === 198 && (b === 18 || b === 19)) return true;       // 198.18/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true;        // 198.51.100/24 文档
  if (a === 203 && b === 0 && c === 113) return true;         // 203.0.113/24 文档
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 CGNAT
  if (a >= 224) return true;                                  // 组播 + 保留 + 广播
  return V4_META.some(([x, y, z, w]) => a === x && b === y && c === z && d === w);
}

// 解析 IPv6 字面量为 8 个 16-bit 整数; 非法返回 null。支持 `::` 压缩与末尾内嵌 IPv4。
function parseIPv6(input) {
  let s = String(input || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  s = s.split("%")[0]; // zone id (fe80::1%eth0)
  let tail = [];
  const v4m = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4m) {
    const v = v4m[1].split(".").map(Number);
    if (v.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tail = [(v[0] << 8) | v[1], (v[2] << 8) | v[3]];
    s = s.slice(0, -v4m[1].length).replace(/:$/, "");
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part) => {
    if (!part) return [];
    const out = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  if (!head) return null;
  if (halves.length === 1) {
    const all = head.concat(tail);
    return all.length === 8 ? all : null;
  }
  const rest = parse(halves[1]);
  if (!rest) return null;
  const right = rest.concat(tail);
  const fill = 8 - head.length - right.length;
  if (fill < 0) return null;
  return head.concat(new Array(fill).fill(0), right);
}

const v4FromGroups = (hi, lo) => isPrivateIPv4(hi >> 8, hi & 0xff, lo >> 8, lo & 0xff);

function isPrivateIPv6(groups) {
  const g = groups;
  const isZero = (i, n) => g.slice(i, i + n).every((x) => x === 0);
  // ::ffff:0:0/96 IPv4-mapped
  if (isZero(0, 5) && g[5] === 0xffff) return v4FromGroups(g[6], g[7]);
  // ::/96 IPv4-compatible (已废弃) + :: / ::1
  if (isZero(0, 6)) return v4FromGroups(g[6], g[7]);
  // 64:ff9b::/96 NAT64 (内嵌 IPv4)
  if (g[0] === 0x0064 && g[1] === 0xff9b && isZero(2, 4)) return v4FromGroups(g[6], g[7]);
  // 2002::/16 6to4 (内嵌 IPv4)
  if (g[0] === 0x2002) return v4FromGroups(g[1], g[2]);
  if ((g[0] & 0xfe00) === 0xfc00) return true;                 // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true;                 // fe80::/10 链路本地
  if ((g[0] & 0xffc0) === 0xfec0) return true;                 // fec0::/10 站点本地 (废弃)
  if ((g[0] & 0xff00) === 0xff00) return true;                 // ff00::/8 组播
  if (g[0] === 0x0100 && isZero(1, 3)) return true;            // 100::/64 discard
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;         // 2001:db8::/32 文档
  if (g[0] === 0x2001 && g[1] === 0x0000) return true;         // 2001::/32 Teredo
  if (g[0] === 0x2001 && g[1] === 0x0002) return true;         // 2001:2::/48 基准测试
  return false;
}

export function isPrivateIP(ip) {
  if (!ip) return false;
  const s = String(ip).trim().replace(/^\[|\]$/g, "");
  const kind = net.isIP(s);
  if (kind === 4) {
    const p = s.split(".").map(Number);
    return isPrivateIPv4(p[0], p[1], p[2], p[3]);
  }
  if (kind === 6) {
    const groups = parseIPv6(s);
    return groups ? isPrivateIPv6(groups) : true; // 解析失败按内网处理 (fail closed)
  }
  return false;
}

// 回环判定 (allowLoopback 语义用): IPv4 127/8 与 IPv6 ::1。注意与 isPrivateIP 的分工 ——
//   私网/链路/云元数据是"凭证窃取目标"必须拒; 回环是"agent 自己机器上的第一方服务"
//   (本地开发服务器/测试桩), browse 桌面渲染通道本就可达, 直抓通道保持同一口径。
function isLoopbackIP(ip) {
  if (net.isIP(ip) === 4) return ip.split(".")[0] === "127";
  const g = parseIPv6(ip);
  return !!g && g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
}

// 2026-11-08 改导出: browse 工具兜底直抓路径复用同一 SSRF 防线 (此前 browse 用
//   redirect:"follow" 且不做公网校验, 公网 URL 302→内网即可绕过, 与 fetch_page 防护不一致)。
// opts.allowLoopback: 放行回环字面量与解析到回环的主机名 (127.0.0.1/::1/localhost) ——
//   供 browse 本地开发场景用; 链路地址/私网/云元数据 (169.254.169.254) 不在豁免内, 照拒。
// 2026-11-12 (SSRF DNS 重绑定 TOCTOU): 返回值改为"已校验的直连地址" (无代理时)。
//   原实现只做校验不返回地址, 真正连接时 fetch 会再解析一次 DNS —— 攻击者把 TTL 调到 0,
//   校验拿到公网 IP、连接时换成 127.0.0.1/169.254.169.254 即可绕过。调用方把返回地址传给
//   proxiedFetch({pinnedAddress}) 直连, DNS 只解析这一次。
//   返回 null 表示无需固定 (走代理: 真实连接由代理发起).
export async function assertPublicUrl(url, opts = {}) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("仅允许 http/https");
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      if (opts.allowLoopback && isLoopbackIP(hostname)) return hostname;
      throw new Error("SSRF 拒绝: 内网地址 " + hostname);
    }
    return hostname;
  }
  // 走代理时: 真实连接由代理发起, 本地 DNS 解析结果不再代表实际目标,
  //   跳过 dns.lookup (避免"污染解析到内网 IP 误杀"或"本地解析失败"阻断代理链路);
  //   但仍保留上面针对【字面量内网 IP】的硬拦截。
  if (opts.viaProxy) return null;
  const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  const verified = [];
  for (const { address } of addrs) {
    if (isPrivateIP(address)) {
      if (opts.allowLoopback && isLoopbackIP(address)) { verified.push(address); continue; }
      throw new Error("SSRF 拒绝: " + hostname + " 解析到内网 " + address);
    }
    verified.push(address);
  }
  return verified[0] || null;
}

// body 序列化: null/undefined → 无 body; 字符串原样; 其余 JSON 序列化。
// 曾用 `body !== undefined` 判定, 漏掉 null → GET 请求被塞 body:"null" 而报
// "Request with GET/HEAD method cannot have body"。抽出纯函数便于回归测试钉死。
export function serializeRequestBody(body) {
  return body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
}

// 带 SSRF 校验的安全 fetch: 手动跟随重定向, 并对每一跳(含首发)都做 assertPublicUrl 校验。
// fetch 默认 redirect:"follow" 会在每次跳转时重新解析 DNS —— 攻击者用一个公网 URL 302→内网
// (如 http://127.0.0.1:x 或 http://169.254.169.254/)即可绕过单次 assertPublicUrl。
// 这里改用 redirect:"manual" 逐跳校验后再继续, 堵住"302 到内网/云元数据"的绕过。
// 2026-11-08 改导出: browse 兜底直抓复用 (见 browse.js)。opts.firstHopAllowLoopback:
//   首跳放行回环 (browse 本地开发语义), 重定向跳仍强制公网 —— "本机服务可达, 但
//   不可被公网 URL 302 拉进内网/元数据"。
// 2026-11-12 跨源重定向剥离凭据 (fetch 规范同款): 手动跟随意味着凭据头由我们转发 ——
//   原实现原样复用 headers, 一个公网 URL 302 到攻击者域名就能拿到调用方的
//   Authorization/Cookie/Proxy-Authorization (典型是带 token 的 API 抓取被骗走)。
//   现跨源跳转前剥离这三类头; 同源 (scheme+host+port 一致) 保留。
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

// 跨源时剔除凭据类请求头。返回新对象, 不修改入参。URL 解析失败按"不同源"处理 (从严)。
export function stripSensitiveOnCrossOrigin(headers, fromUrl, toUrl) {
  const out = { ...(headers || {}) };
  let sameOrigin = false;
  try { sameOrigin = new URL(fromUrl).origin === new URL(toUrl).origin; } catch { sameOrigin = false; }
  if (sameOrigin) return out;
  for (const k of Object.keys(out)) {
    if (CREDENTIAL_HEADERS.has(k.toLowerCase())) delete out[k];
  }
  return out;
}

export async function _fetchWithSsrSafe(url, { method = "GET", headers = {}, body, signal, maxRedirects = 5, firstHopAllowLoopback = false, maxBodyBytes = DEFAULT_MAX_BYTES } = {}, proxy = "") {
  let current = url;
  let currentHeaders = headers;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const pinned = await assertPublicUrl(current, { viaProxy: !!proxy, allowLoopback: firstHopAllowLoopback && hop === 0 });
    const resp = await proxiedFetch(current, {
      method,
      headers: currentHeaders,
      body: serializeRequestBody(body),
      redirect: "manual",
      timeoutMs: 20000,
      maxBytes: maxBodyBytes,
      ...(pinned ? { pinnedAddress: pinned } : {}),
    }, proxy);
    if (resp.status >= 300 && resp.status < 400 && resp.headers.has("location")) {
      const loc = resp.headers.get("location");
      const next = new URL(loc, current).toString(); // 相对 Location 基于 current 解析成绝对 URL
      currentHeaders = stripSensitiveOnCrossOrigin(currentHeaders, current, next);
      current = next;
      method = "GET"; // 重定向后不再携带 body, 并退回 GET (302/303 语义)
      body = undefined;
      continue;
    }
    return resp;
  }
  throw new Error("SSRF 拒绝: 重定向次数超过 " + maxRedirects);
}
