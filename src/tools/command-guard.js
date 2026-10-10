// src/tools/command-guard.js - 命令守卫 (吸收 Hermes Agent approval 机制)
// 三层防线:
//   1. 用户 deny 规则 (config.security.deny, glob 风格) — 最高优先级, 即使 allow_all 也拦
//   2. 硬黑名单 HARD_BLOCK (rm -rf /、fork bomb、写裸设备、管道到 shell 等) — allow_all 也拦
//   3. 常规高危黑名单 DEFAULT_DENY (继承皮皮虾 P0) — allow_all 放行
//   4. 白名单前缀 (allow_all=false 时) — 只放行已知安全命令前缀
// 反混淆: normalizeCommand 先去引号再规范化空白, 防 `rm ""-rf` / `bash <(curl)` 引号技巧绕过

// ---- 反混淆规范化: 仅用于检测, 不用于实际执行 ----
export function normalizeCommand(cmd) {
  let s = String(cmd || "");
  s = s.replace(/["'`]/g, ""); // 去引号防绕过
  s = s.replace(/\s+/g, " ").trim(); // 合并空白
  return s;
}

// ---- 硬黑名单: allow_all 也无法放行 (破坏宿主 / 不可逆 / 远程代码落地执行) ----
// v1.0.9: rm 类正则去掉行首/符号前缀限制 — `env rm --no-preserve-root /` 等前缀变体 (sudo/env/&&) 曾绕过
export const HARD_BLOCK = [
  { pattern: /rm\s+(-[a-z]*r[a-z]*\s+)*--?no-preserve-root(\s|$)/i, reason: "rm --no-preserve-root 破坏根目录" },
  { pattern: /rm\s+(-[a-z]*r[a-z]*\s+)*\/\s*$/i, reason: "rm -rf / 类删除根目录" },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|/, reason: "fork bomb 进程炸弹" },
  { pattern: /mkfs[.\s][^\n;]*\/dev\/(sd[a-z]|nvme[0-9])/i, reason: "格式化磁盘设备" },
  { pattern: /dd\s+[^\n;]*of=\/dev\/(sd[a-z]|nvme[0-9])/i, reason: "dd 写裸磁盘设备" },
  { pattern: /(curl|wget)\s+[^\s|;&]+\s*\|[\s]*(ba|z|k)?sh/i, reason: "管道下载内容到 shell 执行 (不可信代码)" },
  { pattern: /(ba|z|k)?sh\s*<\s*\(\s*(curl|wget)/i, reason: "进程替换执行远程内容" },
];

// ---- 常规高危黑名单 (继承皮皮虾 P0: 删除/格式化/关机/强杀/强制推送等) ----
export const DEFAULT_DENY = [
  /delete|erase|rmdir|rd \/s|deltree/i,
  /format\s/i, /mkfs/i, /fdisk/i, /diskpart/i, /shutdown/i,
  /restart/i, /reboot/i, /halt/i, /poweroff/i,
  /reg\s+delete/i, /taskkill/i, /pkill/i, /kill\s+-9/i,
  /rm\s+-rf/i, /rm\s+-fr/i,
  /curl|wget|Invoke-WebRequest|iwr/i,
  /git\s+push.*--force/i, /git\s+reset.*--hard/i,
];

export const DEFAULT_ALLOW_PREFIX = [
  "git", "npm", "npx", "yarn", "pnpm", "node", "python", "python3",
  "ls", "dir", "pwd", "cat", "type", "echo", "head", "tail", "grep",
  "find", "wc", "cp", "copy", "mv", "move", "mkdir", "touch", "tree",
  "cd", "help", "ipconfig", "netstat", "tasklist", "whoami", "date", "time", "tsc",
];

// 命中拦截后附加的指引: 明确告知不要重试/改写绕过 (Hermes approval 同款约束)
export const DENY_HINT = " 命中后不要重试或改写命令绕过 — 确需执行请让用户调整 security 配置。";

// glob 风格规则 ('git push --force*') -> 正则
export function globToRegExp(glob) {
  let s = String(glob || "").trim();
  if (!s) return null;
  s = s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  try { return new RegExp("^" + s + "$", "i"); } catch { return null; }
}

// ---- 解释器内联执行检测 (2026-10-09 补) ----
// 缺陷: 首词合法的命令可以携带任意内联源码逃过前缀白名单 ——
//   `node -e "..."` / `python -c "..."` / `bash -c "..."` / `powershell -enc ...` 全是"node/python/bash"开头,
//   `npx <pkg>` 等于即取即执行远程包, `find . -exec cat {} ;` 借用 find 执行任意程序,
//   `git -c pager=... log` 借 git 注入配置。这些一律按【硬拦截】处理 (allow_all 也拦),
//   需显式 allow_inline_exec 才放开。
// 刻意不误伤: `python -m venv`(模块) / `node app.js` / `bash build.sh` / `find . -name` 均不在拦截范围。
const INLINE_INTERPRETERS = [
  { names: ["node", "nodejs"], flags: ["-e", "-p", "--eval", "--print"] },
  { names: ["python", "python2", "python3", "py"], flags: ["-c"] },
  { names: ["perl", "ruby"], flags: ["-e"] },
  { names: ["php"], flags: ["-r"] },
  { names: ["bash", "sh", "zsh", "ksh", "dash"], flags: ["-c"] },
  { names: ["powershell", "pwsh"], flags: ["-c", "-command", "-enc", "-encodedcommand", "-e"] },
];
export const INLINE_EXEC_OPT_IN = "security.allow_inline_exec";

/**
 * 检测命令是否在不走脚本文件的前提下内联执行代码。
 * @returns {string|null} 命中说明, 未命中返回 null
 */
export function findInlineExec(cmd) {
  const s = normalizeCommand(cmd);
  if (!s) return null;
  // 逐"命令段"判定 (&& || ; | 分段): env/sudo/time/nohup 等包装器不构成绕过,
  // 因为下面按段内任意位置找解释器 token。
  const segments = s.split(/\s*(?:&&|\|\||;|\|)\s*/);
  for (const seg of segments) {
    const toks = seg.split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    for (let i = 0; i < toks.length; i++) {
      const raw = toks[i].toLowerCase().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat)$/, "");
      const interp = INLINE_INTERPRETERS.find((x) => x.names.includes(raw));
      if (interp) {
        for (let j = i + 1; j < toks.length; j++) {
          const t = toks[j].toLowerCase();
          if (t.startsWith("-") && interp.flags.includes(t)) return `${raw} ${t} 内联执行`;
          if (!t.startsWith("-")) break; // 遇到第一个非选项 token (脚本文件/模块名) 即停, 避免误伤 node app.js / python -m venv
        }
      }
    }
    if (/^(npx|pnpx)$/.test(toks[0]) || (/^(pnpm|yarn)$/.test(toks[0]) && toks[1] === "dlx")) {
      return "npx/dlx 即取即执行远程包";
    }
    if (/^(find|fd)$/.test(toks[0]) && toks.some((t) => /^-(exec|execdir|ok)$/i.test(t))) {
      return "find -exec 内联执行外部程序";
    }
    if (toks[0].toLowerCase().replace(/\.exe$/, "") === "git" && toks[1] === "-c") {
      return "git -c 注入配置 (可挂 pager/sshCommand 等执行点)";
    }
  }
  return null;
}

