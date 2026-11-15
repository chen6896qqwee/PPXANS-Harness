// src/tools/builtin-paths.js - 内置工具的路径/文件安全检查 (2026-11-03 从 builtin.js 拆出)
// 内容: 图片 MIME / 二进制容器拦截提示 / 受保护路径 / 会话内写文件登记 / 安全路径。
// 与 builtin.js 的注册逻辑分离后两者都在 600 行以下; 对外导出仍经 builtin.js re-export。
import fs from "node:fs";
import path from "node:path";
import { noteCatch } from "../utils/catch-log.js";

// 图片 MIME 表 (read_image + 多模态注入共用)
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

// 二进制容器扩展名: write_file/append_file 只写 UTF-8 文本, 直接落这些扩展名会生成
//   打不开的坏文件 (Word/Excel/PPT/PDF 都是 ZIP 或二进制结构)。这里在写入前拦下并给出
//   可行动出口, 而不是让模型写完之后由用户在 Word 里看到"文件已损坏"。
const BINARY_CONTAINER_EXT = {
  ".docx": "office/docx", ".doc": "office/docx",
  ".xlsx": "office/xlsx", ".xls": "office/xlsx",
  ".pptx": "office/pptx", ".ppt": "office/pptx",
  ".pdf": "office/pdf",
};
export function binaryContainerHint(ext) {
  const skill = BINARY_CONTAINER_EXT[ext];
  if (!skill) return null;
  if (ext === ".pdf") {
    return `${ext} 是二进制格式, 文本写入会生成打不开的坏文件。本机没有 PDF 生成器: `
      + `先 load_skill("office/docx") 生成 .docx, 再用 Word/LibreOffice 另存为 PDF。`;
  }
  if (ext === ".doc" || ext === ".xls" || ext === ".ppt") {
    return `${ext} 是旧版二进制格式, 无法用文本写入。请 load_skill("${skill}") 生成新格式 (.${ext}x), 或让用户用 Office 另存。`;
  }
  return `${ext} 是二进制容器格式 (ZIP+XML), 文本写入会生成打不开的坏文件。`
    + `请先 load_skill("${skill}") 按技能说明用其 Python 脚本生成; 纯文本内容可先写成 .md/.txt。`;
}

// ---- 受保护路径 (2026-10-31 安全收紧, 禁读) ----
// read_file 在 TRUSTED_TOOLS 白名单里 (免审批直达)。不设防时, 被提示注入的 agent 可以
//   免审批读到: 审计链 HMAC 密钥 (.ppx/audit-hmac-key → 重算重签整条审计链)、HTTP
//   Bearer token (data/http-token → 伪装成人在 API 面)、provider 配置 (config/ppx.json,
//   可能含明文 api_key)。比对统一小写 + 正斜杠 (Windows 大小写不敏感)。
// 已知残留: grep/search 类工具与读文档工具不在此列 (本轮只收口 read_file 主通道)。
const PROTECTED_READ = [
  /\/\.ppx\/audit-hmac-key$/,   // 审计链 HMAC 锚点
  /\/http-token$/,              // HTTP Bearer token
  /\/config\/ppx\.json$/,       // provider 配置 (可能含明文 key)
  /\/jobs\/[^/]+\.log$/,        // run_background 日志 (可能含命令输出/密钥) — 只允许 job 工具读
];
export function isProtectedRead(absPath) {
  const cmp = String(absPath).toLowerCase().replace(/\\/g, "/");
  return PROTECTED_READ.some((re) => re.test(cmp));
}

// ---- 会话内"写工具动过"的文件登记 (2026-10-31 安全收紧) ----
// 动机: 命令守卫 argv0 白名单放行 `node app.js` (script 文件形态刻意放行, 属正常用法),
//   但若 app.js 是本会话刚由 write_file/apply_patch 写出的, "写文件 + node 执行" 连招
//   即构成绕过白名单的任意代码执行。因此登记会话内被写工具改过的路径, run_command 在
//   执行 node 类脚本前比对, 命中即拒 (需人工审批)。生命周期 = 进程 (会话); 只存路径
//   不存内容, 进程退出即失。
export const sessionWrittenFiles = new Set();
export function rememberSessionWrite(absPath) {
  try {
    sessionWrittenFiles.add(path.resolve(String(absPath)).toLowerCase());
  } catch (e) { noteCatch(e); /* 登记失败不阻断写路径 (拦截能力降级, 不添堵) */ }
}

// ---- 敏感写入守卫 (2026-11-08 安全收口) ----
// 动机: 命令守卫 argv0 白名单放行 git/npm/node, 而 write_file 可写工作区内任意文件
//   (safePath 只判"在 root 内") —— 白名单命令 + 写工具连招即构成任意代码执行:
//     write_file(.git/hooks/pre-commit) + git commit      → hook 注入
//     write_file(package.json scripts)    + npm install   → 生命周期脚本注入
// 两层收口: 1) .git/ 一律拒写 (内部对象/hook/ref 不归文件工具管, 走 git 命令或人工);
//           2) 包清单/脚本文件可写但进会话登记表, run_command 执行 npm 类命令前比对
//              (findSessionWrittenManifest, 本文件), 命中即拒 —— 与既有 write+node
//              连招拦截同一语义 (需人工审批)。
const NPM_MANIFEST_BASENAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
]);

