// src/tools/shell-session.js - 常驻 shell (架构优化 ⑧, 2026-11-13)
//
// 缺口 (对照 DSH / OpenHands): `run_command` 每条命令起一个新 shell —— cd 不保留、环境变量
//   不保留、激活的 venv 不保留。模型写 `cd sub && npm test` 是在绕这个问题, 写
//   `export FOO=1` 再 `npm run` 则直接无效 (第二条命令根本看不到)。DSH 的 persistent bash /
//   PTY 解决的正是这件事。
//
// 做法: 一个常驻 bash (stdin 喂命令) + 结束标记协议 (每条命令后打一行
//   `__PPX_END_<id>__<exit>`), 读到标记即判定该条完成。串行排队 (一条跑完再下一条),
//   超时就杀掉重启 —— 挂死的 shell 不能污染后续命令。
//
// 边界: 只支持 bash (Windows 走 git bash)。没有 bash 时明确回错, 让模型退回 run_command,
//   不假装持久化。安全检查与 run_command 同源 (命令守卫 + 受保护路径 + 会话内自写脚本)。
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { checkCommand, DENY_HINT } from "./command-guard.js";
import { findSessionWrittenScript } from "./builtin-paths.js";
import { noteCatch } from "../utils/catch-log.js";

export function findBash() {
  // 优先显式环境变量, 再让 PATH 自己解析 (不要用 `where` 的输出去拼路径:
  //   Windows 上 where 返回的 GBK 路径被按 UTF-8 解码会变成乱码, spawn 直接 ENOENT)
  const explicit = process.env.PPX_BASH;
  if (explicit) return explicit;
  try {
    const r = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8", timeout: 4000, windowsHide: true });
    if (r.status === 0 && String(r.stdout).includes("ok")) return "bash";
  } catch { /* 继续试固定路径 */ }
  if (process.platform === "win32") {
    const cands = [
      path.join(process.env.ProgramFiles || "C:/Program Files", "Git", "bin", "bash.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
      "C:/Program Files/Git/bin/bash.exe",
    ].filter(Boolean);
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* 下一个 */ } }
  }
  return null;
}

// git bash 报的是 MSYS 路径 (/c/Users/x); 统一成 Windows 形式, 才能和 path.resolve 对账
function msysToWin(pwd) {
  const s = String(pwd || "");
  if (s.length > 3 && s[0] === "/" && s[2] === "/" && /[a-zA-Z]/.test(s[1])) {
    return s[1].toUpperCase() + ":" + s.slice(2).split("/").join(path.sep);
  }
  return s;
}

const MAX_CAPTURE = 1024 * 1024; // 单条命令输出上限 (超出截断并标注)

export class PersistentShell {
  constructor({ shellPath = "bash", cwd, env = {}, timeoutMs = 120000 } = {}) {
    this.shellPath = shellPath;
    this.cwd = cwd;
    this.env = env;
    this.defaultTimeoutMs = timeoutMs;
    this.proc = null;
    this.dead = false;
    this.queue = Promise.resolve();
    this.startedAt = null;
    this.commands = 0;
  }

