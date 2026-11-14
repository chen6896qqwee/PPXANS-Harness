// src/tools/command-guard.js - 命令守卫 (设计溯源 docs/PROVENANCE.md#hermes Agent approval 机制)
// 三层防线:
//   1. 用户 deny 规则 (config.security.deny, glob 风格) — 最高优先级, 即使 allow_all 也拦
//   2. 硬黑名单 HARD_BLOCK (rm -rf /、fork bomb、写裸设备、管道到 shell 等) — allow_all 也拦
//   3. 常规高危黑名单 DEFAULT_DENY (继承皮皮虾 P0) — allow_all 放行
//   4. 白名单前缀 (allow_all=false 时) — 只放行已知安全命令前缀
// 反混淆: normalizeCommand 先去引号再规范化空白, 防 `rm ""-rf` / `bash <(curl)` 引号技巧绕过
// 2026-10-24: 结构化解析接线 (security/shell-parse.js) —— 旧链路对"规范化副本"做整串正则,
//   执行层却是 `sh -c 原串`, 检测串≠执行串。现在: ① 命令替换 $( )/反引号/进程替换按内联执行
//   同级硬拦 (allow_all 不可放开, 需 allow_inline_exec); ② 白名单从"整串首词"升级为
//   "逐段 argv0" (`git status; someRandomBin` 不再因首词是 git 而整体放行)。
import { parseShellCommand } from "../security/shell-parse.js";

