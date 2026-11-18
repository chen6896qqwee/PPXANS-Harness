// src/orchestrator/worktree.js — 子 agent 的 git worktree 隔离原语 (2026-11-16)
//
// 为什么需要: spawn_agent 的 worker 此前一律在主工作区执行 —— 并行改代码时互相踩踏,
//   一个子 agent 的中间态会被另一个看到。worktree 提供的是**隔离执行面**, 不是合并策略:
//   每个子任务从 HEAD 建一个 detached worktree, worker 以它为 cwd; 结果只回传
//   "变更统计 + 补丁路径", 是否合入由主 agent/用户显式决定 (git apply --3way)。
//
// 边界 (刻意保守):
//   · 需要主工作区是 git 仓库且有 HEAD 提交; 不满足就报可行动错误, 不静默退回共享目录;
//   · 不自动 merge/rebase/push —— 自动合入冲突需要语义裁决, 不属于这里;
//   · 新文件通过 `git add -N` 纳入 diff (未跟踪文件是 worker 最常见的产物);
//   · worktree 用后即删, 补丁留在 data/worktrees/*.patch, 不保留第二份工作区。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(root, args, { check = true } = {}) {
  const r = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  if (r.error) throw new Error(`git 不可用: ${r.error.message}`);
  if (check && r.status !== 0) {
    const detail = String(r.stderr || r.stdout || "").trim().slice(0, 400);
    throw new Error(`git ${args.join(" ")} 失败: ${detail || `exit ${r.status}`}`);
  }
  return String(r.stdout || "");
}

export function isGitRepo(root) {
  try { return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { return false; }
}

export function hasHeadCommit(root) {
  try { return !!git(root, ["rev-parse", "--verify", "HEAD"]).trim(); } catch { return false; }
}

export function createWorktree(root, { id, base = "HEAD" } = {}) {
  if (!isGitRepo(root)) {
    throw new Error("worktree 隔离需要主工作区是一个 git 仓库 (git rev-parse 失败); 请先 git init 或去掉 isolation 参数");
  }
  if (!hasHeadCommit(root)) {
    throw new Error("worktree 隔离需要仓库至少有一个提交 (HEAD 不存在); 请先做一次初始提交");
  }
  const dir = path.join(root, "data", "worktrees", String(id || "wt").replace(/[^\w.-]/g, "_"));
  git(root, ["worktree", "add", "--detach", dir, base]);
  return dir;
}

// 收集隔离目录里的变更。含未跟踪新文件 (add -N); 补丁落盘但不注入结果正文 (正文只带统计)。
export function collectWorktreeChanges(root, wt, { patchDir = null } = {}) {
  const status = git(wt, ["status", "--porcelain"]);
  const files = status.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!files.length) return { files: [], stat: "", patchPath: null };
  // add -N: 新文件也要出现在 diff 里; worktree 用后即弃, index 变化不污染主工作区。
  git(wt, ["add", "-N", "."]);
  const stat = git(wt, ["diff", "--shortstat", "HEAD"]).trim();
  const patch = git(wt, ["diff", "HEAD"]);
  const dir = patchDir || path.join(root, "data", "worktrees");
  fs.mkdirSync(dir, { recursive: true });
  const patchPath = path.join(dir, `${path.basename(wt)}.patch`);
  fs.writeFileSync(patchPath, patch, "utf8");
  return { files, stat, patchPath };
}

export function removeWorktree(root, wt) {
  // --force: 隔离目录的半成品不该阻塞回收; prune 清掉 git 侧的登记。
  try { git(root, ["worktree", "remove", "--force", wt], { check: false }); } catch { /* 回收失败由调用方继续 */ }
  try { git(root, ["worktree", "prune"], { check: false }); } catch { /* prune 是清理动作, 不阻断 */ }
  if (fs.existsSync(wt)) {
    // git remove 在某些 Windows/句柄占用场景会失败 —— 目录是我们刚创建的, 兜底物理清理。
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* 残留不掩盖主结果 */ }
  }
}