// 审计链完整性产物: 账本 / seq 档 / HMAC 密钥。
// 动机 (2026-11-12 体检): 这些文件默认落在 agent 可写根内, 被提示注入的 agent 用 write_file
//   截断尾行、改写 audit.seq 就能让 audit_verify 返回完整; 密钥可读则更能整链重签。
//   文件工具一律拒写 (审计写入只走 audit-chain 的内部追加路径), 读侧由 PROTECTED_READ 收口。
const PROTECTED_WRITE = [
  /\/\.ppx\/audit-hmac-key$/,
  /\/logs\/audit\.ndjson$/,
  /\/logs\/audit\.seq$/,
];
export function sensitiveWriteHint(absPath) {
  const cmp = String(absPath).toLowerCase().replace(/\\/g, "/");
  if (cmp.includes("/.git/") || cmp.endsWith("/.git")) {
    return ".git 目录拒绝写入 (git 内部对象/hook/ref 不归文件工具改): "
      + "需要配置 hook 或版本操作时请走 git 命令, 并让用户确认。";
  }
  if (PROTECTED_WRITE.some((re) => re.test(cmp))) {
    return "审计链产物 (.ppx/audit-hmac-key、logs/audit.ndjson、logs/audit.seq) 拒绝写入: "
      + "审计账本只允许追加, 改写会破坏可验证性。需要处置请用 audit_verify(quarantine=true) 并让用户确认。";
  }
  return null;
}

// 是否包清单文件 (登记判定用; 本会话写过之后 npm/pnpm/yarn/npx 执行前会拦)
export function isNpmManifestPath(absPath) {
  const cmp = String(absPath).toLowerCase().replace(/\\/g, "/");
  return NPM_MANIFEST_BASENAMES.has(cmp.split("/").pop());
}

// ---- 会话内写过的脚本/包清单执行前比对 (run_command 用) ----
// 会话内新写脚本命中检查 (2026-10-31 安全收紧): 命令行上出现 node/bun/deno 且目标是
//   本会话由写工具新建/修改过的 .js/.mjs/.cjs 时返回该脚本, 否则 null。
//   逐段拆 (&& || ; |) 逐词扫: 解释器词后的第一个非 flag 词若为脚本即比对登记表;
//   非 脚本 词 (如 -e 的代码串) 直接断 —— -e 形态本就被命令守卫硬拦, 不归这里管。
// 2026-11-08 收口扩面: 解释器词补 sh/bash/python/powershell, 脚本扩展补 .sh/.py/.ps1/.bat/.cmd
//   —— 原词表只认 node 系, "write build.sh + bash build.sh" 同款连招不受拦。
const SESSION_INTERP = /\b(?:node|node\.exe|bun|deno|sh|bash|zsh|python|python3|python\.exe|powershell|pwsh)\b/i;
const SESSION_SCRIPT_EXT = /\.(mjs|cjs|js|sh|py|ps1|bat|cmd)$/i;
export function findSessionWrittenScript(rootDir, cmd, ctx) {
  if (!sessionWrittenFiles.size) return null;
  for (const seg of String(cmd).split(/&&|\|\||;|\|/)) {
    if (!SESSION_INTERP.test(seg)) continue;
    const words = seg.match(/"[^"]*"|\S+/g) || [];
    for (let i = 0; i < words.length; i++) {
      if (!SESSION_INTERP.test(words[i])) continue;
      for (let j = i + 1; j < words.length; j++) {
        const t = words[j].replace(/^"|"$/g, "");
        if (t.startsWith("-")) continue; // 解释器 flag, 继续找脚本
        if (!SESSION_SCRIPT_EXT.test(t)) break; // 第一个非 flag 非脚本词: 不是"解释器 脚本"形态
        let cmp = "";
        try { cmp = safePath(rootDir, t, ctx).toLowerCase(); } catch { break; } // root 外路径不在登记表
        for (const w of sessionWrittenFiles) {
          if (w === cmp) return t;
        }
        break;
      }
    }
  }
  return null;
}

// 包清单连招检查 (2026-11-08 安全收口): 本会话写过 package.json / lockfile 后,
//   执行 npm/pnpm/yarn/npx 即拒 —— "写 scripts 植入 + npm install" = 任意代码执行,
//   与 write+node 连招同语义 (需人工审批)。返回命中的清单文件名, 无则 null。
const NPM_RUNNER = /\b(?:npm|pnpm|yarn|npx|pnpx)(?:\.(?:exe|cmd|ps1))?\b/i;
export function findSessionWrittenManifest(cmd) {
  if (!sessionWrittenFiles.size || !NPM_RUNNER.test(String(cmd))) return null;
  for (const w of sessionWrittenFiles) {
    const base = w.replace(/\\/g, "/").split("/").pop();
    if (NPM_MANIFEST_BASENAMES.has(base)) return base;
  }
  return null;
}

