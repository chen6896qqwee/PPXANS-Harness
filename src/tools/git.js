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

const OUT_CAP = 4000;
const MSG_CAP = 500;

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

export function registerGitTools(catalog, { rootDir } = {}) {
  // 1. git_status — 分支 + 变更清单 (结构化)
  catalog.register({
    name: "git_status",
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
}
