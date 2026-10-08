// src/tools/command-guard.js - 命令守卫 (吸收 Hermes Agent approval 机制)
// 四层防线:
//   1. 用户 deny 规则 (config.security.deny, glob 风格) — 最高优先级, 即使 allow_all 也拦
//   2. 硬黑名单 HARD_BLOCK (rm -rf /、fork bomb、写裸设备、管道到 shell、重定向写敏感位置) — allow_all 也拦
//   3. 常规高危黑名单 DEFAULT_DENY (继承皮皮虾 P0)
//   3.5 内联执行规则 INLINE_EXEC_RULES (解释器/包执行器/git 钩子带内联参数) — allow_all 也拦,
//       需 security.allow_inline_exec 显式放开 (2026-10-04 复审: 原白名单只看首词,
//       node/python/git/find/tar/npx 自身即执行器 ⇒ "白名单前缀"等于任意代码执行)
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
  // 2026-10-04 复审补口: 白名单里的 cat/echo/type 可被用作"任意位置写入"入口
  //   (`cat /etc/passwd > ~/.ssh/authorized_keys`, `echo vbs > 启动目录\skip.lnk`)
  { pattern: />>?\s*\S*(~\/|\$home|%userprofile%|\/etc\/|\/root\/|\.ssh|start\s?menu|startup|\.bashrc|\.bash_profile|\.zshrc|\.profile|launchagents|\\appdata\\roaming\\microsoft\\windows\\start menu)/i, reason: "重定向写入敏感位置 (授权密钥/启动项/shell rc/系统配置)" },
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

// ---- 内联执行规则 (2026-10-04 安全复审新增, 第 4 层之前的硬规则) ----
// 白名单只看首词 (原 step 4 取 split(/[\s|&;>]+/)[0]) ⇒ node/python/git/find/tar/npm 这些
// "本身就是执行器"的命令带内联参数时等于任意代码执行:
//   `python -c __import__("os").system("id")` / `node -e ...` / `git -c core.fsmonitor=/tmp/x status`
//   `find . -exec sh ;` / `tar --checkpoint-action=exec=...` / `npx evil-pkg`
// 这类形态一律不进白名单 —— **且 security.allow_all 也不能放行** (allow_all 的语义是
// "放开常规高危黑名单", 不是 "任意代码执行免检")。想放开: security.allow_inline_exec=true。
// 更安全的等价写法是把脚本落盘再执行 (write_file + `node file.js`), 规则对此不加严。
export const INLINE_EXEC_RULES = [
  { cmds: ["node", "deno", "bun"], flag: /^(-e|--eval|-p|--print|-c|--input-type=\S+)$/i, reason: "内联 JS 代码" },
  // -c/-e 与组合短选项 (python -ic) 直接执行内联源码; 裸 `-` = 从 stdin/heredoc 读脚本。
  // 不含 -m: `python -m pip install` / `-m venv` 是常规用法, 执行的是环境里已有的模块而非内联源码
  { cmds: ["python", "python3", "python2", "pypy", "pypy3", "perl", "perl5", "ruby"], flag: /^(-c|--command|-e|--eval|-|-[a-z]*c[a-z]*)$/i, reason: "内联脚本代码 (-c/-e 或 stdin heredoc)" },
  { cmds: ["php"], flag: /^(-r|--run|-a|--interactive)$/i, reason: "php -r 内联脚本代码" },
  { cmds: ["sh", "bash", "zsh", "dash", "ksh"], flag: /^(-c|--command|-s|--stdin)$/i, reason: "内联 shell 命令" },
  { cmds: ["cmd"], flag: /^\/[ck]$/i, reason: "cmd /c 内联 shell 命令" },
  { cmds: ["powershell", "pwsh"], flag: /^(-c|--command|-e|-enc|-encodedcommand|-encodewithprotectedstring|-inputformat|-file|-commandfile)$/i, reason: "PowerShell 内联/编码命令" },
  { cmds: ["git"], flag: /^-c$|^--exec-path$|^--git-dir$|^--work-tree$/i, reason: "git -c/--exec-path 配置注入可执行外部命令 (core.fsmonitor/alias/pager)" },
  { cmds: ["find", "fd"], flag: /^(-exec|-execdir|-ok|-okdir|--exec)$/i, reason: "find -exec 派生任意进程" },
  { cmds: ["tar"], flag: /^--(checkpoint-action|to-command|use-compress-program|rsh-command|index-file)$/i, reason: "tar 钩子执行外部命令" },
  // 只拦"以执行任意包代码为目的"的动词; install/add 属常规依赖安装 (跑 postinstall 但语义中立),
  // 不在本层拦截, 由 run_command 的高危审批与用户 deny 规则管
  { cmds: ["npm", "pnpm", "yarn"], flag: /^(exec|dlx|create|global|unsafe)$/i, reason: "包执行器拉起任意第三方包代码" },
  // npx 的语义本身就是"按包名拉起并执行第三方代码": 任何非 flag 位置参数都算 (npx tsc / npx create-x)
  { cmds: ["npx"], flag: /^(?!-)\S+$/i, reason: "npx 按包名拉起任意第三方包代码" },
];