// 读图片文件转 base64 data URL (供 read_image 工具与多模态 user 消息注入复用)
export function imageFileToDataUrl(rootDir, p, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const fp = safePath(rootDir, p);
  const mime = IMAGE_MIME[path.extname(fp).toLowerCase()];
  if (!mime) throw new Error("不支持的文件类型: " + path.extname(fp));
  if (!fs.existsSync(fp)) throw new Error("文件不存在: " + p);
  const buf = fs.readFileSync(fp);
  if (buf.length > maxBytes) throw new Error(`图片过大 (>${Math.round(maxBytes / 1024 / 1024)}MB)`);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// ---- run_command 安全策略 (P0): 统一走命令守卫 (src/tools/command-guard.js) ----
// 三层防线: 用户 deny(security.deny) -> 硬黑名单(allow_all 也拦) -> 常规高危 + 前缀白名单
// 命令守卫的 isDeniedCommand/isAllowedCommand 兼容导出见 command-guard.js

// ---- 路径策略: 工具层的第二道锁要跟着权限档位走 (2026-11-08) ----
// 背景: 第一道锁是 permissions.check 的 findEscape (按沙箱档位判定), 第二道是这里的
//   safePath (无条件锁在 root 内)。此前两道锁不同步 —— 用户把档位切到「完全权限」,
//   permissions 放行了, write_file 里这一层仍然把 C:\Users\chen\Desktop 判成越界,
//   于是前端看到"完全权限"却连列目录都被拒 (真机复现)。
// 现在: ① 完全访问沙箱 → 不做根判定; ② 其余档位 → root ∪ agent.workspace_allow 白名单。
function pathPolicyOf(ctx) {
  const agent = ctx && ctx.agent;
  const perms = agent && agent.permissions;
  const cfg = agent && agent.config;
  const allow = cfg && cfg.agent && Array.isArray(cfg.agent.workspace_allow) ? cfg.agent.workspace_allow : [];
  return {
    allowOutside: !!perms && perms.sandbox === "danger-full-access",
    allowRoots: allow.filter((x) => typeof x === "string" && x.trim()).map((x) => path.resolve(x.trim())),
  };
}

// 安全路径: 阻止逃出允许范围 (防路径穿越)
// v1.0.9: 追加 realpath 校验 — 字符串前缀检查可被工作区内 symlink 指向外部绕过
// 2026-11-08: 第三参传 ctx, 允许范围随权限档位变化 (见 pathPolicyOf)
export function safePath(root, p, ctx) {
  const { allowOutside, allowRoots } = pathPolicyOf(ctx);
  // 跨平台一致防护: Windows 盘符路径在 POSIX 宿主上会被 resolve 当作普通相对路径放行,
  // 故在 POSIX 入口即拒, 保证安全不变量与宿主平台无关 (2026-10-01 修复)。
  const isWin = process.platform === "win32";
  if (!isWin && typeof p === "string" && /^[a-zA-Z]:/.test(p)) {
    throw new Error(`路径越界拒绝: ${p}`);
  }
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, p);
  // 完全访问档: 越过根判定, 但仍返回解析后的绝对路径 (下游统一按绝对路径处理)
  if (allowOutside) return resolved;

  // Windows 文件系统大小写不敏感, 前缀比较也必须忽略大小写, 否则 C:\Foo 与 c:\foo 被判越界
  const eq = (a, b) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
  const startsIn = (child, parent) => {
    const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
    return isWin ? child.toLowerCase().startsWith(withSep.toLowerCase()) : child.startsWith(withSep);
  };
  const roots = [rootResolved, ...allowRoots];
  const within = (abs) => roots.some((r) => eq(abs, r) || startsIn(abs, r));

  if (!within(resolved)) {
    throw new Error(`路径越界拒绝: ${p}`);
  }
  try {
    const realRoot = fs.realpathSync(rootResolved);
    let target = resolved;
    if (fs.existsSync(target)) {
      target = fs.realpathSync(target); // 存在: 直接解析真实路径
    } else {
      // 不存在: 用最近已存在父目录的真实路径 + 剩余部分 (新建文件场景)
      let dir = path.dirname(target);
      while (dir !== rootResolved && dir !== path.dirname(dir) && !fs.existsSync(dir)) dir = path.dirname(dir);
      target = path.join(fs.realpathSync(fs.existsSync(dir) ? dir : rootResolved), path.relative(dir, resolved));
    }
    // realpath 层同样按"允许范围"判定: 白名单目录内的文件不该因为落在 root 外被拒
    const realRoots = [realRoot];
    for (const r of allowRoots) {
      try { realRoots.push(fs.realpathSync(r)); } catch { /* 白名单目录不存在: 忽略 */ }
    }
    const withinReal = (abs) => realRoots.some((r) => eq(abs, r) || startsIn(abs, r));
    if (!withinReal(target)) {
      throw new Error(`路径越界拒绝 (符号链接): ${p}`);
    }
  } catch (e) {
    if (e && e.message && e.message.includes("路径越界拒绝")) throw e;
    // root 不存在等边缘: 退回前缀检查 (已通过)
  }
  return resolved;
}
