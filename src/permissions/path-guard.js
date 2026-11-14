// src/permissions/path-guard.js - 权限引擎 · 路径与命令静态分析组 (2026-11-03 从 index.js 拆出)
// 职责: 只做一件事 —— 从工具入参里找出"会落盘到哪里", 并判定是否越出工作区根:
//   · isWithinRoot        根包含判定 (Windows 大小写不敏感 + 分隔符统一)
//   · findEscape          逐层解析 args 候选路径 / shell 命令 token, 返回第一个越界路径
//   · provePatchTargets   apply_patch 落点证明三态 (allow / escapes / unprovable)
// 决策逻辑 (ask/deny 映射、审批档位) 不在这里 —— 在 index.js 的 createPermissionEngine.check()。
// 本模块不 import index.js (无环); isWithinRoot 经 index.js 重导出保持旧 import 路径不变。
import path from "node:path";
import fs from "node:fs";
import { tokenizeShell } from "../security/shell-parse.js";
import {
  parseEditBlocks, parseCodexPatch,
  MISSING_TARGET_HELP, patchTargetPreview,
  looksLikePath, resolvePatchTargets,
} from "../edit/editblock.js";
import { noteCatch } from "../utils/catch-log.js";

// ---- 路径规范化 (Windows 大小写不敏感 + 分隔符统一) ----
function toCompare(p) {
  return path.resolve(String(p)).toLowerCase().replace(/\\/g, "/");
}
// 2026-10-09: 补 export —— permission-intersection.test.js 与 tools/v3.js 的 apply_patch
//   都在等待这个判定函数, 但实现一直没导出, 导致它看起来"不存在"。
export function isWithinRoot(p, root) {
  const a = toCompare(p);
  const b = toCompare(root);
  if (a === b) return true;
  const sep = b.endsWith("/") ? b : b + "/";
  return a.startsWith(sep);
}

// 从 args 收集需要校验的候选路径
// 2026-10-10 修复 (P1-1): URL 不是本地路径 —— 原先裸正则会把 `https://github.com/a/b.git`
//   切成 `s://github.com/a/b.git`, path.resolve 把 `s:` 当盘符 → 误判"路径越界"。
//   后果: git clone / curl / npm --registry 全部被拦, 且给出误导性的"越界"理由。
//   修法: 先剔除 URL 字面量, 再扫路径。真实越界 (/etc/passwd、../../evil) 不受影响。
const URL_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']+/g;
function stripUrls(command) {
  return String(command).replace(URL_RE, " ");
}

// 2026-10-30 安全加固: 命令里的相对路径同样可能越界 (`cd ..` / `> ../x` / `cp a ../../b`)。
//   旧实现只用裸正则抽绝对路径, 相对穿越完全看不见; 现在用 shell 分词逐段检查:
//   - 所有看起来像路径的 token (含 . / .. / 分隔符 / 盘符 / ~)
//   - 重定向目标 (> >> < << 后面的词)
//   - cd/chdir/pushd 的参数
//   - 写类命令 (cp/mv/tee/touch/mkdir/…) 的最后一个非选项参数
//   含 $VAR / %VAR% / ~ 的动态路径无法静态证明落在根内 → 直接按越界处理 (fail closed)。
const SEP_OPS = new Set(["&&", "||", ";;", ";", "|", "&", "\n"]);
const REDIR_OPS = new Set([">", ">>", "<", "<<", "<<-", "<&", ">&"]);
const WRITE_DEST_CMDS = new Set([
  "cp", "copy", "mv", "move", "tee", "touch", "mkdir", "md", "install",
  "ln", "rsync", "scp", "dd", "sed", "xcopy", "robocopy",
]);
const CD_CMDS = new Set(["cd", "chdir", "pushd", "set-location"]);