// 前导包装器: `env python -c` / `sudo node -e` / `nohup bash -c` 不改变实际执行的程序
const EXEC_WRAPPERS = new Set(["env", "sudo", "nohup", "time", "nice", "stdbuf", "command", "exec", "doas"]);

// 把一条命令拆成管道段并解析出真实执行程序 + 参数 token
export function parseCommandSegments(normalized) {
  const out = [];
  for (const raw of String(normalized || "").split(/[|&;]+/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const base = pathBasename(tokens[i]);
      if (EXEC_WRAPPERS.has(base)) { i++; continue; } // 跳过 env/sudo 等包装器
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) { i++; continue; } // 跳过 FOO=bar 前置赋值
      break;
    }
    if (i >= tokens.length) continue;
    out.push({ exe: pathBasename(tokens[i]).replace(/\.exe$/i, "").toLowerCase(), args: tokens.slice(i + 1) });
  }
  return out;
}

function pathBasename(t) {
  return String(t || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

// 命中内联执行规则 → 返回原因; 未命中返回 null
export function findInlineExec(normalized) {
  for (const { exe, args } of parseCommandSegments(normalized)) {
    if (!exe) continue;
    for (const rule of INLINE_EXEC_RULES) {
      if (!rule.cmds.includes(exe)) continue;
      for (const a of args) {
        // 去引号后的 token 里可能带粘连值 (`--input-type=module` / `git -c key=val` 的 key 段)
        const tok = a.replace(/^["']+|["']+$/g, "");
        if (tok && rule.flag.test(tok)) return `${exe} ${tok} (${rule.reason})`;
      }
    }
  }
  return null;
}

// 命中拦截后附加的指引: 明确告知不要重试/改写绕过 (Hermes approval 同款约束)
export const DENY_HINT = " 命中后不要重试或改写命令绕过 — 确需执行请让用户调整 security 配置。";

// glob 风格规则 ('git push --force*') -> 正则
export function globToRegExp(glob) {
  let s = String(glob || "").trim();
  if (!s) return null;
  s = s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  try { return new RegExp("^" + s + "$", "i"); } catch { return null; }
}

// 统一检查入口:
//   opts = { allowAll|allow_all, allowPrefix, denyList, deny, hardBlock }
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

  // 3. 常规高危黑名单 (allow_all 放行)
  const deny = (opts && opts.denyList) || DEFAULT_DENY;
  for (const re of deny) {
    if (re.test(normalized)) return { ok: false, hard: false, reason: "命令被拒绝: 命中高危黑名单 (delete/format/shutdown/curl等)" };
  }

  // 3.5 内联执行硬规则 (allow_all 也不放开; security.allow_inline_exec=true 才放开)
  //   放在白名单之前是因为白名单只看首词, 对"首词是执行器"的命令无语义 (见 INLINE_EXEC_RULES)
  //   skipInlineExec: code_act 的执行形态本就是"脚本落盘再执行", 扫脚本内容属类别错误
  if (opts && (opts.skipInlineExec || opts.allowInlineExec || opts.allow_inline_exec)) {
    // 显式放开 (配置或调用方声明) 时跳过本层
  } else {
    const inline = findInlineExec(normalized);
    if (inline) {
      return {
        ok: false,
        hard: true,
        needsApproval: true,
        reason: `内联执行不进白名单且不随 allow_all 放开: ${inline}. 建议把脚本写入文件后执行 (如 write_file + node file.js), 或设置 security.allow_inline_exec=true`,
      };
    }
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
