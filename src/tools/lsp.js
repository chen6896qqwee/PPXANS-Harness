// src/tools/lsp.js - 语言服务器工具 (架构优化 ⑦, 2026-11-13): 借用 LSP 这个标准轮子
//
// 缺口 (对照 GitHub 同类 harness): OpenCode / Oh My Pi / Crush / DeepSeek Harness 都已经把
//   **语言服务器**接成工具 (definition / references / hover / diagnostics)。本仓的代码理解
//   只有两种来源: 自建 repomap (词法级) + 让模型自己 grep 后读文件。模型想知道
//   "这个符号在哪定义、谁在引用、类型是什么", 只能靠猜 + 一个个读 —— 这活儿 IDE 十年前就
//   标准化了 (LSP), 没有理由重造一套符号索引。
//
// 做法: 一个极简 LSP 客户端 (JSON-RPC over stdio, Content-Length 分帧) + 按扩展名选服务器。
//   - 服务器由用户环境决定 (typescript-language-server / pyright / gopls / rust-analyzer ...),
//     探测不到就明确告诉模型"没装", 不假装能查;
//   - 进程按 (语言, 根目录) 常驻并复用, didOpen 缓存文件内容, 文件改动后由 mtime 触发重开;
//   - 零运行时依赖: 只用 node:child_process, 服务器是**可选外部程序**, 缺失不影响启动。
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { noteCatch } from "../utils/catch-log.js";

// ---- 分帧 (LSP 用 Content-Length: N\r\n\r\n + JSON) ----
export function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

// 从缓冲里切出完整帧; 返回 { messages, rest }
export function decodeFrames(buf) {
  const messages = [];
  let rest = buf;
  for (;;) {
    const sep = rest.indexOf("\r\n\r\n");
    if (sep < 0) break;
    const header = rest.slice(0, sep).toString("ascii");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { rest = rest.slice(sep + 4); continue; }
    const len = Number(m[1]);
    const start = sep + 4;
    if (rest.length < start + len) break;
    const body = rest.slice(start, start + len).toString("utf8");
    rest = rest.slice(start + len);
    try { messages.push(JSON.parse(body)); } catch (e) { noteCatch(e); /* 坏帧丢弃, 不拖垮后续帧 */ }
  }
  return { messages, rest };
}

// 常见的语言服务器 (命令探测按此顺序, 找到第一个就用)
export const KNOWN_SERVERS = [
  { language: "typescript", ext: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], command: "typescript-language-server", args: ["--stdio"] },
  { language: "python", ext: [".py"], command: "pyright-langserver", args: ["--stdio"] },
  { language: "python", ext: [".py"], command: "pylsp", args: [] },
  { language: "go", ext: [".go"], command: "gopls", args: [] },
  { language: "rust", ext: [".rs"], command: "rust-analyzer", args: [] },
  { language: "c", ext: [".c", ".h", ".cpp", ".cc", ".hpp"], command: "clangd", args: [] },
];