// ---- 反混淆规范化: 仅用于检测, 不用于实际执行 ----
// 2026-11-06 (评估 P1-2) 升级两步, 封堵"检测串 ≠ 执行串"的残余面:
//   ① 剥转义: bash 里 `\m` 就是 `m` —— `r\m -rf /` 的旧检测串含反斜杠, 所有 rm 正则
//      全部漏配, 而执行层 sh -c 会剥掉它。检测前必须还原成 shell 实际看到的词。
//   ② 同串变量展开: `X=rm; $X -rf /` 的语义在 $X 展开后才是 rm —— 对串内"赋值段"
//      做保守静态求值, 把 $VAR/${VAR} 替换为赋值内容 (最多 3 轮, 防御性上限)。
//   无法求值的 $VAR 原样保留: 白名单模式下它不是合法 argv0 本来就会被拒;
//   allow_all 模式下由操作者自担开放面。检测方向刻意"宁多勿漏"。
export function normalizeCommand(cmd) {
  let s = String(cmd || "");
  s = s.replace(/["'`]/g, ""); // 去引号防绕过
  s = s.replace(/\\(.)/g, "$1"); // 剥转义: 检测串还原成 shell 实际看到的词
  s = expandSameStringVars(s); // 同串赋值展开: $VAR/${VAR} → 赋值内容
  s = s.replace(/\s+/g, " ").trim(); // 合并空白
  return s;
}

// 同串赋值展开 (P1-2): 收集各段开头连续的 NAME=value 赋值 token, 展开 $NAME/${NAME}。
//   只做字面替换, 不求值命令替换 (那类构造另有硬拦); 过度收集 (把管道段里的赋值也算上)
//   只会让检测串更接近执行语义, 属保守方向。
function expandSameStringVars(s) {
  const env = new Map();
  const parts = s.split(/\s*(?:&&|\|\||;|\||\n)\s*/);
  for (const part of parts) {
    const toks = part.split(/\s+/).filter(Boolean);
    for (const t of toks) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
      if (!m) break; // 只收集段首连续赋值 (bash 语义: X=1 Y=2 cmd 也是赋值前缀)
      env.set(m[1], m[2]);
    }
  }
  if (!env.size) return s;
  for (let round = 0; round < 3; round++) {
    const before = s;
    s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (all, a, b) => (env.has(a || b) ? env.get(a || b) : all));
    if (s === before) break;
  }
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
  // 2026-11-02: 允许下载器带选项 (`wget -qO- url | sh` 旧模式只匹配"命令后单个 token", 可绕过)
  { pattern: /(curl|wget)\b[^|;&\n]*\|[\s]*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i, reason: "管道下载内容到 shell 执行 (不可信代码)" },
  { pattern: /(ba|z|k)?sh\s*<\s*\(\s*(curl|wget)/i, reason: "进程替换执行远程内容" },
];

// ---- 常规高危黑名单 (继承皮皮虾 P0: 删除/格式化/关机/强杀/强制推送等) ----
// 注意 (2026-10-25 评估修复): 本清单在 checkCommand 中无条件生效 (allow_all 也不放行),
// 头部旧注释"allow_all 放行"与代码不符 —— 保留更严格的代码行为, 以注释为准更正。
// 2026-10-25 补 \bdel\s: Windows 删除命令 del (此前只匹配 delete/erase, del file 可漏)。
//   用 \bdel\s 而非 \bdel\b: "del " = 命令带参形态, 不误伤 node del.js 这类文件名。
export const DEFAULT_DENY = [
  /\bdelete|\berase\b|rmdir|rd \/s|deltree|\bdel\s/i,
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
  // 2026-11-03: Windows 原生文本/路径工具。run_command 在 win32 走 cmd.exe /c
  //   (见 src/seam/shell.js), POSIX 的 grep/head/tail/find 不一定在系统 PATH 上;
  //   不补下面这些, 模型在 Windows 下没有任何可用的文本检索命令 (findstr 此前还会
  //   被白名单直接拒绝)。这些命令在 POSIX 上不存在, 列入白名单无副作用。
  "findstr", "where", "more", "sort", "fc", "attrib",
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
  // short: 单横线短选项字母集 —— 支持簇写法 (-lc / -ec / -pe) 与紧贴载荷 (-e"code")
  { names: ["node", "nodejs"], flags: ["-e", "-p", "--eval", "--print"], short: ["e", "p"] },
  { names: ["bun"], flags: ["-e", "-p", "--eval", "--print"], short: ["e", "p"] },
  { names: ["deno"], flags: [], short: [], subcommands: ["eval"] },
  { names: ["python", "python2", "python3", "py"], flags: ["-c"], short: ["c"] },
  { names: ["perl", "ruby"], flags: ["-e"], short: ["e"] },
  { names: ["php"], flags: ["-r"], short: ["r"] },
  { names: ["bash", "sh", "zsh", "ksh", "dash"], flags: ["-c"], short: ["c"] },
  // powershell 不参与短选项簇判定: "-NoProfile" 这类单横线长选项很常见, 按簇会误伤。
  { names: ["powershell", "pwsh"], flags: ["-c", "-command", "-enc", "-encodedcommand", "-e"] },
  // 2026-10-25 评估修复补: cmd.exe /c 任意命令 —— 此前清单漏 cmd, `cmd /c <any>`
  //   可携带任意载荷 (flagPrefix "/" 因 Windows cmd 用 / 前缀选项, 非 - 前缀)。
  { names: ["cmd"], flags: ["/c", "/k", "/r"], flagPrefix: "/" },
];
const INLINE_EXEC_OPT_IN = "security.allow_inline_exec";

// ---- 上下文白名单 (2026-11-06, 评估 P1-2): 只读文本工具的"参数正文"不是执行语义 ----
// DEFAULT_DENY 的 delete/restart/curl 等是按"词"匹配整串的 —— `grep -rn delete/restart`
// 的检索词、`git commit -m "fix curl"` 的提交说明都是数据, 却会命中黑名单 (误报)。
// 当【每一段】的 argv0 都是只读文本工具时, 高危词匹配改在"命令骨架" (argv0 + git 子命令 +
// 选项名) 上做: 正文参数不参与。任何一段 argv0 不在安全集 → 维持旧口径全串匹配。
// 安全性依据: 这些命令的参数不执行任意代码 (find -exec / node -e 等均不在集内, 命令替换
// 与内联解释器在此步之前已硬拦); 选项值也只保留选项名 (--grep=delete → --grep), 值中的
// 关键词同样不参与匹配。
const ARG_TEXT_SAFE_ARGV0 = new Set([
  "grep", "egrep", "fgrep", "rg", "findstr", "cat", "head", "tail", "less", "more",
  "wc", "sort", "uniq", "diff", "man", "ls", "dir", "tree", "type", "git",
]);
// git 只有"参数不执行代码"的子命令参与骨架化; bisect run / filter-branch 等除外
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "blame", "branch", "commit", "tag", "stash",
  "remote", "describe", "rev-parse", "shortlog", "reflog", "ls-files", "help", "version",
]);

