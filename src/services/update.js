// src/services/update.js — 自动更新 (2026-10-31, 队列⑤; 2026-11-12 并入 services)
// 此前版本发布只靠用户手动盯 GitHub Releases / npm —— 装了 3.x 的人永远不会知道 4.0 出了。
// 这里补上"检查 + 提示 + 一条命令升级", 分发形态各走各的路:
//   - npm 装机:  ppx update → npm install -g ppxans-harness@latest (显式命令才动手, 启动只提示)
//   - 源码装机:  ppx update → 打印 git pull + npm install 指引 (源码用户的本地改动不可被我们覆盖)
//   - 桌面装机:  electron/main.js 启动时查 GitHub Releases, 弹通知带下载链接 (安装包未签名,
//                静默自装会撞 SmartScreen, 且 electron-updater 是重依赖 —— 违反零依赖, 只提示不代装)
//
// 网络: 走 proxiedFetch (config.network.proxy / 环境变量 / 本地端口探测 / GitHub 镜像兜底,
// 见 src/security/http-proxy.js) —— 国内直连 registry.npmjs.org 不稳是常态, 不能裸 fetch。
// 缓存: <dataDir>/update-check.json, 默认 24h 一次 (TTL), 启动路径永不因检查阻塞/报错。
// 开关: PPX_UPDATE_CHECK=0 关闭所有检查 (含 CLI 显式 update 之外的启动通知)。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { proxiedFetch, resolveProxy } from "../security/http-proxy.js";
import { noteCatch } from "../utils/catch-log.js";

const PKG_NAME = "ppxans-harness";
const NPM_REGISTRY = "https://registry.npmjs.org";
export const RELEASES_URL = "https://github.com/chen6896qqwee/PPXANS-Harness/releases/latest";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 8000;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

// ---- 纯函数: 版本比较 (兼容 prerelease: 4.1.0-beta.1 < 4.1.0; 数字段按数值比, 不按字典序) ----
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0; // 不可解析 → 视为相等 (调用方以 sanitize 前置, 这里兜底不炸)
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  // 无 prerelease > 有 prerelease; 同有则逐段比 (数字段数值比, 标识段字典序)
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // 短的一段在前 (1.0.0-alpha < 1.0.0-alpha.1)
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (xn !== yn) return xn ? -1 : 1; // 数字段 < 标识段 (semver 规约)
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseSemver(v) {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

// 版本串卫生: 只放行 semver 形状的字符串进展示/比较 (registry/GitHub 返回什么不该信)
export function sanitizeVersion(v) {
  const s = String(v || "").trim().replace(/^v/i, "");
  return SEMVER_RE.test(s) ? s : null;
}

// 装机形态: 代码在 node_modules 里 = npm 装机 (与 datadir 外置逻辑同判据); 否则源码装机
export function detectInstallMode(root) {
  return String(root).includes("node_modules") ? "npm" : "source";
}

// ---- 缓存 (损坏容忍: 坏 JSON 当无缓存) ----
function cacheFile(dataDir) {
  return path.join(dataDir, "update-check.json");
}
function readUpdateCache(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(dataDir), "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}
function writeUpdateCache(dataDir, obj) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cacheFile(dataDir), JSON.stringify(obj, null, 2));
  } catch (e) { noteCatch(e); /* 缓存写失败不影响检查结果 */ }
}