function commandExists(cmd) {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(probe, [cmd], { stdio: "ignore", timeout: 3000, windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}

// 按扩展名挑一个真的装了的服务器; 返回 null = 本机没有对应语言服务器
export function pickServer(filePath, { servers = KNOWN_SERVERS, exists = commandExists } = {}) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  const cands = servers.filter((s) => (s.ext || []).includes(ext));
  for (const c of cands) if (exists(c.command)) return c;
  return null;
}

export class LspClient {
  constructor({ command, args = [], cwd, timeoutMs = 8000 }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.diagnostics = new Map(); // uri -> 最新 publishDiagnostics 结果
    this.opened = new Map();      // uri -> mtimeMs
    this.dead = false;
  }

  async start() {
    if (this.proc) return this;
    this.proc = spawn(this.command, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc.on("exit", () => { this.dead = true; for (const { reject } of this.pending.values()) reject(new Error("语言服务器已退出")); this.pending.clear(); });
    this.proc.stderr?.on("data", () => { /* 服务器日志不进 agent 上下文 */ });
    this.proc.stdout.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      const { messages, rest } = decodeFrames(this.buf);
      this.buf = rest;
      for (const msg of messages) this._onMessage(msg);
    });
    const rootUri = "file:///" + path.resolve(this.cwd).replace(/\\/g, "/").replace(/^\//, "");
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.cwd) }],
      capabilities: { textDocument: { definition: {}, references: {}, hover: {}, publishDiagnostics: {} } },
    });
    this.notify("initialized", {});
    return this;
  }

  _onMessage(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "LSP 错误"));
      else resolve(msg.result);
      return;
    }
    // 服务器主动请求 (如 workspace/configuration): 一律回 null, 免得握手挂在等配置上
    if (msg.id != null && msg.method) { this._write({ jsonrpc: "2.0", id: msg.id, result: null }); return; }
    if (msg.method === "textDocument/publishDiagnostics") {
      this.diagnostics.set(msg.params?.uri, msg.params?.diagnostics || []);
    }
  }

  _write(obj) {
    if (!this.proc || this.dead) throw new Error("语言服务器未运行");
    this.proc.stdin.write(encodeFrame(obj));
  }

  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP 请求超时: ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this._write({ jsonrpc: "2.0", id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params) {
    try { this._write({ jsonrpc: "2.0", method, params }); } catch (e) { noteCatch(e); /* 通知失败不影响后续请求 */ }
  }

  // 打开/刷新文件 (内容变了才 didOpen/didChange)
  open(file) {
    const abs = path.resolve(file);
    const uri = "file:///" + abs.replace(/\\/g, "/").replace(/^\//, "");
    let st;
    try { st = fs.statSync(abs); } catch { return null; }
    const prev = this.opened.get(uri);
    if (prev === st.mtimeMs) return uri;
    let text = "";
    try { text = fs.readFileSync(abs, "utf8"); } catch { return null; }
    const languageId = path.extname(abs).replace(".", "") || "plaintext";
    if (prev) this.notify("textDocument/didChange", { textDocument: { uri, version: Math.floor(st.mtimeMs) }, contentChanges: [{ text }] });
    else this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
    this.opened.set(uri, st.mtimeMs);
    return uri;
  }

  async stop() {
    try { this.notify("shutdown", null); this.notify("exit", null); } catch { /* 退出握手失败就直接杀 */ }
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill(); } catch (e) { noteCatch(e); } resolve(); }, 800);
      t.unref?.();
      p.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }
}

// 结果格式化: LSP 的 Location / LocationLink / Hover 统一成人话
export function formatLocations(result, rootDir) {
  const items = Array.isArray(result) ? result : result ? [result] : [];
  const rel = (uri) => {
    const p = String(uri || "").replace(/^file:\/\/\/?/, "");
    const abs = process.platform === "win32" ? p.replace(/\//g, "\\") : p;
    const r = path.relative(rootDir, abs).replace(/\\/g, "/");
    return r && !r.startsWith("..") ? r : p;
  };
  return items.map((it) => {
    const target = it.targetUri ? { uri: it.targetUri, range: it.targetSelectionRange || it.targetRange } : it;
    const start = target.range?.start || {};
    return `${rel(target.uri)}:${(start.line ?? 0) + 1}:${(start.character ?? 0) + 1}`;
  });
}

export function formatHover(result) {
  const c = result?.contents;
  if (!c) return null;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x.value || "")).join("\n");
  return c.value || null;
}

// ---- 服务器池: 按 (命令, 根目录) 复用 ----
export function createLspPool({ rootDir, timeoutMs = 8000, clientFactory = null } = {}) {
  const pool = new Map();
  const keyOf = (srv) => `${srv.command}|${srv.args.join(" ")}|${rootDir}`;
  async function get(file, { servers, exists } = {}) {
    const srv = clientFactory ? servers?.[0] || null : pickServer(file, { servers, exists });
    if (!srv) return { error: `没有可用的语言服务器支持 ${path.extname(file) || "该文件"} (装 typescript-language-server / pyright / gopls / rust-analyzer 任一即可)` };
    const key = keyOf(srv);
    let c = pool.get(key);
    if (!c || c.dead) {
      c = clientFactory ? clientFactory(srv) : new LspClient({ ...srv, cwd: rootDir, timeoutMs });
      await c.start();
      pool.set(key, c);
    }
    return { client: c };
  }
  async function closeAll() {
    for (const c of pool.values()) { try { await c.stop(); } catch (e) { noteCatch(e); } }
    pool.clear();
  }
  return { get, closeAll, size: () => pool.size };
}