  start() {
    if (this.proc && !this.dead) return this;
    this.dead = false;
    this.proc = spawn(this.shellPath, ["-s"], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, PS1: "", PS2: "", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.on("exit", () => { this.dead = true; });
    this.proc.on("error", (e) => {
      this.dead = true;
      const p = this._pending;
      this._pending = null;
      if (p) { clearTimeout(p.timer); p.resolve({ ok: false, exit: null, stdout: "", truncated: false, timedOut: false, error: `启动 shell 失败: ${e.message}` }); }
    });
    // stderr 合并进 stdout: 模型关心的是"命令说了什么", 不是流号; 分开收会把顺序打乱
    this.proc.stderr?.on("data", (c) => this._onData(c));
    this.proc.stdout?.on("data", (c) => this._onData(c));
    this.startedAt = Date.now();
    return this;
  }

  _onData(chunk) {
    if (!this._pending) return;
    this._pending.buf += chunk.toString("utf8");
    if (this._pending.buf.length > MAX_CAPTURE) {
      this._pending.truncated = true;
      this._pending.buf = this._pending.buf.slice(0, MAX_CAPTURE);
    }
    const idx = this._pending.buf.indexOf(this._pending.marker);
    if (idx < 0) return;
    const { resolve, timer } = this._pending;
    const head = this._pending.buf.slice(0, idx).replace(/\r/g, "");
    const tail = this._pending.buf.slice(idx + this._pending.marker.length);
    // 标记行格式: <exit>|<pwd> —— pwd 用于会话内 cd 的越界校验 (见 preflight)
    const meta = /^(\d+)\|(.*)/.exec(tail);
    const exit = Number((meta && meta[1]) || 0);
    if (meta && meta[2]) this.cwd = msysToWin(meta[2].trim());
    const pending = this._pending;
    this._pending = null;
    clearTimeout(timer);
    resolve({ ok: true, exit, stdout: head.replace(/\n$/, ""), truncated: pending.truncated, timedOut: false });
  }

  // 串行执行: 同一 shell 不允许两条命令交错 (输出会串)
  run(command, { timeoutMs } = {}) {
    const task = () => this._runOnce(command, timeoutMs);
    const p = this.queue.then(task, task);
    // 队列本身不能因为一条失败就断掉
    this.queue = p.then(() => undefined, () => undefined);
    return p;
  }

  async _runOnce(command, timeoutMs) {
    if (!this.proc || this.dead) this.start();
    const id = randomBytes(4).toString("hex");
    const marker = `__PPX_END_${id}__`;
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.defaultTimeoutMs;
    this.commands += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending = null;
        // 超时 = 这条命令可能还在跑: 直接杀进程, 下次调用自动重启, 不带病复用
        this.kill();
        resolve({ ok: false, exit: null, stdout: "", truncated: false, timedOut: true, error: `命令超时 (${limit}ms), 常驻 shell 已重启` });
      }, limit);
      this._pending = { buf: "", marker, resolve, timer, truncated: false };
      try {
        // 结束标记用 echo 而不是 printf: 不需要在 JS 模板里塞反斜杠转义, 少一层出错机会
        // 输出形如 __PPX_END_ab12__0|/path/to/cwd
        this.proc.stdin.write(`${command}\necho "${marker}$?|$PWD"\n`);
      } catch (e) {
        clearTimeout(timer);
        this._pending = null;
        this.kill();
        resolve({ ok: false, exit: null, stdout: "", truncated: false, timedOut: false, error: `写入 shell 失败: ${e.message}` });
      }
    });
  }

  kill() {
    const p = this.proc;
    this.proc = null;
    this.dead = true;
    if (!p) return;
    // Windows 上 p.kill() 只杀 bash 本身, 里面的 sleep/子进程会变成孤儿并攥着管道,
    // 测试进程/CLI 因此退不掉 —— 用 taskkill /T 杀整棵进程树。
    try {
      if (process.platform === "win32" && p.pid) {
        spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
      } else {
        p.kill("SIGKILL");
      }
    } catch (e) { noteCatch(e); /* 已退出 */ }
  }

  async dispose() { this.kill(); }

  stats() {
    return { alive: !!this.proc && !this.dead, commands: this.commands, startedAt: this.startedAt, cwd: this.cwd };
  }
}

// 与 run_command 同源的预检 + 常驻 shell 特有的两条:
//   ① 会话内建 (export/unset/alias/umask) 直接放行 —— 它们只改本 shell 的环境, 不碰文件系统;
//   ② cd 必须落在工作区内 (用会话当前 PWD 解析), 否则模型可以一路 cd 出去, 绕过工作区边界。
// 其余命令照旧走 checkCommand 白名单 + 会话自写脚本拦截。
const PROTECTED_MARKERS = ["http-token", "audit-hmac-key", "config/ppx.json"];

function hitsProtectedPath(command) {
  const norm = String(command).split(String.fromCharCode(92)).join("/").toLowerCase();
  return PROTECTED_MARKERS.some((m) => norm.includes(m));
}

