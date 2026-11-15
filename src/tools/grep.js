// src/tools/grep.js - 内容检索 (架构优化 ⑥, 2026-11-13): 借成熟轮子, 不手搓搜索引擎
//
// 缺口 (对照 GitHub 同类 harness): OpenCode / Oh My Pi / OpenClaw / DSH 的内容检索全部
//   落在 ripgrep 或语言服务器上; 本仓只有 search_files (按**文件名** glob) —— 想搜内容只能
//   让模型自己拼 `run_command` 的 grep/findstr, 于是 Windows 上的引号、编码、无匹配退出码
//   全变成模型要猜的东西 (上一轮评测为此专门加了 tail/findstr 特判)。
//
// 策略 (阶梯, 每级都可离线验证):
//   1. ripgrep: 有 `rg` 就用 —— 它已经把 .gitignore、二进制识别、并行、编码这些坑填完了;
//   2. git grep: 仓库内且无 rg —— git 自带的索引搜索, 比 JS 全盘扫描快一个量级;
//   3. 内置 JS 扫描: 前两者都不可用时的兜底, 只保证"能用、结果正确", 不追速度。
// 这不是"加依赖": 三个后端都是**可选外部程序**, 缺失自动降级, 零运行时依赖不变。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { safePath } from "./builtin-paths.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".cache", "coverage", "__pycache__", ".venv", "venv"]);
const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_RESULTS = 100;

// 后端探测 (每次调用探测, 结果按进程缓存 —— 用户中途装/卸 rg 不需要重启)
let _backendCache = null;
export function resetBackendCache() { _backendCache = null; }

export function detectBackends() {
  if (_backendCache) return _backendCache;
  const has = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 3000, windowsHide: true });
      return r.status === 0;
    } catch { return false; }
  };
  _backendCache = { rg: has("rg", ["--version"]), git: has("git", ["--version"]) };
  return _backendCache;
}

function buildArgs({ pattern, glob, ignore_case, fixed }) {
  // 不带 -m: rg 的 -m 是**每文件**上限, 与内置后端的"总命中上限"口径不一致 —— 会把
  //   其他文件的命中吞掉, slice 截断语义失真。总量截断由 runGrep 统一做。
  const args = ["-n", "--no-heading", "--color", "never"];
  if (ignore_case) args.push("-i");
  if (fixed) args.push("-F");
  if (glob) args.push("-g", glob);
  // 跳过目录与内置后端 (SKIP_DIRS) 对齐: 临时树/无 .gitignore 的目录里 rg 默认会搜
  //   node_modules, 三级后端就会给两个答案 (一致性契约, test/grep-tool.test.js 钉)。
  for (const d of SKIP_DIRS) args.push("-g", `!${d}/**`);
  args.push("-e", pattern);
  return args;
}

