// src/channels/http-static.js - 静态界面/上传文件/缓存 (从 http.js 拆出, mixin 挂回 prototype)
import fs from "node:fs";
import path from "node:path";
import { LEGACY_REST_PATHS } from "./http-shared.js";

// 2026-11-02 (异步 I/O): 静态资源按需读取改为 fs.promises —— 构建产物主包原先用
//   readFileSync 在请求线程里整块读盘, 冷启动/清缓存时会把事件循环卡住; 异步读让
//   SSE 心跳与其他请求在磁盘 I/O 期间继续推进。命中内存缓存时仍完全不碰磁盘。
const fsp = fs.promises;

export const staticHttpMethods = {
// ---- 路由域 4: 静态界面 (三态返回: undefined 不匹配 / true / false) ----
async _routeStatic(req, res, get, reqPath) {
  if (!get) return undefined;

  // 首页: 服务端注入 window.__PPX_BOOTSTRAP__ (本机回环请求附带 auth token) → 单进程免配置可用
  if (reqPath === "/" || reqPath === "/index.html") {
    const html = this.renderIndex(req);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html !== null ? html : "<!DOCTYPE html><meta charset=utf-8><p>皮皮虾服务已启动, 但 dist/index.html 未找到 (先跑 npm run web:build)。</p>");
    return true;
  }
  // 通用静态文件服务 (publicDir 下任意文件: webapp/dist 产物或旧 public/, 防路径穿越)
  // 上传图片回显: /uploads/<file> → <root>/uploads/ (与前端产物同为只读静态;
  // 服务默认只绑 127.0.0.1, 风险面与前端产物一致; 文件名已在写入时消毒)
  if (reqPath.startsWith("/uploads/")) {
    const upDir = path.resolve(this.agent.root, "uploads");
    // 中文/空格文件名在 URL 里是百分号编码, 必须解码后再拼路径 (2026-10-11 修复: 中文附件回显 404)
    let rel = "";
    try { rel = decodeURIComponent(reqPath.replace(/^\/uploads\//, "")); } catch { rel = ""; }
    const file = path.resolve(upDir, rel);
    if (rel && file.startsWith(upDir + path.sep)) {
      let st = null;
      try { st = await fsp.stat(file); } catch { st = null; }
      if (st && st.isFile()) {
        // 2026-11-02: 上传回显走与静态资源同一套 ETag/304 + 有界内容缓存。
        //   上传文件写入即定名 (同名追加序号), 内容不会再变, 因此可放心给私有缓存;
        //   仍保留 ETag 校验, 手工替换同名文件后也能立刻失效。
        return this._serveUpload(req, res, file, st);
      }
    }
    return false;
  }
  if (!reqPath.startsWith("/api/") && !LEGACY_REST_PATHS.some((p) => reqPath === p)) {
    return this._serveStatic(req, res, reqPath);
  }
  return undefined;
},

// ---- 静态文件 ----
// 2026-11-02: 补 ETag/304 与有界内容缓存。签名 = size + mtimeMs, 文件一变即失效;
//   Cache-Control 仍是 no-cache (浏览器每次带 If-None-Match 校验, 命中回 304 空体),
//   不把旧 js 缓存成不可更新, 但省掉重复读盘与整包传输。
async _serveStatic(req, res, reqPath) {
  const file = path.resolve(this.publicDir, reqPath.replace(/^\//, ""));
  const notFound = () => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("未找到");
    return true;
  };
  if (!file.startsWith(this.publicDir + path.sep)) return notFound();
  let st;
  try { st = await fsp.stat(file); } catch { return notFound(); }
  if (!st.isFile()) return notFound();

  const ext = path.extname(file).toLowerCase();
  const mime = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
  }[ext] || "application/octet-stream";
  const dynamic = [".html", ".js", ".mjs", ".css"].includes(ext);
  return this._sendFileCached(req, res, file, st, mime, dynamic ? "no-cache" : null, notFound);
},

// /uploads/*: 图片等用户附件的回显。内容写入即定名, 给一天私有缓存;
// 仍带 ETag, 同名文件被替换时浏览器下次校验会拿到新内容。
async _serveUpload(req, res, file, st = null) {
  if (!st) { try { st = await fsp.stat(file); } catch { st = null; /* swallowed-ok(2026-11-03): 文件不存在/不可读 → 回 404 */ } }
  if (!st || !st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const mime = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp",
    // 2026-11-14: 音频附件回显 (语音输入/ASR 样例在浏览器里可回放)
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac",
  }[ext] || "application/octet-stream";
  return this._sendFileCached(req, res, file, st, mime, "private, max-age=86400", () => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("未找到");
    return true;
  });
},

// 共享的"带缓存静态文件"应答: ETag 弱校验 + If-None-Match 304 + 有界内容缓存。
// 上传文件与前端产物都走这里, 避免两份实现漂移; 单文件 >4MB 不常驻, 总缓存超 16MB 按插入序淘汰。
async _sendFileCached(req, res, file, st, mime, cacheControl, notFound) {
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { "Content-Type": mime, ETag: etag };
  if (cacheControl) headers["Cache-Control"] = cacheControl;

  const inm = String(req.headers?.["if-none-match"] || "");
  if (inm && inm.split(",").some((t) => t.trim() === etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  let body = null;
  const sig = `${st.size}:${st.mtimeMs}`;
  const cached = this._staticCache.get(file);
  if (cached && cached.sig === sig) body = cached.body;
  if (body === null) {
    try { body = await fsp.readFile(file); } catch { return notFound(); }
    if (body.length <= 4 * 1024 * 1024) this._cacheStatic(file, sig, body);
  }
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(body);
  return true;
},

_cacheStatic(file, sig, body) {
  const old = this._staticCache.get(file);
  if (old) this._staticCacheBytes -= old.body.length;
  this._staticCache.set(file, { sig, body });
  this._staticCacheBytes += body.length;
  const MAX_CACHE = 16 * 1024 * 1024;
  while (this._staticCacheBytes > MAX_CACHE && this._staticCache.size > 1) {
    const [k, v] = this._staticCache.entries().next().value;
    this._staticCache.delete(k);
    this._staticCacheBytes -= v.body.length;
  }
}
};