function looksDynamicPath(t) {
  const s = String(t || "");
  if (!s) return false;
  if (s.startsWith("~")) return true;
  if (/\$[A-Za-z_{(]/.test(s)) return true;
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(s)) return true;
  return false;
}

function looksLikePathToken(t) {
  const s = String(t || "").trim();
  if (!s) return false;
  if (s === "." || s === ".." || s === "~") return true;
  if (s.startsWith("~")) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;         // C:\ / C:/
  if (/^\\\\/.test(s)) return true;                    // UNC \\server\share
  if (/^[\\/]/.test(s)) return true;                   // /abs 或 \abs
  if (/[\\/]/.test(s)) return true;                    // 任意含分隔符
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return true;   // ../x
  return false;
}

function inspectSegment(seg, out) {
  const words = seg.filter((t) => t.kind === "word");
  if (!words.length) return;
  const argv0 = String(words[0].text || "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  const push = (t) => {
    const s = String(t || "").trim();
    if (s) out.push({ p: s, dynamic: looksDynamicPath(s) });
  };

  for (let i = 0; i < seg.length; i++) {
    const tok = seg[i];
    // 重定向目标: 无论长什么样都要检查 (可能写 /etc/passwd 或 ../x)
    if (tok.kind === "op" && REDIR_OPS.has(tok.text)) {
      const next = seg[i + 1];
      if (next && next.kind === "word") push(next.text);
      continue;
    }
    if (tok.kind !== "word") continue;
    const t = String(tok.text || "").trim();
    if (!t) continue;
    // cd 的目标词 (允许 `cd -P ../x` 这类选项后跟目标)
    if (CD_CMDS.has(argv0) && i > 0 && !t.startsWith("-")) { push(t); continue; }
    // --flag=../value 形式: 检查等号右侧
    const eq = t.match(/^--?[A-Za-z0-9-]+=(.+)$/);
    if (eq) {
      if (looksLikePathToken(eq[1]) || looksDynamicPath(eq[1])) push(eq[1]);
      continue;
    }
    if (looksLikePathToken(t)) push(t);
  }

  // 写类命令: 最后一个非选项参数是落点 (cp/mv/tee/…)
  if (WRITE_DEST_CMDS.has(argv0)) {
    for (let i = words.length - 1; i >= 1; i--) {
      const t = String(words[i].text || "").trim();
      if (!t || t.startsWith("-")) continue;
      push(t);
      break;
    }
  }
}

function collectCommandPaths(command) {
  const out = [];
  let seg = [];
  const flush = () => { if (seg.length) inspectSegment(seg, out); seg = []; };
  for (const tok of tokenizeShell(stripUrls(command))) {
    if (tok.kind === "op" && SEP_OPS.has(tok.text)) { flush(); continue; }
    seg.push(tok);
  }
  flush();
  return out;
}

function collectPaths(args) {
  const out = [];
  for (const key of ["path", "file_path", "filePath", "cwd", "dir", "destination", "dest"]) {
    if (typeof args?.[key] === "string" && args[key]) out.push({ p: args[key], dynamic: false });
  }
  if (typeof args?.command === "string") out.push(...collectCommandPaths(args.command));
  return out;
}
// 2026-10-24: realpath 尽力解析 —— 候选路径可能不存在 (新建文件), 沿祖先向上找到最近
//   已存在目录取 realpath, 再把剩余段拼回。用于堵"工作区内的符号链接指向外部"的穿越:
//   字符串前缀比较 (isWithinRoot) 看不见 symlink, realpath 才是内核视角的真实落点。
//   解析不到 (整条链都不存在且无根) 时退回字面 resolve, 保持旧语义不放大拦截面。
function realPathBestEffort(p) {
  let cur = path.resolve(String(p));
  const trail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return trail.length ? path.join(real, ...trail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(String(p));
      trail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export function findEscape(args, root, opts = {}) {
  // 2026-11-08: 允许范围可配 —— agent.workspace_allow 里的目录与 root 同等对待。
  //   此前只有 root 一个根, 用户想让它在桌面写个文件, 唯一的办法是把 sandbox 开到
  //   danger-full-access (整机放开)。白名单给了中间档位: "工作区内修改" + 指定几个目录。
  const allowRoots = Array.isArray(opts.allowRoots)
    ? opts.allowRoots.filter((x) => typeof x === "string" && x.trim())
    : [];
  // root 的 realpath 每次 check 解析一次 (符号链接化的 workspaceRoot 也要按真实落点判定)
  let rootReal = null;
  try { rootReal = realPathBestEffort(root); } catch { rootReal = null; }
  const allowReals = [];
  for (const r of allowRoots) {
    try { allowReals.push(realPathBestEffort(r)); } catch { /* 目录不存在: 忽略, 不放大拦截面 */ }
  }
  const withinAny = (abs, roots) => roots.some((r) => r && isWithinRoot(abs, r));
  for (const item of collectPaths(args)) {
    const p = typeof item === "string" ? item : item.p;
    if (!p) continue;
    // 动态路径 ($HOME/…, %APPDATA%/…, ~/…) 无法静态证明落在允许范围内 → fail closed。
    if (typeof item === "object" && item.dynamic) return p;
    // 2026-10-09 修复: 原先只判 isAbsolute —— 相对穿越 (../evil.js) 完全漏判,
    //   于是"越界补丁"与"根内补丁"拿到同样的判定, fail-closed 出现缺口。
    //   现统一解析为绝对路径再判 isWithinRoot: 相对/绝对一视同仁。
    let abs;
    try { abs = path.resolve(root, p); } catch { return p; }
    // 第一层: 字面判定; 白名单目录同样算"范围内"
    if (!withinAny(abs, [root]) && !withinAny(abs, allowRoots)) return p;
    // 第二层 (2026-10-24): realpath 判定 —— 符号链接指向根外 = 越界。
    //   仅当 root realpath 解析成功时启用; 解析失败不放大拦截面 (退回字面语义)。
    if (rootReal) {
      try {
        const real = realPathBestEffort(abs);
        if (!withinAny(real, [rootReal]) && !withinAny(real, allowReals)) return p;
      } catch (e) { noteCatch(e); /* realpath 异常按字面判定结果放行 */ }
}
  }
  return null;
}

// ---- apply_patch 落点证明三态 (2026-10-09 补) ----
// apply_patch 的目标路径藏在 content 字符串里, 通用 collectPaths 看不见 → 旧实现一律按
// REQUIRES_APPROVAL_TOOLS 升级 ask。问题在于它把两种完全不同的情况压成同一个 ask:
//   · 补丁确实越界 (该升级审批, 一分不放宽)
//   · 补丁没写目标 (这是【用法错误】, 模型改一下就能过; 给通用审批文案它只会僵住)
// 三态: allow (落点全在根内) / escapes (有越界, 照旧审批, 不给 modelHint) / unprovable (落点不可确定)。
export function provePatchTargets(args, root) {
  const content = String(args?.content || "");
  const srBlocks = parseEditBlocks(content);
  const cx = parseCodexPatch(content);
  const argPath = looksLikePath(args?.path) ? String(args.path).trim() : null;

  // 同时收集两类落点 —— 一份补丁里可能既有 SR 块又有 codex 表头 (模型混写很常见),
  // 只认其中一种会让"表头越界 + 块在根内"这种混合补丁被误判为可证明。
  const targets = [];
  if (srBlocks.length) targets.push(...resolvePatchTargets(content, srBlocks));
  if (cx.detected) {
    const cxp = cx.paths.filter(looksLikePath);
    if (cxp.length) targets.push(...cxp);
    else targets.push(...cx.blocks.map((b) => b.path));
  }

  if (!targets.length) {
    return { state: "unprovable", reason: `补丁落点无法证明。实际收到: ${patchTargetPreview(content)}\n${MISSING_TARGET_HELP}`, modelHint: MISSING_TARGET_HELP };
  }
  // args.path 只在块自身拿不到落点时兜底 (显式给了路径就算可证明)
  const list = argPath ? targets.map((t) => t || argPath) : targets;

  // 2026-11-08 纵深补强: 与 findEscape 同款 realpath 层。原实现只有字面 isWithinRoot,
  //   "工作区内 symlink 指向根外" 的落点会被判 allow → apply_patch 免审批直通
  //   (工具层 safePath 会拒, 但权限层口径不一致: 本该 unprovable/escapes 的被放行)。
  let rootReal = null;
  try { rootReal = realPathBestEffort(root); } catch { rootReal = null; }
  const outside = list.filter((t) => {
    if (!t) return false;
    if (!isWithinRoot(path.resolve(root, t), root)) return true;
    if (!rootReal) return false;
    try { return !isWithinRoot(realPathBestEffort(path.resolve(root, t)), rootReal); }
    catch (e) { noteCatch(e); return false; /* realpath 异常按字面判定放行, 不放大拦截面 */ }
  });
  if (outside.length) {
    return { state: "escapes", reason: `工作区写沙箱: 补丁落点越界 ${outside[0]}` };
  }
  if (list.some((t) => !t)) {
    return { state: "unprovable", reason: `补丁落点无法证明。实际收到: ${patchTargetPreview(content)}\n${MISSING_TARGET_HELP}`, modelHint: MISSING_TARGET_HELP };
  }
  return { state: "allow" };
}