// ---- 后端 1: ripgrep ----
function rgSearch(root, dir, opts) {
  // 传相对路径: rg 输出的路径形态跟随搜索目标的形态, 绝对路径会让 Windows 输出带
  //   盘符冒号 (`C:\...\a.js:1:text`), 是 2026-11-14 回归 (评测 P1-3a) 的源头之一。
  const rel = path.relative(root, dir);
  const target = rel && !rel.startsWith("..") ? (rel.replace(/\\/g, "/") || ".") : dir;
  const r = spawnSync("rg", [...buildArgs(opts), "--", target], {
    cwd: root, encoding: "utf8", timeout: opts.timeout_ms, windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  // rg: 0=有命中 1=无命中 其它=出错 (含模式非法)
  if (r.status !== 0 && r.status !== 1) {
    return { ok: false, error: (r.stderr || "").trim().slice(0, 400) || `rg 退出码 ${r.status}` };
  }
  return { ok: true, hits: parseColonLines(r.stdout || "", root) };
}

// ---- 后端 2: git grep (仅仓库内) ----
function gitSearch(root, dir, opts) {
  if (!fs.existsSync(path.join(root, ".git"))) return { ok: false, error: "not a git repo" };
  const args = ["grep", "-n", "-I", "--no-color", "--full-name"];
  if (opts.ignore_case) args.push("-i");
  if (opts.fixed) args.push("-F");
  args.push("-e", opts.pattern);
  const pathspec = path.relative(root, dir).replace(/\\/g, "/") || ".";
  args.push("--", opts.glob ? `${pathspec}/${opts.glob}`.replace(/^\.\//, "") : pathspec);
  // 跳过目录与内置后端对齐 (同 rgSearch 的 -g 排除, 一致性契约)
  for (const d of SKIP_DIRS) args.push(`:(exclude)${d}`);
  const r = spawnSync("git", args, {
    cwd: root, encoding: "utf8", timeout: opts.timeout_ms, windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  // git grep: 0=有命中 1=无命中 128=不在仓库/致命错
  if (r.status === 1) return { ok: true, hits: [] };
  if (r.status !== 0) return { ok: false, error: (r.stderr || "").trim().slice(0, 400) || `git grep 退出码 ${r.status}` };
  return { ok: true, hits: parseColonLines(r.stdout || "", root) };
}

// `path:line:text` → {file, line, text}
// 2026-11-14 (评测 P1-3a 回归修复): 旧实现按前两个冒号切分, 但 Windows 绝对路径输出
//   `C:\...\a.js:1:text` 的第一个冒号是盘符分隔 —— 文件段被切成 "C", 行号段解析 NaN,
//   所有命中被静默丢弃, 而 rg exit 0 + 空列表会被当终态直接返回 (不降级)。
//   改为非贪婪正则: 文件段允许含冒号 (盘符), 直到 `:<数字>:` 才算行号分隔。
function parseColonLines(stdout, root) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const ln = Number(m[2]);
    if (!Number.isFinite(ln)) continue;
    let file = m[1].replace(/\\/g, "/");
    if (path.isAbsolute(file)) file = path.relative(root, file).replace(/\\/g, "/");
    if (file.startsWith("./")) file = file.slice(2);
    out.push({ file, line: ln, text: m[3] });
  }
  return out;
}

// ---- 后端 3: 内置扫描 (无外部程序时的兜底) ----
function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function globToRe(glob) {
  // 仅支持 * 与 ** 的常见写法: *.js / src/**/*.ts (够用, 复杂 glob 交给 rg/git 后端)
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // 占位符放在私有区 (U+E000/E001), 不用控制字符 —— 正则里出现 \x00 会触发
    // no-control-regex 告警, 而且控制字符在跨平台路径处理里容易出意外
    .replace(/\*\*\//g, "\uE000")
    .replace(/\*\*/g, "\uE001")
    .replace(/\*/g, "[^/]*")
    .replace(/\uE000/g, "(?:.*/)?")
    .replace(/\uE001/g, ".*");
  return new RegExp(`^${esc}$`);
}

export function jsSearch(root, dir, opts) {
  let re;
  try {
    re = opts.fixed
      ? new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.ignore_case ? "i" : "")
      : new RegExp(opts.pattern, opts.ignore_case ? "i" : "");
  } catch (e) {
    return { ok: false, error: `非法正则: ${e.message}` };
  }
  const globRe = opts.glob ? globToRe(opts.glob.replace(/\\/g, "/")) : null;
  const hits = [];
  const walk = (d) => {
    if (hits.length >= opts.max_results) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= opts.max_results) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(d, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      const abs = path.join(d, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      // 不含 "/" 的 glob 按**文件名**匹配 (与 ripgrep/git 语义一致: *.js 命中的所有层级);
      // 含 "/" 的按相对路径匹配 (src/**/*.ts)。这里差了这一步, 兜底后端就会静默零命中。
      if (globRe) {
        const target = opts.glob.includes("/") ? rel : rel.split("/").pop();
        if (!globRe.test(target)) continue;
      }
      let buf;
      try {
        const st = fs.statSync(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        buf = fs.readFileSync(abs);
      } catch { continue; }
      if (isBinary(buf)) continue;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push({ file: rel, line: i + 1, text: lines[i] });
          if (hits.length >= opts.max_results) return;
        }
      }
    }
  };
  walk(dir);
  return { ok: true, hits };
}

// 统一检索入口 (纯函数式: 传入 rootDir 便于测试; 返回 {backend, hits, truncated, error})
export function runGrep({
  rootDir,
  pattern,
  path: sub = ".",
  glob = "",
  ignore_case = false,
  fixed = false,
  max_results = DEFAULT_MAX_RESULTS,
  backend = "auto",
  timeout_ms = 15000,
} = {}) {
  const pat = String(pattern ?? "");
  if (!pat) return { backend: "none", hits: [], truncated: false, error: "pattern 不能为空" };
  const dir = path.resolve(rootDir, sub || ".");
  if (!fs.existsSync(dir)) return { backend: "none", hits: [], truncated: false, error: `路径不存在: ${sub}` };
  const opts = { pattern: pat, glob, ignore_case: !!ignore_case, fixed: !!fixed, max_results: Math.max(1, Math.min(1000, Number(max_results) || DEFAULT_MAX_RESULTS)), timeout_ms };
  const avail = detectBackends();
  const order = backend === "auto" ? [avail.rg ? "rg" : null, avail.git ? "git" : null, "js"].filter(Boolean) : [backend];
  const errors = [];
  for (const b of order) {
    const r = b === "rg" ? rgSearch(rootDir, dir, opts)
      : b === "git" ? gitSearch(rootDir, dir, opts)
        : jsSearch(rootDir, dir, opts);
    if (!r.ok) { errors.push(`${b}: ${r.error}`); continue; }
    const hits = r.hits.slice(0, opts.max_results);
    return { backend: b, hits, truncated: r.hits.length > hits.length || hits.length >= opts.max_results, error: null };
  }
  return { backend: order[order.length - 1] || "none", hits: [], truncated: false, error: `全部后端失败 — ${errors.join(" | ")}` };
}

export function registerGrepTools(catalog, { rootDir }) {
  catalog.register({
    name: "grep",
    category: "code",
    power: "read",
    capability: { readOnly: true, riskLevel: "low", destructive: false, sideEffect: "none" },
    description:
      "在工作区里按**内容**搜索 (正则或字面量), 返回 `文件:行号: 内容`。"
      + "有 ripgrep 用 ripgrep、仓库内退回 git grep、都没有再用内置扫描。只读, 不修改文件。"
      + "改代码前先定位用法/定义时用它, 别用 run_command 拼 grep (Windows 引号与编码会把结果搞乱)。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "要搜的内容: 正则, 或 fixed=true 时的字面量" },
        path: { type: "string", description: "搜索起始目录 (相对工作区), 默认 ." },
        glob: { type: "string", description: "只搜匹配的文件, 如 *.js / src/**/*.ts" },
        ignore_case: { type: "boolean", description: "忽略大小写, 默认 false" },
        fixed: { type: "boolean", description: "true = 按字面量匹配 (不当正则), 默认 false" },
        max_results: { type: "number", description: "最多返回多少行, 默认 100 (上限 1000)" },
      },
      required: ["pattern"],
    },
    execute: async (args, ctx) => {
      const base = safePath(rootDir, args.path || ".", ctx);
      const r = runGrep({
        rootDir,
        pattern: args.pattern,
        path: base,
        glob: args.glob || "",
        ignore_case: args.ignore_case === true,
        fixed: args.fixed === true,
        max_results: args.max_results,
      });
      if (r.error) return `[工具错误] grep: ${r.error}`;
      if (!r.hits.length) return `(无匹配; 后端 ${r.backend})`;
      const body = r.hits.map((h) => `${h.file}:${h.line}: ${String(h.text).slice(0, 300)}`).join("\n");
      const tail = r.truncated ? `\n…结果已截断 (上限 ${args.max_results || DEFAULT_MAX_RESULTS} 行), 缩小范围再搜` : "";
      return `${body}${tail}\n(后端 ${r.backend}, 命中 ${r.hits.length} 行)`;
    },
  });
}