function argv0OfToken(t) {
  return String(t || "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

// 选项 token → 只留选项名: `--grep=delete` → `--grep`, `-m"fix curl"` (去引号后 -mfix curl)
// → `-m` (取首段字母簇)。结构化规则 (git push --force 等) 只需选项名即可命中。
function flagSkeleton(t) {
  const dashes = t.startsWith("--") ? "--" : "-";
  const body = t.replace(/^-+/, "");
  const alpha = (/^[a-z]+/i.exec(body) || [""])[0];
  return alpha ? dashes + alpha.toLowerCase() : "";
}

// 全部段均为只读文本工具 → 返回骨架串; 否则 null (维持全串匹配)。
function safeContextSkeleton(struct) {
  const segs = struct?.segments || [];
  if (!segs.length) return null;
  const parts = [];
  for (const words of segs) {
    let i = 0;
    // 跳过段首赋值前缀 (X=1 grep ... 的 argv0 是 grep, 不是 X=1)
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(words[i]?.text || ""))) i++;
    if (i >= words.length) return null; // 纯赋值段: 保守起见不参与骨架化
    const argv0 = argv0OfToken(words[i]?.text);
    if (!ARG_TEXT_SAFE_ARGV0.has(argv0)) return null;
    const out = [argv0];
    if (argv0 === "git") {
      const sub = String(words[i + 1]?.text || "").toLowerCase();
      if (!SAFE_GIT_SUBCOMMANDS.has(sub)) return null; // 未知/危险子命令 → 全串匹配
      out.push(sub);
      i += 1;
    }
    for (i = i + 1; i < words.length; i++) {
      const t = String(words[i]?.text || "");
      if (t.startsWith("-") || (t.startsWith("/") && argv0 === "findstr")) {
        const f = flagSkeleton(t);
        if (f) out.push(f);
      }
      // 非选项 token = 参数正文, 一律剔除
    }
    parts.push(out.join(" "));
  }
  return parts.join(" ; ");
}