function splitSegments(cmd) {
  // 逐层替换而不是一个正则: 命令里带反斜杠/引号时正则容易写错, 这里只关心分隔符
  const NL = String.fromCharCode(10);
  return String(cmd)
    .split(NL).join(";")
    .split("&&").join(";")
    .split("||").join(";")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 会话内建判定 (按首词, 不用正则边界): 这些只改本 shell 的环境, 没有可执行文件
const BUILTIN_WORDS = new Set(["export", "unset", "alias", "unalias", "umask", "set", "hash", "shopt", "type", "pwd", "echo", "printf"]);
function isBuiltinSegment(seg) {
  const word = String(seg).trim().split(" ")[0].split("\t")[0];
  return BUILTIN_WORDS.has(word);
}

function checkCd(seg, { rootDir, cwd }) {
  const m = /^cd(?:\s+(.*))?$/.exec(seg);
  if (!m) return null;
  const raw = (m[1] || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return "cd 不带参数会跳回 HOME, 常驻 shell 里请显式给工作区内路径";
  if (raw === "-" || raw === "~" || raw.startsWith("~")) return "不支持 cd 到 HOME/上一个目录 (会跳出工作区)";
  const target = path.resolve(cwd || rootDir, raw);
  const root = path.resolve(rootDir);
  if (target !== root && !target.startsWith(root + path.sep)) return `cd 越出工作区: ${raw}`;
  return null;
}

function preflight(command, { rootDir, ctx, security, cwd }) {
  const protectedHit = hitsProtectedPath(command);
  if (protectedHit) return "受保护路径, 禁止通过命令读取 (审计锚点/凭证/含密钥配置)";
  const segments = splitSegments(command);
  for (const seg of segments) {
    const badCd = checkCd(seg, { rootDir, cwd });
    if (badCd) return badCd;
  }
  // 内建段不走白名单 (它们没有可执行文件), 其余段合并后交给同一个命令守卫
  const rest = segments.filter((seg) => !isBuiltinSegment(seg) && seg !== "cd" && !seg.startsWith("cd "));
  if (rest.length) {
    const guard = checkCommand(rest.join(" && "), security || {});
    if (!guard.ok) return guard.reason + DENY_HINT;
  }
  const scriptHit = findSessionWrittenScript(rootDir, command, ctx);
  if (scriptHit) return `本会话由写工具新建/修改的脚本不允许直接执行 (需人工审批): ${scriptHit}` + DENY_HINT;
  return null;
}

export function registerShellSessionTools(catalog, { rootDir, config = null } = {}) {
  const configured = config?.shell_path;
  // 配置了路径但不存在的, 视为"本机没有 bash" —— 不能拿一个 ENOENT 的路径注册工具
  const shellPath = configured ? (fs.existsSync(configured) ? configured : null) : findBash();
  if (!shellPath) return { available: false };
  const env = {};
  const session = new PersistentShell({
    shellPath,
    cwd: rootDir,
    env,
    timeoutMs: Number(config?.timeout_ms) || 120000,
  });

  catalog.register({
    name: "shell",
    category: "system",
    power: "high",
    capability: { readOnly: false, riskLevel: "high", destructive: true, sideEffect: "system" },
    description:
      "在**常驻** bash 里执行命令: cd / export / venv 激活在后续命令里继续有效 (run_command 每次都是新 shell, 不保留状态)。"
      + "串行执行, 有超时; 超时会重启 shell。restart=true 可手动重置环境。只支持 bash (Windows 用 git bash)。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令 (shell 语法)" },
        timeout_ms: { type: "number", description: "本次超时, 默认 120000" },
        restart: { type: "boolean", description: "true = 先重启 shell 再执行 (清空 cd/env 状态)" },
      },
      required: ["command"],
    },
    execute: async (args, ctx) => {
      const cmd = String(args.command || "").trim();
      if (!cmd) return JSON.stringify({ error: "空命令" });
      const security = ctx?.agent?.config?.security || config?.security || {};
      const bad = preflight(cmd, { rootDir, ctx, security, cwd: session.cwd });
      if (bad) return JSON.stringify({ error: bad });
      if (args.restart === true) session.kill();
      const r = await session.run(cmd, { timeoutMs: args.timeout_ms });
      if (!r.ok) {
        return JSON.stringify({ error: r.error, timedOut: r.timedOut, stdout: r.stdout || "" });
      }
      return JSON.stringify({
        exit_code: r.exit,
        stdout: r.stdout,
        ...(r.truncated ? { truncated: true } : {}),
      });
    },
  });

  return { available: true, session };
}