export function registerLspTools(catalog, { rootDir, config = null, pool = null }) {
  const enabled = config?.lsp?.enabled !== false;
  const clientPool = pool || createLspPool({ rootDir, timeoutMs: Number(config?.lsp?.timeout_ms) || 8000 });
  const servers = config?.lsp?.servers || KNOWN_SERVERS;

  catalog.register({
    name: "lsp",
    category: "code",
    power: "read",
    capability: { readOnly: true, riskLevel: "low", destructive: false, sideEffect: "none" },
    description:
      (enabled ? "" : "(语言服务器工具未启用: 设 config.lsp.enabled=true) ")
      + "问语言服务器要代码事实, 比自己 grep 准: definition=符号在哪定义, references=谁在引用, "
      + "hover=类型/签名/文档, diagnostics=该文件的编译/类型错误。位置用 1 基行号与列号。"
      + "需要本机装了对应语言的 LSP (typescript-language-server / pyright / gopls / rust-analyzer / clangd)。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["definition", "references", "hover", "diagnostics"], description: "要查什么" },
        path: { type: "string", description: "目标文件 (相对工作区)" },
        line: { type: "number", description: "1 基行号 (definition/references/hover 必填)" },
        character: { type: "number", description: "1 基列号, 默认 1" },
      },
      required: ["action", "path"],
    },
    execute: async (args, ctx) => {
      if (!enabled) return "[工具错误] lsp: 未启用 (config.lsp.enabled=false)";
      const action = String(args.action || "");
      const rel = String(args.path || "");
      // 路径边界: 只允许工作区内 (避免借语言服务器读任意文件)
      const abs = path.resolve(rootDir, rel);
      if (!abs.startsWith(path.resolve(rootDir))) return "[工具错误] lsp: 路径超出工作区";
      if (!fs.existsSync(abs)) return `[工具错误] lsp: 文件不存在 ${rel}`;
      let got;
      try {
        got = await clientPool.get(abs, { servers });
      } catch (e) {
        return `[工具错误] lsp: 启动语言服务器失败 — ${e.message}`;
      }
      if (got.error) return `[工具错误] lsp: ${got.error}`;
      const client = got.client;
      const uri = client.open(abs);
      if (!uri) return `[工具错误] lsp: 无法读取 ${rel}`;
      const pos = { line: Math.max(0, (Number(args.line) || 1) - 1), character: Math.max(0, (Number(args.character) || 1) - 1) };

      try {
        if (action === "definition") {
          const r = await client.request("textDocument/definition", { textDocument: { uri }, position: pos });
          const locs = formatLocations(r, rootDir);
          return locs.length ? locs.join("\n") : "(没找到定义; 确认光标位置在符号上)";
        }
        if (action === "references") {
          const r = await client.request("textDocument/references", {
            textDocument: { uri }, position: pos, context: { includeDeclaration: true },
          });
          const locs = formatLocations(r, rootDir);
          return locs.length ? `${locs.length} 处引用:\n${locs.slice(0, 200).join("\n")}` : "(没有引用)";
        }
        if (action === "hover") {
          const r = await client.request("textDocument/hover", { textDocument: { uri }, position: pos });
          const text = formatHover(r);
          return text ? String(text).slice(0, 4000) : "(该位置没有可用信息)";
        }
        if (action === "diagnostics") {
          // 拉模式优先 (LSP 3.17), 服务器不支持就退回等 publishDiagnostics 一瞬
          let diags = null;
          try {
            const r = await client.request("textDocument/diagnostic", { textDocument: { uri } });
            diags = r?.items || null;
          } catch { /* 不支持拉模式: 走推送 */ }
          if (!diags) {
            client.open(abs); // 触发一次 didOpen → 服务器推送
            diags = client.diagnostics.get(uri) || [];
          }
          if (!diags.length) return "(该文件没有诊断问题)";
          return diags.slice(0, 200).map((d) => {
            const s = d.range?.start || {};
            const kind = ["", "错误", "警告", "信息", "提示"][d.severity || 1] || "问题";
            return `${rel}:${(s.line ?? 0) + 1}:${(s.character ?? 0) + 1} [${kind}] ${d.message}`;
          }).join("\n");
        }
        return `[工具错误] lsp: 未知 action "${action}" (可选 definition / references / hover / diagnostics)`;
      } catch (e) {
        return `[工具错误] lsp: ${action} 失败 — ${e.message}`;
      }
    },
  });

  // 进程退出时收口语言服务器 (不挂住主进程)
  return { pool: clientPool };
}