// 单个 token 是否命中"内联执行"开关。2026-11-02 修复三类绕过:
//   ① `bash -lc "..."` / `node -pe "..."` —— 短选项簇, 逐字母判定;
//   ② `node --eval="..."` —— 长选项 = 值形态;
//   ③ `python -c'...'` —— 去引号后载荷紧贴选项 (壳会执行, 旧逻辑按整 token 精确比较漏掉)。
function inlineFlagHit(token, interp) {
  const t = String(token || "").toLowerCase();
  if (!t) return false;
  if (interp.flagPrefix && t.startsWith(interp.flagPrefix)) {
    return interp.flags.includes(interp.flagPrefix + t.slice(1));
  }
  if (!t.startsWith("-")) return false;
  const body = t.replace(/^-+/, "");
  if (!body) return false;
  const eq = body.indexOf("=");
  const head = eq >= 0 ? body.slice(0, eq) : body;
  const dash = t.startsWith("--") ? "--" : "-";
  if (interp.flags.includes(dash + head)) return true;
  if (dash !== "-" || !interp.short) return false;
  // 短选项簇: 任一字母命中即算 (-lc / -ec / -pe)
  if (/^[a-z]+$/.test(head)) {
    for (const ch of head) if (interp.short.includes(ch)) return true;
    return false;
  }
  // 紧贴载荷: -e"console.log(1)" 去引号后是 -econsole.log(1), 首字母是短选项即算
  return head.length > 1 && interp.short.includes(head[0]);
}

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
        if (interp.subcommands && toks[i + 1] && interp.subcommands.includes(toks[i + 1].toLowerCase())) {
          return `${raw} ${toks[i + 1]} 内联执行`;
        }
        for (let j = i + 1; j < toks.length; j++) {
          const t = toks[j].toLowerCase();
          if (inlineFlagHit(t, interp)) return `${raw} ${t} 内联执行`;
          const isFlag = t.startsWith("-") || (interp.flagPrefix && t.startsWith(interp.flagPrefix));
          if (!isFlag) break; // 遇到第一个非选项 token (脚本文件/模块名) 即停, 避免误伤 node app.js / python -m venv
        }
      }
    }
    // 2026-11-02: 补 bun x / npm exec / yarn exec —— 与 npx 同为"即取即执行远程包"
    if (/^(npx|pnpx|bunx)$/.test(toks[0]) ||
        (/^(pnpm|yarn)$/.test(toks[0]) && /^(dlx|exec)$/.test(toks[1] || "")) ||
        (/^npm$/.test(toks[0]) && toks[1] === "exec") ||
        (/^bun$/.test(toks[0]) && toks[1] === "x")) {
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

  // 2.6 结构化检测 (2026-10-24, 基于 security/shell-parse.js, 在原串上做 —— 非规范化副本):
  //     a) 命令替换/进程替换 = 把任意代码交给 shell 执行的构造, 与内联解释器同级硬拦。
  //        旧链路 `echo $(rm -rf /)` 在 allow_all=true 下可整体放行 (HARD_BLOCK 的 / 结尾锚点
  //        被 ")" 破坏), 而执行层真会跑 `sh -c` —— 此处封死该面。
  //     b) 解析失败容错: 分词永远成功 (逐字符扫描), 无异常路径。
  const struct = parseShellCommand(cmd);
  if (!inlineOptIn && struct.substitutions.length) {
    const first = struct.substitutions[0];
    return { ok: false, hard: true, reason: `命令替换拦截: ${first.type} (展开语义 = 任意代码执行, 需 ${INLINE_EXEC_OPT_IN}=true 才放开)` };
  }

  // 3. 常规高危黑名单 (allow_all 放行)
  //    2026-11-06 (评估 P1-2): 全部段都是只读文本工具时, 高危词匹配改在命令骨架上做 ——
  //    `grep -rn delete/restart` / `git commit -m "fix curl"` 的参数正文是数据不是命令,
  //    不再误报。任一段不在上下文白名单 → 维持旧口径全串匹配 (宁误报不漏拦)。
  const deny = (opts && opts.denyList) || DEFAULT_DENY;
  const skeleton = safeContextSkeleton(parseShellCommand(cmd));
  const denyTarget = skeleton || normalized;
  for (const re of deny) {
    if (re.test(denyTarget)) return { ok: false, hard: false, reason: "命令被拒绝: 命中高危黑名单 (delete/format/shutdown/curl等)" };
  }

  // 4. 白名单前缀 (allow_all=false 时)
  //    2026-10-24 升级: 逐段 argv0 校验 (shell-parse 分段) —— 旧逻辑只看整串第一个词,
  //    `git status; curl ...` 会因首词 git 而整体过白名单。现在每个简单命令段都必须命中白名单。
  const allowAll = !!(opts && (opts.allowAll || opts.allow_all));
  if (!allowAll) {
    const allowPrefix = (opts && opts.allowPrefix) || DEFAULT_ALLOW_PREFIX;
    const allowed = new Set(allowPrefix.map((a) => a.toLowerCase()));
    // argv0 可能带 .exe (git.exe / python.exe) —— 白名单按裸命令名登记, 归一后再比
    const offenders = struct.argv0s.filter((a) => a && !allowed.has(a) && !allowed.has(a.replace(/\.exe$/i, "")));
    const first = struct.argv0s[0] || normalized.split(/[\s|&;>]+/)[0] || "";
    if (offenders.length) {
      return { ok: false, hard: false, reason: `命令不在白名单: ${offenders[0]}${struct.argv0s.length > 1 ? ` (第 ${struct.argv0s.indexOf(offenders[0]) + 1} 段)` : ""}. 允许: git/npm/node/python/cat/cp/mkdir 等, 或设置 security.allow_all.` };
    }
    if (!first) {
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