// 统一检查入口:
//   opts = { allowAll|allow_all, allowPrefix, denyList, deny, hardBlock, allow_inline_exec }
//   v1.0.9: 兼容 snake 配置键 allow_all (config.security.allow_all 是 snake, 原只认 camel 导致 allow_all=true 永不生效)
//   返回 { ok: true, normalized } | { ok: false, reason, hard }
export function checkCommand(cmd, opts = {}) {
  const normalized = normalizeCommand(cmd);
  if (!normalized) return { ok: false, hard: false, reason: "空命令" };

  // 1. 用户 deny 规则 (最高优先级, allow_all 也拦)
  const userDeny = (opts && opts.deny) || [];
  for (const d of userDeny) {
    const re = d instanceof RegExp ? d : globToRegExp(d);
    if (re && re.test(normalized)) {
      return { ok: false, hard: true, reason: "用户 deny 规则拦截: " + String(d).slice(0, 60) };
    }
  }

  // 2. 硬黑名单 (allow_all 也拦)
  const hardBlock = (opts && opts.hardBlock) || HARD_BLOCK;
  for (const { pattern, reason } of hardBlock) {
    if (pattern.test(normalized)) return { ok: false, hard: true, reason: "硬黑名单拦截: " + reason };
  }

  // 2.5 解释器内联执行 (硬拦截, allow_all 不可放开; 需显式 allow_inline_exec opt-in)
  //     放在白名单之前, 否则 `node -e ...` 会因首词是 node 而被前缀白名单放行。
  const inlineOptIn = !!(opts && (opts.allow_inline_exec || opts.allowInlineExec));
  if (!inlineOptIn) {
    const inlineHit = findInlineExec(normalized);
    if (inlineHit) {
      return { ok: false, hard: true, reason: `内联执行拦截: ${inlineHit} (需 ${INLINE_EXEC_OPT_IN}=true 才放开)` };
    }
  }

  // 3. 常规高危黑名单 (allow_all 放行)
  const deny = (opts && opts.denyList) || DEFAULT_DENY;
  for (const re of deny) {
    if (re.test(normalized)) return { ok: false, hard: false, reason: "命令被拒绝: 命中高危黑名单 (delete/format/shutdown/curl等)" };
  }

  // 4. 白名单前缀 (allow_all=false 时)
  const allowAll = !!(opts && (opts.allowAll || opts.allow_all));
  if (!allowAll) {
    const allowPrefix = (opts && opts.allowPrefix) || DEFAULT_ALLOW_PREFIX;
    const first = normalized.split(/[\s|&;>]+/)[0];
    const hit = allowPrefix.some((a) => first.toLowerCase().replace(/\.exe$/i, "") === a.toLowerCase());
    if (!hit) {
      return { ok: false, hard: false, reason: `命令不在白名单: ${first}. 允许: git/npm/node/python/cat/cp/mkdir 等, 或设置 security.allow_all.` };
    }
  }

  return { ok: true, normalized };
}

// 兼容导出 (旧 isDeniedCommand 语义: 只查常规高危 + 硬黑名单 + 用户 deny, 不看白名单)
export function isDeniedCommand(cmd, options) {
  return !checkCommand(cmd, { ...(options || {}), allowAll: true }).ok;
}

// 兼容导出 (旧 isAllowedCommand 语义: allow_all 直接放行, 否则查前缀白名单; 不查 deny)
export function isAllowedCommand(cmd, options) {
  if (options && (options.allowAll || options.allow_all)) return true;
  const allowPrefix = (options && options.allowPrefix) || DEFAULT_ALLOW_PREFIX;
  const first = String(cmd || "").trim().split(/[\s|&;>]+/)[0];
  return allowPrefix.some((a) => first.toLowerCase().replace(/\.exe$/i, "") === a.toLowerCase());
}