// 远端最新版本号。channel: "npm" (registry latest) | "github" (Releases latest tag)
export async function fetchLatestVersion({ channel = "npm", fetchFn, proxy } = {}) {
  const doFetch = fetchFn || ((u, init) => proxiedFetch(u, init, proxy));
  const url = channel === "github"
    ? "https://api.github.com/repos/chen6896qqwee/PPXANS-Harness/releases/latest"
    : `${process.env.PPX_UPDATE_REGISTRY || NPM_REGISTRY}/${PKG_NAME}/latest`;
  const res = await doFetch(url, {
    headers: channel === "github"
      ? { "User-Agent": `${PKG_NAME}-update-check`, Accept: "application/vnd.github+json" }
      : { Accept: "application/json" },
    // signal 走原生 fetch; timeoutMs 走 curl 代理路径 (curlFetch 不认 signal, 见 http-proxy.js)
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "?"}`);
  const j = await res.json();
  const raw = channel === "github" ? j?.tag_name : j?.version;
  const v = sanitizeVersion(raw);
  if (!v) throw new Error(`响应版本号不合法: ${JSON.stringify(raw)?.slice(0, 60)}`);
  return v;
}

// 检查更新 (带 TTL 缓存; 网络/解析失败 → { ok:false } 永不 throw —— 启动路径零风险)
export async function checkForUpdate({
  currentVersion,
  dataDir,
  channel = "npm",
  fetchFn = null,
  proxy = null,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  force = false,
} = {}) {
  const current = sanitizeVersion(currentVersion) || "0.0.0";
  const cache = dataDir && !force ? readUpdateCache(dataDir) : null;
  if (cache && typeof cache.checkedAt === "number" && now - cache.checkedAt < ttlMs && sanitizeVersion(cache.latest)) {
    return { ok: true, fromCache: true, current, latest: cache.latest, updateAvailable: compareSemver(cache.latest, current) > 0 };
  }
  try {
    const latest = await fetchLatestVersion({ channel, fetchFn, proxy });
    if (dataDir) writeUpdateCache(dataDir, { checkedAt: now, latest, channel });
    return { ok: true, fromCache: false, current, latest, updateAvailable: compareSemver(latest, current) > 0 };
  } catch (e) {
    return { ok: false, fromCache: false, current, latest: null, updateAvailable: false, reason: String(e.message || e).slice(0, 120) };
  }
}

// 升级动作计划: ppx update 的落地形态由装机形态决定
export function planApply(mode, latestVersion) {
  if (mode === "npm") {
    return { kind: "spawn", command: `npm install -g ${PKG_NAME}@${latestVersion || "latest"}` };
  }
  return {
    kind: "manual",
    lines: [
      "源码装机不代跑升级 (本地改动不可被覆盖), 请手动:",
      "  git pull",
      "  npm install",
    ],
  };
}

// 启动通知一行 (REPL 横幅/桌面通知共用文案)
export function updateNotice(check) {
  if (!check || !check.ok || !check.updateAvailable) return "";
  return `有新版本 v${check.latest} (当前 v${check.current}) — 运行 ppx update 升级, 或到 ${RELEASES_URL} 下载`;
}

// 便捷: 代理已解析的检查入口 (CLI/doctor 用; 传 config 自动走代理链)
export async function checkWithConfig({ config, dataDir, ...rest } = {}) {
  let proxy = null;
  try { proxy = await resolveProxy(config || {}); } catch { proxy = null; }
  return checkForUpdate({ dataDir, proxy, ...rest });
}

// ==================== 桌面端安装包: 资产选择 / 校验 / 下载 ====================
// 这一段只做"可验证的下载", 不负责安装决策。安装包未签名时是否启动安装器由用户决定。

const TRUSTED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "ghproxy.net",
  "ghfast.top",
  "gh-proxy.com",
]);

export function isTrustedDownloadUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; /* swallowed-ok(2026-11-03): 非法 URL 即不可信, fail-closed */ }
  return u.protocol === "https:" && TRUSTED_DOWNLOAD_HOSTS.has(u.hostname.toLowerCase());
}

// SHA256SUMS.txt: "<64 hex>  <filename>" 或 "<64 hex> *<filename>"
export function parseChecksums(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/);
    if (!m) continue;
    const name = path.basename(m[2].trim());
    if (!name) continue;
    out[name] = m[1].toLowerCase();
  }
  return out;
}

export function checksumFor(map, filename) {
  if (!map || !filename) return null;
  if (map[filename]) return map[filename];
  const base = path.basename(filename);
  if (map[base]) return map[base];
  const lower = base.toLowerCase();
  const hit = Object.keys(map).find((k) => k.toLowerCase() === lower);
  return hit ? map[hit] : null;
}

// 按平台/架构选安装包; 选不到返回 null (由调用方回退到下载页)。
export function pickReleaseAsset(assets, { platform = process.platform, arch = process.arch } = {}) {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => a && a.name && isTrustedDownloadUrl(a.url));
  const find = (re) => list.find((a) => re.test(a.name));
  if (platform === "win32") {
    return find(/Setup-.*-x64\.exe$/i) || null;
  }
  if (platform === "darwin") {
    const want = arch === "arm64" ? "arm64" : "x64";
    return find(new RegExp(`mac-${want}\\.dmg$`, "i"))
      || find(new RegExp(`mac-${want}\\.zip$`, "i"))
      || find(/mac-x64\.dmg$/i) || null;
  }
  if (platform === "linux") {
    const want = arch === "arm64" ? "arm64" : "x64";
    return find(new RegExp(`linux-${want}\\.AppImage$`, "i"))
      || find(new RegExp(`linux-${want}\\.deb$`, "i"))
      || find(/linux-x64\.AppImage$/i) || null;
  }
  return null;
}

export function findChecksumsAsset(assets) {
  return (Array.isArray(assets) ? assets : []).find((a) => a && /^SHA256SUMS\.txt$/i.test(a.name) && isTrustedDownloadUrl(a.url)) || null;
}

export function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

// GitHub Release 元数据 (只要 tag + 资产清单; 其他字段不信任)
export async function fetchReleaseAssets({ fetchFn, proxy = null, timeoutMs = 8000 } = {}) {
  const doFetch = fetchFn || ((u, init) => proxiedFetch(u, init, proxy));
  const res = await doFetch("https://api.github.com/repos/chen6896qqwee/PPXANS-Harness/releases/latest", {
    headers: { "User-Agent": `${PKG_NAME}-desktop-update`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(timeoutMs),
    timeoutMs,
  });
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "?"}`);
  const j = await res.json();
  const tag = sanitizeVersion(j?.tag_name);
  if (!tag) throw new Error("Release tag 不合法");
  const assets = (Array.isArray(j?.assets) ? j.assets : [])
    .map((a) => ({ name: String(a?.name || ""), url: String(a?.browser_download_url || ""), size: Number(a?.size) || 0 }))
    .filter((a) => a.name && isTrustedDownloadUrl(a.url));
  return { tag, assets };
}

