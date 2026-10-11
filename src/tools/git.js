// src/tools/git.js - Git 集成工具 (结构化 + 护栏)
// 对齐主流 Agent 实践 (aider 自动提交 / Claude Code / OpenHands / Cline):
// 版本控制是编码 Agent 的标配一等工具, 但必须有硬护栏 —
//   ① 只读工具 (status/diff/log) 幂等无副作用;
//   ② git_commit 仅限 add+commit, 禁止 push / reset / rebase / clean / force (无此工具即无此能力);
//   ③ 全部走 execFile 参数数组, 不经 shell, 命令注入不可能;
//   ④ 输出截断到 toolResultBudget 级别, 防 diff 巨型化撑爆上下文。
// 2026-10-01 新增 (GitHub 主流 Agent 对标轮)。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { githubMirrorUrls } from "../utils/http-proxy.js";

const OUT_CAP = 4000;
const MSG_CAP = 500;

const GH_MIRROR_PREFIXES = ["https://ghproxy.net/", "https://ghfast.top/", "https://gh-proxy.com/"];

function findRepoRoot(rootDir) {
  let dir = path.resolve(rootDir);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function git(rootDir, args, timeoutMs = 15000) {
  const repo = findRepoRoot(rootDir);
  if (!repo) throw new Error("不在 git 仓库内 (未找到 .git)");
  return execFileSync("git", args, {
    cwd: repo,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  });
}

function cap(s) {
  return String(s || "").length > OUT_CAP
    ? String(s).slice(0, OUT_CAP) + `\n…[已截断, 共 ${String(s).length} 字符]`
    : String(s || "");
}

// ---------- 网络类 git (clone/fetch/pull) 镜像兜底 ----------
// GitHub 直连失败 → 依次试 ghproxy/ghfast/gh-proxy 镜像。纯 execFileSync 参数数组, 无 shell 注入面。

function runGitArgs(cwd, args, timeoutMs) {
  return execFileSync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// clone: 直接跑; github 主机失败按镜像 URL 重试
function cloneWithMirror(rootDir, repo, dest, { depth = 1, timeoutMs = 180000 } = {}) {
  const mirrors = githubMirrorUrls(repo) || [];
  const attempts = [repo, ...mirrors];
  let lastErr = null;
  for (const url of attempts) {
    try {
      const out = runGitArgs(rootDir, ["clone", "--depth", String(depth), url, dest], timeoutMs);
      // 走镜像克隆时, origin 会被记成镜像地址 → 改回原始 github 地址,
      // 让后续 git_pull/git_fetch 用 insteadOf 兜底 (先直连、失败再镜像), 而非永久绑死单一镜像。
      if (url !== repo) {
        try { runGitArgs(rootDir, ["-C", dest, "remote", "set-url", "origin", repo], timeoutMs); } catch { /* 忽略 */ }
      }
      return { ok: true, url, dest, viaMirror: url !== repo, output: String(out || "").trim() };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("git clone 失败");
}

// fetch/pull: 先直连; 失败后用 -c url.<镜像前缀>...insteadOf 重写 github 远程再试 (非 github 远程不受影响)
function gitWithMirrorFallback(rootDir, baseArgs, { timeoutMs = 180000 } = {}) {
  const repo = findRepoRoot(rootDir);
  if (!repo) throw new Error("不在 git 仓库内 (未找到 .git)");
  try {
    return { out: runGitArgs(repo, baseArgs, timeoutMs), viaMirror: false };
  } catch (firstErr) {
    let lastErr = firstErr;
    for (const p of GH_MIRROR_PREFIXES) {
      try {
        const out = runGitArgs(repo, ["-c", `url.${p}https://github.com/.insteadOf=https://github.com/`, ...baseArgs], timeoutMs);
        return { out, viaMirror: true, mirror: p };
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
}

export function registerGitTools(catalog, { rootDir } = {}) {
  // 1. git_status — 分支 + 变更清单 (结构化)
  catalog.register({
    name: "git_status",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "查看 git 仓库状态: 当前分支与变更文件清单 (结构化 JSON)。提交前先看这里。",
    parameters: { type: "object", properties: {}, required: [] },
    category: "vcs",
    power: "user",
    idempotent: true,
    execute: async () => {
      try {
        const branch = git(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
        const porcelain = git(rootDir, ["status", "--porcelain", "-b"]);
        const lines = porcelain.split("\n").filter(Boolean);
        const changes = lines.filter((l) => !l.startsWith("##"));
        return JSON.stringify({
          branch,
          clean: changes.length === 0,
          entries: changes.map((l) => ({ x: l.slice(0, 2).trim(), file: l.slice(3).trim() })),
        });
      } catch (e) {
        return JSON.stringify({ error: (e.message || "").slice(0, 200) });
      }
    },
  });

  // 2. git_diff — 查看改动内容
  catalog.register({
    name: "git_diff",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "查看未提交改动 (git diff)。staged=true 只看已暂存区; path 可限定单个文件。",
    parameters: {
      type: "object",
      properties: { staged: { type: "boolean" }, path: { type: "string" } },
      required: [],
    },
    category: "vcs",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      try {
        const a = ["diff", "--no-color"];
        if (args.staged) a.push("--staged");
        if (args.path) a.push("--", args.path);
        return cap(git(rootDir, a));
      } catch (e) {
        return "[git 错误] " + (e.message || "").slice(0, 200);
      }
    },
  });

  // 3. git_log — 最近提交历史
  catalog.register({
    name: "git_log",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "查看最近提交历史 (默认 10 条, 上限 50)。",
    parameters: { type: "object", properties: { n: { type: "number" } }, required: [] },
    category: "vcs",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      const n = Math.min(Math.max(Number(args.n) || 10, 1), 50);
      try {
        const raw = git(rootDir, ["log", `-${n}`, "--pretty=format:%h|%an|%ad|%s", "--date=short"]);
        return JSON.stringify({
          commits: raw.split("\n").filter(Boolean).map((l) => {
            const [hash, author, date, ...rest] = l.split("|");
            return { hash, author, date, subject: rest.join("|") };
          }),
        });
      } catch {
        return JSON.stringify({ commits: [] }); // 空仓库 (尚无任何提交)
      }
    },
  });

  // 4. git_commit — 受限提交 (唯一写操作; 无 push/reset/rebase 能力)
  catalog.register({
    name: "git_commit",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "提交当前改动 (仅 add+commit)。add_all=true 时先暂存全部改动。禁止也不支持 push/reset 等危险操作。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "提交信息 (≤500 字符)" },
        add_all: { type: "boolean", description: "先暂存全部改动 (git add -A)" },
      },
      required: ["message"],
    },
    category: "vcs",
    power: "agent",
    execute: async (args) => {
      const message = String(args.message || "").trim();
      if (!message) return "[工具错误] git_commit: 需要 message";
      if (message.length > MSG_CAP) return `[工具错误] git_commit: message 超过 ${MSG_CAP} 字符`;
      const staged = args.add_all === true;
      if (staged) git(rootDir, ["add", "-A"]);
      // 无暂存改动时 commit 会失败, 先探测给出可读错误
      const nothing = git(rootDir, ["status", "--porcelain"]).split("\n").filter(Boolean).length === 0
        && git(rootDir, ["diff", "--staged", "--quiet"]).length === 0;
      if (nothing && !staged) return JSON.stringify({ ok: false, error: "没有可提交的改动 (工作区干净且暂存区为空)" });
      try {
        const out = git(rootDir, ["commit", "-m", message]);
        const hash = (out.match(/\[[^\]]+ ([0-9a-f]+)\]/) || [])[1] || "";
        return JSON.stringify({ ok: true, hash, message });
      } catch (e) {
        return JSON.stringify({ ok: false, error: (e.message || "").slice(0, 300) });
      }
    },
  });

  // 5. git_clone — 克隆仓库 (GitHub 镜像兜底)
  catalog.register({
    name: "git_clone",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "克隆 git 仓库到工作区。repo 支持 URL 或 owner/repo (默认 github.com)。直连失败时自动改用 GitHub 镜像 (ghproxy/ghfast/gh-proxy) 重试。",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "仓库 URL 或 owner/repo" },
        dest: { type: "string", description: "目标目录 (默认取仓库名)" },
        depth: { type: "number", description: "浅克隆深度 (默认 1)" },
      },
      required: ["repo"],
    },
    category: "vcs",
    power: "agent",
    execute: async (args) => {
      const repoRaw = String(args.repo || "").trim();
      if (!repoRaw) return JSON.stringify({ error: "git_clone: 需要 repo" });
      // 无协议前缀且非 scp-like (git@host:path) → 视为 github owner/repo
      const repo = /^[a-z]+:\/\//i.test(repoRaw) || /^[^@\s]+@[^:\s]+:/.test(repoRaw)
        ? repoRaw
        : "https://github.com/" + repoRaw.replace(/^\/+/, "");
      const base = repo.split("/").pop().replace(/\.git$/, "") || "repo";
      const dest = String(args.dest || base).trim();
      try {
        const r = cloneWithMirror(rootDir, repo, dest, { depth: Number(args.depth) || 1 });
        return JSON.stringify(r);
      } catch (e) {
        return JSON.stringify({ ok: false, error: "git clone 失败 (直连+镜像均失败): " + String(e.message || e).slice(0, 300) });
      }
    },
  });

  // 6. git_pull — 拉取合并 (镜像兜底)
  catalog.register({
    name: "git_pull",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "拉取并合并远程最新提交 (git pull --no-rebase)。GitHub 远程直连失败时自动改走镜像重试。",
    parameters: { type: "object", properties: {}, required: [] },
    category: "vcs",
    power: "agent",
    execute: async () => {
      try {
        const r = gitWithMirrorFallback(rootDir, ["pull", "--no-rebase"]);
        return JSON.stringify({ ok: true, viaMirror: r.viaMirror, mirror: r.mirror || "", output: cap(r.out) });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) });
      }
    },
  });

  // 7. git_fetch — 拉取远程 (镜像兜底)
  catalog.register({
    name: "git_fetch",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "拉取远程更新到本地 (git fetch --all --prune)。GitHub 远程直连失败时自动改走镜像重试。",
    parameters: { type: "object", properties: {}, required: [] },
    category: "vcs",
    power: "agent",
    idempotent: true,
    execute: async () => {
      try {
        const r = gitWithMirrorFallback(rootDir, ["fetch", "--all", "--prune"]);
        return JSON.stringify({ ok: true, viaMirror: r.viaMirror, mirror: r.mirror || "", output: cap(r.out) });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) });
      }
    },
  });
}