// 下载 + SHA-256 校验; 校验失败删除临时文件并抛错。fetchFn 可注入 (测试零网络)。
export async function downloadAsset({
  url,
  dest,
  fetchFn = null,
  expectedSha256 = "",
  onProgress = null,
  timeoutMs = 10 * 60 * 1000,
  headers = {},
} = {}) {
  if (!isTrustedDownloadUrl(url)) throw new Error("下载地址不受信任 (只允许 https 的 GitHub/镜像域名)");
  if (!dest) throw new Error("缺少目标路径");
  const doFetch = fetchFn || ((u, init) => fetch(u, init));
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.rmSync(part, { force: true }); } catch { /* 上次残留 */ }

  const res = await doFetch(url, {
    headers: { "User-Agent": `${PKG_NAME}-desktop-update`, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "?"}`);

  const total = Number(res.headers?.get?.("content-length")) || 0;
  let received = 0;
  const out = fs.createWriteStream(part);
  const write = (chunk) => new Promise((resolve, reject) => out.write(chunk, (e) => (e ? reject(e) : resolve())));
  const close = () => new Promise((resolve) => out.end(resolve));
  try {
    const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        received += buf.length;
        await write(buf);
        if (onProgress) onProgress({ received, total, ratio: total ? Math.min(1, received / total) : 0 });
      }
    } else if (typeof res.arrayBuffer === "function") {
      const buf = Buffer.from(await res.arrayBuffer());
      received = buf.length;
      await write(buf);
      if (onProgress) onProgress({ received, total: total || received, ratio: 1 });
    } else if (typeof res.text === "function") {
      const buf = Buffer.from(await res.text(), "utf8");
      received = buf.length;
      await write(buf);
      if (onProgress) onProgress({ received, total: total || received, ratio: 1 });
    } else {
      throw new Error("响应不支持读取");
    }
    await close();
  } catch (e) {
    try { await close(); } catch { /* 已关闭 */ }
    try { fs.rmSync(part, { force: true }); } catch { /* 已删除 */ }
    throw e;
  }

  const actual = sha256File(part);
  if (expectedSha256 && actual.toLowerCase() !== String(expectedSha256).toLowerCase()) {
    try { fs.rmSync(part, { force: true }); } catch { /* 已删除 */ }
    throw new Error(`SHA-256 校验失败: 期望 ${expectedSha256}, 实际 ${actual}`);
  }
  fs.renameSync(part, dest);
  return { file: dest, bytes: received, sha256: actual };
}
