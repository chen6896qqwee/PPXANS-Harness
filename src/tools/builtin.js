// src/tools/builtin.js - 内置工具集 (皮皮虾的手脚)
// 文件/命令/时间/记忆查询 — 全部零依赖, 用 Node 原生
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubPII } from "../utils/pii.js";
import { LocalShellProvider } from "../seam/shell.js";
import { checkCommand, DENY_HINT } from "./command-guard.js";
import { formatToolResultHeader, countLines } from "./seam.js";
import { jsSyntaxOutcome, jsExportSelfCheck, DEFAULT_SYNTAX_TIMEOUT_MS, JS_SELF_CHECK_EXT } from "../core/postcondition.js";
// 2026-10-24 (R2): 文件级快照/回滚 —— 写/删/追加前入撤销栈, undo_file 可回退
import { Snapshot } from "../edit/snapshot.js";
// 来源分级渲染 (memory_search / 记忆检索路径): 让"工具抓来的正文"带隔离标签进模型上下文
import { describeHits } from "../memory/provenance.js";

const execFileP = promisify(execFile);

// 默认 shell provider (未通过 seam 注入时的兜底, 供测试/独立工具目录使用)
const defaultShell = new LocalShellProvider();

// 图片 MIME 表 (read_image + 多模态注入共用)
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

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
];
function isProtectedRead(absPath) {
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
  } catch { /* 登记失败不阻断写路径 (拦截能力降级, 不添堵) */ }
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

// 安全路径: 阻止逃出工作目录 (防路径穿越)
// v1.0.9: 追加 realpath 校验 — 字符串前缀检查可被工作区内 symlink 指向外部绕过 (resolve 后仍在 root 内但实际文件在外部)
export function safePath(root, p) {
  // 跨平台一致防护: Windows 盘符路径 (C:\... / C:/... / C:...) 在 POSIX 宿主上会被
  // resolve 当作普通相对路径放行 (创建出名为 "C:\Windows" 的怪异文件),
  // 故在 POSIX 入口即拒, 保证安全不变量与宿主平台无关 (2026-10-01 修复)。
  // 2026-10-10 修复 (P0): 原实现对【任何】宿主都一刀切拒绝 `X:` 开头的串 ——
  //   在 Windows 宿主上连"工作区内的绝对路径"都被判越界 (taskbench 里表现为
  //   list_dir 被归因成"执行报错"), 而大小写不同的同一目录写法也会被前缀比较误判。
  //   现改为: Windows 上按 resolve 结果判定 (盘外的照样拒), POSIX 上保留入口即拒。
  const isWin = process.platform === "win32";
  if (!isWin && typeof p === "string" && /^[a-zA-Z]:/.test(p)) {
    throw new Error(`路径越界拒绝: ${p}`);
  }
  const resolved = path.resolve(root, p);
  // Windows 文件系统大小写不敏感, 前缀比较也必须忽略大小写, 否则 C:\Foo 与 c:\foo 被判越界
  const eq = (a, b) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
  const startsIn = (child, parent) => {
    const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
    return isWin ? child.toLowerCase().startsWith(withSep.toLowerCase()) : child.startsWith(withSep);
  };
  if (!eq(resolved, root) && !startsIn(resolved, root)) {
    throw new Error(`路径越界拒绝: ${p}`);
  }
  try {
    const realRoot = fs.realpathSync(root);
    let target = resolved;
    if (fs.existsSync(target)) {
      target = fs.realpathSync(target); // 存在: 直接解析真实路径
    } else {
      // 不存在: 用最近已存在父目录的真实路径 + 剩余部分 (新建文件场景)
      let dir = path.dirname(target);
      while (dir !== root && dir !== path.dirname(dir) && !fs.existsSync(dir)) dir = path.dirname(dir);
      target = path.join(fs.realpathSync(fs.existsSync(dir) ? dir : root), path.relative(dir, resolved));
    }
    if (!eq(target, realRoot) && !startsIn(target, realRoot)) {
      throw new Error(`路径越界拒绝 (符号链接): ${p}`);
    }
  } catch (e) {
    if (e && e.message && e.message.includes("路径越界拒绝")) throw e;
    // root 不存在等边缘: 退回前缀检查 (已通过)
  }
  return resolved;
}

// ---- code_act (CodeAct 出口): 一次提交脚本批量操作, 压 N 轮工具往返 → 1 轮 ----// 安全: 默认关闭 (security.code_act), 开启后限 python/node 解释器 + 工作目录 + 超时 + PII + 黑名单扫描
// 相比 run_command 的增量风险: 脚本体绕过命令串黑名单, 故独立开关 + 默认关闭
// 沙箱加固 (进程级): 干净环境变量(剥离密钥/令牌) + node 内存上限 + 超时强杀进程树 + 输出上限
//   真正隔离需外部 Docker/MicroVM (见 docs/CONFIG.md), 此处为无依赖下的最大进程级约束

// 干净沙箱环境: 只保留运行必需变量, 剥离一切敏感密钥/令牌/凭证, 防脚本窃取宿主凭据
const SANDBOX_ENV_KEEP = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|COMSPEC|OS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|NUMBER_OF_PROCESSORS|LANG|LC_|PYTHONIOENCODING|PYTHONPATH)$/i;
function sandboxEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v && SANDBOX_ENV_KEEP.test(k)) env[k] = v;
  }
  return env;
}

const CODE_ACT_MEMORY_MB = 256;      // node 解释器内存上限
const CODE_ACT_OUTPUT_MAX = 512 * 1024; // 输出上限 512KB

export async function runCodeAct(rootDir, lang, code, timeoutMs) {
  const isWin = process.platform === "win32";
  const ext = lang === "node" ? "js" : "py";
  const tmp = path.join(os.tmpdir(), `ppx_codeact_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`);
  fs.writeFileSync(tmp, code, "utf8");
  const interpreter = lang === "node" ? process.execPath : (isWin ? "python" : "python3");
  // node 加内存上限; python 无等价零依赖参数 (可外接 Docker 时再限制)
  const args = lang === "node" ? [`--max-old-space-size=${CODE_ACT_MEMORY_MB}`, tmp] : [tmp];
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execFileP(interpreter, args, {
      cwd: rootDir,
      timeout: timeoutMs || 30000,
      maxBuffer: CODE_ACT_OUTPUT_MAX,
      env: sandboxEnv(),
      windowsHide: true,
    });
    const ms = Date.now() - t0;
    const out = (stdout || "") + (stderr ? "\n[stderr] " + stderr : "");
    // B1: code_act 同样带统一元数据头 (成功即 exit=0)
    const head = formatToolResultHeader({ ms, lineCount: countLines(out), exitCode: 0 });
    return head + "\n" + (scrubPII(out).cleaned.slice(0, 20000) || "(无输出)");
  } catch (e) {
    const ms = Date.now() - t0;
    const timedOut = !!(e && (e.killed || /timed out|ETIMEDOUT/i.test(e.message)));
    const head = formatToolResultHeader({ ms, timedOut, timedOutMs: timeoutMs || 30000 });
    // 超时/输出超限/内存超限的友好提示
    if (timedOut) return head;
    return head + "\n" + JSON.stringify({ error: e.message, code: e.code });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

// glob → 正则 (search_files 用): * 匹配同层非分隔字符, ** 跨目录, ? 单字符
// 路径统一按 / 分隔 (path.relative 结果已 normalize), 跨平台一致。
export function globToRegex(pattern) {
  const re = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    // eslint-disable-next-line no-control-regex -- \u0000 是 glob→regex 的占位哨兵 (先占后换), 非误用
    .replace(/\u0000/g, ".*");
  return new RegExp("^" + re + "$");
}

// 注册全部内置工具
export function registerBuiltinTools(catalog, { rootDir, facts, memory }) {
  // 2026-10-24 (R2): 文件撤销栈 —— 写/删/追加前对目标做内存快照 (最近 20 条),
  //   undo_file 按栈回退。覆盖 apply_patch 之外的文件破坏面 (此前只有 apply_patch 有快照)。
  //   仅内存: 进程退出即失 (快照不落盘是刻意的 —— 内容可能含敏感数据, 不复制到第二处)。
  const fileUndoStack = [];
  const UNDO_MAX = 20;
  const rememberUndo = (absPath) => {
    try {
      fileUndoStack.push({ path: absPath, snap: Snapshot.begin([absPath]), ts: Date.now() });
      if (fileUndoStack.length > UNDO_MAX) fileUndoStack.shift();
    } catch { /* 快照失败不阻断原操作 (回退能力降级, 不添堵) */ }
  };

  // 会话内新写脚本命中检查 (2026-10-31 安全收紧): 命令行上出现 node/bun/deno 且目标是
  //   本会话由写工具新建/修改过的 .js/.mjs/.cjs 时返回该脚本, 否则 null。
  //   逐段拆 (&& || ; |) 逐词扫: 解释器词后的第一个非 flag 词若为 JS 脚本即比对登记表;
  //   非 JS 词 (如 -e 的代码串) 直接断 —— -e 形态本就被命令守卫硬拦, 不归这里管。
  const findSessionWrittenScript = (cmd) => {
    if (!sessionWrittenFiles.size) return null;
    const INTERP = /\b(?:node|node\.exe|bun|deno)\b/i;
    for (const seg of String(cmd).split(/&&|\|\||;|\|/)) {
      if (!INTERP.test(seg)) continue;
      const words = seg.match(/"[^"]*"|\S+/g) || [];
      for (let i = 0; i < words.length; i++) {
        if (!INTERP.test(words[i])) continue;
        for (let j = i + 1; j < words.length; j++) {
          const t = words[j].replace(/^"|"$/g, "");
          if (t.startsWith("-")) continue; // 解释器 flag, 继续找脚本
          if (!/\.(mjs|cjs|js)$/i.test(t)) break; // 第一个非 flag 非 JS 词: 不是"node 脚本"形态
          let cmp = "";
          try { cmp = safePath(rootDir, t).toLowerCase(); } catch { break; } // root 外路径不在登记表
          for (const w of sessionWrittenFiles) {
            if (w === cmp) return t;
          }
          break;
        }
      }
    }
    return null;
  };

  // 1. 读文件
  catalog.register({
    name: "read_file",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "读取文件内容。返回文件文本。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径 (相对工作目录)" } },
      required: ["path"],
    },
    execute: async (args) => {
      const p = safePath(rootDir, args.path);
      if (isProtectedRead(p)) {
        return JSON.stringify({ error: "受保护路径, 禁止读取 (审计锚点/凭证/含密钥配置)" });
      }
      if (!fs.existsSync(p)) return JSON.stringify({ error: `文件不存在: ${args.path}` });
      const content = fs.readFileSync(p, "utf8");
      // v1.0.9: 输出 PII 脱敏 (与 run_command/code_act 一致, 文件可能含密钥/手机号)
      return scrubPII(content).cleaned.slice(0, 20000);
    },
  });

  // 2. 写文件
  catalog.register({
    name: "write_file",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "写入文件 (覆盖)。可用于创建/修改文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "要写入的内容" },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      // v1.0.9: 写入内容上限 512KB (防撑爆磁盘); 路径是目录时给友好错误
      const content = String(args.content ?? "");
      if (content.length > 512 * 1024) return JSON.stringify({ error: `写入内容过大 (>512KB, 当前 ${content.length} 字符)` });
      const p = safePath(rootDir, args.path);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return JSON.stringify({ error: `目标是目录: ${args.path}` });
      }
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        rememberUndo(p); // 2026-10-24 (R2): 覆盖前留撤销点
        fs.writeFileSync(p, content, "utf8");
        rememberSessionWrite(p); // 2026-10-31: 会话内写过的脚本执行前需人工审批 (防 write+node 连招)
        const out = { ok: true, bytes: Buffer.byteLength(content) };
        // 写后自查 (2026-10-05, 与回合级后置校验**同源实现**): .js/.mjs/.cjs 且**无任何导出**时,
        //   回执带一行 selfcheck 提示 —— 否则模型写个没有 export 的 utils.js 也会宣称"已导出",
        //   下游 import 拿到 null。空内容/非 JS/有导出/有 module.exports 一律不出现。
        const selfcheck = jsExportSelfCheck(args.path, content);
        if (selfcheck) out.selfcheck = selfcheck;
        // 语法回执同理: 只报告, 失败不门控、不回滚、不改盘。
        if (JS_SELF_CHECK_EXT.has(path.extname(p).toLowerCase())) {
          try {
            const r = await jsSyntaxOutcome(p, { timeoutMs: DEFAULT_SYNTAX_TIMEOUT_MS });
            // 回执契约: syntax 是**单行文本** (闸门据此判定, 与 write 写后自查同口径)
            out.syntax = r && typeof r === "object" ? String(r.text || "") : String(r || "");
            if (r && typeof r === "object" && "ok" in r) out.syntax_ok = !!r.ok;
          } catch { /* 自查故障不污染写入结果, 由校验层自行兜底 */ }
        }
        return JSON.stringify(out);
      } catch (e) {
        return JSON.stringify({ error: `写入失败: ${e.message}` });
      }
    },
  });

  // 2b. 追加文件 (2026-10-02 基线暴露缺口: 无追加能力时 agent 只能整体重写, 易丢原内容)
  catalog.register({
    name: "append_file",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "向文件末尾追加内容 (不覆盖原文件)。文件不存在时等同创建。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "要追加的内容 (追加在文件末尾)" },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const content = String(args.content ?? "");
      if (content.length > 512 * 1024) return JSON.stringify({ error: `追加内容过大 (>512KB, 当前 ${content.length} 字符)` });
      const p = safePath(rootDir, args.path);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return JSON.stringify({ error: `目标是目录: ${args.path}` });
      }
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        // 已有内容且不以换行结尾时补一个换行, 避免追加粘到原末行
        let prefix = "";
        if (fs.existsSync(p)) {
          const old = fs.readFileSync(p, "utf8");
          if (old.length && !old.endsWith("\n")) prefix = "\n";
        }
        rememberUndo(p); // 2026-10-24 (R2): 追加前留撤销点
        fs.appendFileSync(p, prefix + content, "utf8");
        rememberSessionWrite(p); // 2026-10-31: 会话内写过的脚本执行前需人工审批
        return JSON.stringify({ ok: true, appended: Buffer.byteLength(content) });
      } catch (e) {
        return JSON.stringify({ error: `追加失败: ${e.message}` });
      }
    },
  });

  // 2c. 删除文件 (2026-10-02 基线暴露缺口: 无删除工具, agent 只能放弃或绕道)
  catalog.register({
    name: "delete_file",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "workspace", destructive: true },
    description: "删除指定文件 (仅限工作区内, 不能删目录)。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "要删除的文件路径" } },
      required: ["path"],
    },
    execute: async (args) => {
      const p = safePath(rootDir, args.path);
      if (!fs.existsSync(p)) return JSON.stringify({ error: `文件不存在: ${args.path}` });
      if (fs.statSync(p).isDirectory()) return JSON.stringify({ error: `目标是目录, 拒绝删除 (只支持文件): ${args.path}` });
      try {
        rememberUndo(p); // 2026-10-24 (R2): 删除前留撤销点 (undo_file 可恢复)
        fs.unlinkSync(p);
        return JSON.stringify({ ok: true, deleted: args.path, undo_hint: "可用 undo_file 恢复此文件" });
      } catch (e) {
        return JSON.stringify({ error: `删除失败: ${e.message}` });
      }
    },
  });

  // 2e. 移动/重命名文件 (2026-10-24 R3): 权限引擎 WRITE_EXEC_TOOLS 一直引用 move_file,
  //   但工具从未存在 —— 宣称面与实现面缺口。带撤销: 源/目标双双入撤销栈。
  catalog.register({
    name: "move_file",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "移动或重命名文件 (源文件被移走, 目标获得内容)。目标已存在时覆盖。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "源文件路径 (相对工作目录)" },
        destination: { type: "string", description: "目标路径 (相对工作目录)" },
      },
      required: ["path", "destination"],
    },
    execute: async (args) => {
      const src = safePath(rootDir, args.path);
      const dst = safePath(rootDir, args.destination);
      if (!fs.existsSync(src)) return JSON.stringify({ error: `源文件不存在: ${args.path}` });
      if (fs.statSync(src).isDirectory()) return JSON.stringify({ error: `源是目录, 只支持文件: ${args.path}` });
      if (src === dst) return JSON.stringify({ error: "源与目标相同" });
      try {
        rememberUndo(src);
        rememberUndo(dst);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        rememberSessionWrite(dst); // 2026-10-31: 移入/改名后的脚本同属"会话内写过"
        return JSON.stringify({ ok: true, moved: args.path, to: args.destination, undo_hint: "可用 undo_file 撤销 (分别指定源/目标路径)" });
      } catch (e) {
        // rename 跨盘符会失败 (EXDEV): 退回复制+删除
        if (e && e.code === "EXDEV") {
          try {
            fs.copyFileSync(src, dst);
            fs.unlinkSync(src);
            rememberSessionWrite(dst); // 2026-10-31: 跨盘复制同属写入
            return JSON.stringify({ ok: true, moved: args.path, to: args.destination, via: "copy+delete (跨盘)" });
          } catch (e2) {
            return JSON.stringify({ error: `移动失败: ${e2.message}` });
          }
        }
        return JSON.stringify({ error: `移动失败: ${e.message}` });
      }
    },
  });

  // 2d. 撤销文件操作 (2026-10-24 R2): 按撤销栈回退最近一次写/删/追加
  //   write_file → 恢复覆盖前内容 (新建文件则删除); delete_file → 恢复原文件;
  //   append_file → 恢复追加前内容。栈上限 20, 仅内存 (进程退出即失)。
  catalog.register({
    name: "undo_file",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "撤销最近一次文件写/删/追加操作 (恢复到操作前状态)。可指定 path 撤销该文件的最近一次操作, 省略则撤销全局最近一次。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "可选: 只撤销该文件的操作 (相对工作目录)" } },
    },
    execute: async (args) => {
      let entry = null;
      if (args && args.path) {
        const target = safePath(rootDir, args.path);
        for (let i = fileUndoStack.length - 1; i >= 0; i--) {
          if (fileUndoStack[i].path === target) { entry = fileUndoStack[i]; break; }
        }
        if (!entry) return JSON.stringify({ error: `该文件没有可撤销的操作记录: ${args.path} (撤销栈仅保留本次进程内最近 ${20} 条)` });
      } else {
        entry = fileUndoStack[fileUndoStack.length - 1];
        if (!entry) return JSON.stringify({ error: "撤销栈为空: 本次进程内没有可撤销的文件操作" });
      }
      const rb = Snapshot.rollback(entry.snap);
      // 无论成败都出栈 (半恢复状态重放同一快照无意义)
      const idx = fileUndoStack.indexOf(entry);
      if (idx >= 0) fileUndoStack.splice(idx, 1);
      if (!rb.ok) {
        return JSON.stringify({ ok: false, error: `回滚部分失败: ${rb.restored} 成功 / ${rb.failures.length} 失败`, failures: rb.failures });
      }
      return JSON.stringify({ ok: true, restored: entry.path, note: "文件已恢复到该次操作前状态" });
    },
  });

  // 3. 列目录
  catalog.register({
    name: "list_dir",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "列出目录内容 (文件名列表)。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "目录路径, 默认工作目录" } },
    },
    execute: async (args) => {
      // 2026-10-10 修复 (P0): 归一 args —— 无必填参数的工具被以 undefined/null 调用时,
      //   原先 `args.path` 直接 TypeError → [工具错误], 轨迹归因误记为"执行报错 × list_dir"。
      const a = (args && typeof args === "object") ? args : {};
      const p = safePath(rootDir, a.path || ".");
      if (!fs.existsSync(p)) {
        return JSON.stringify({ error: `目录不存在: ${a.path || "."}` });
      }
      if (!fs.statSync(p).isDirectory()) {
        // 目标是文件: 给可判读的业务错误 + 可行动的下一步 (而非崩溃/含糊失败)
        return JSON.stringify({ error: `目标是文件不是目录: ${a.path || "."}, 请改用 read_file 读取内容` });
      }
      const items = fs.readdirSync(p).map((f) => {
        const fp = path.join(p, f);
        const st = fs.statSync(fp);
        return `${st.isDirectory() ? "[D]" : "[F]"} ${f}`;
      });
      // 空目录返回可读标记: 空串会让"空结果"与"失败"无从区分
      return items.length ? items.join("\n") : "(空目录)";
    },
  });

  // 3b. 搜索文件 (glob/正则, 只读) — 2026-10-03 T2 能力提升
  // 上限: 4000 文件 / 深度 14, 防 glob 全库遍历拖垮事件循环
  catalog.register({
    name: "search_files",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "按文件名 glob (如 '*.js'、'src/**/*.ts') 或正则 (/pattern/flags) 在工作区搜索文件, 返回匹配的相对路径列表。只读, 不读文件内容。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "glob 模式 (如 *.js) 或 /正则/ 形式" },
        path: { type: "string", description: "搜索起始目录, 默认工作目录" },
        list_only: { type: "boolean", description: "true 只搜当前目录不递归, 默认 false" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const q = String(args.query || "").trim();
      if (!q) return JSON.stringify({ error: "query 不能为空" });
      const base = safePath(rootDir, args.path || ".");
      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
        return JSON.stringify({ error: `目录不存在: ${args.path || "."}` });
      }
      // 正则形式: /pattern/flags; 否则按 glob
      let re = null;
      let glob = null;
      const reM = q.match(/^\/(.+)\/([a-z]*)$/);
      if (reM) {
        try { re = new RegExp(reM[1], reM[2] || ""); } catch { return JSON.stringify({ error: `非法正则: ${q}` }); }
      } else {
        glob = globToRegex(q);
      }
      const MAX_FILES = 4000;
      const MAX_DEPTH = 14;
      const out = [];
      const walk = (dir, depth) => {
        if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (out.length >= MAX_FILES) return;
          const fp = path.join(dir, e.name);
          const rel = path.relative(rootDir, fp).replace(/\\/g, "/");
          if (e.isDirectory()) {
            if (!args.list_only) walk(fp, depth + 1);
          } else if (e.isFile()) {
            if (re ? re.test(rel) : glob.test(rel)) out.push(rel);
          }
        }
      };
      walk(base, 0);
      if (!out.length) return "(无匹配文件)";
      return out.join("\n");
    },
  });

  // 4. 执行命令 (安全: 限制在允许目录, 超时)
  catalog.register({
    name: "run_command",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "system", destructive: true },
    description: "执行 shell 命令并返回输出。只能在工作目录内执行, 有超时。",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的命令" } },
      required: ["command"],
    },
    execute: async (args, ctx) => {
      const cmd = String(args.command || "").trim();
      if (!cmd) return JSON.stringify({ error: "空命令" });
      const opts = (ctx && ctx.agent && ctx.agent.config && ctx.agent.config.security) || {};
      const guard = checkCommand(cmd, opts);
      if (!guard.ok) {
        return JSON.stringify({ error: guard.reason + DENY_HINT });
      }
      // 2026-10-31 安全收紧: 守卫放行 `node app.js`, 但 app.js 若是本会话刚写出的,
      //   "write_file + node" 连招 = 绕过 argv0 白名单的任意代码执行。命中即拒 (需人工审批)。
      const scriptHit = findSessionWrittenScript(cmd);
      if (scriptHit) {
        return JSON.stringify({ error: `本会话由写工具新建/修改的脚本不允许直接执行 (需人工审批): ${scriptHit}` + DENY_HINT });
      }
      // 通过 shell seam 调用 (可替换 provider: 本地/沙箱/Docker), 换 provider 即换执行环境
      const shell = (ctx?.agent?.ctx && ctx.agent.ctx.consume("shell")) || defaultShell;
      const t0 = Date.now();
      const r = await shell.exec(cmd, { cwd: rootDir, timeoutMs: opts.command_timeout_ms || 30000 });
      const ms = Date.now() - t0;
      // B1: 工具结果标准化 — 统一元数据头, 模型可判成败 (吸收 codex format_exec_output_for_model)
      const timedOut = !!(r && r.timedOut);
      const head = formatToolResultHeader({ ms, lineCount: timedOut ? 0 : countLines(r.stdout + " " + (r.stderr || "")), timedOut, timedOutMs: opts.command_timeout_ms || 30000, exitCode: r.code });
      if (!r.ok && timedOut) return head + "\n[工具错误] run_command: 超时";
      if (!r.ok) return head + "\n[工具错误] run_command: " + (r.stderr || r.stdout || "");
      const out = r.stdout + (r.stderr ? "\n[stderr] " + r.stderr : "");
      const cleaned = scrubPII(out).cleaned.slice(0, 20000) || "(无输出)";
      return head + "\n" + cleaned;
    },
  });

  // 4.5 code_act (CodeAct 出口): 脚本批量操作, 压 N 轮工具往返 → 1 轮
  catalog.register({
    name: "code_act",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "system", destructive: true },
    description: "用 Python/Node 脚本一次性完成多个操作(读文件/处理数据/写结果), 用 print/console.log 输出结果。默认关闭, 需 security.code_act=true。",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "node"], description: "脚本语言" },
        code: { type: "string", description: "脚本内容" },
      },
      required: ["language", "code"],
    },
    execute: async (args, ctx) => {
      const sec = (ctx && ctx.agent && ctx.agent.config && ctx.agent.config.security) || {};
      if (!sec.allow_all && !sec.code_act) {
        return JSON.stringify({ error: "code_act 未开启: 在 security 设置 code_act=true (或 allow_all=true)" });
      }
      const lang = String(args.language || "").toLowerCase();
      if (!["python", "node"].includes(lang)) return JSON.stringify({ error: "language 仅支持 python/node" });
      const code = String(args.code || "");
      if (!code) return JSON.stringify({ error: "空代码" });
      // code_act 是脚本体: 只做 deny 检查 (硬黑名单 + 用户 deny + 常规高危), 不做前缀白名单 (脚本无"命令前缀")
      const guard = checkCommand(code, { ...sec, allowAll: true });
      if (!guard.ok) return JSON.stringify({ error: guard.reason + DENY_HINT });
      const result = await runCodeAct(rootDir, lang, code, sec.command_timeout_ms);
      // 2026-10-31: docker 沙箱只覆盖 run_command (shell seam); code_act 的解释器仍在本机跑 ——
      //   边界如实告知, 不让模型/用户误以为脚本也在容器里 (它默认关闭, 需显式开启)。
      const shellProv = (ctx?.agent?.ctx && ctx.agent.ctx.consume("shell")) || null;
      if (shellProv && shellProv.kind === "docker") {
        return "[边界提示] security.shell_provider=docker 沙箱仅覆盖 run_command; 本脚本由宿主机解释器直接执行。\n" + result;
      }
      return result;
    },
  });

  // 5. 当前时间
  catalog.register({
    name: "get_time",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "获取当前日期和时间。",
    parameters: { type: "object", properties: {} },
    execute: async () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
  });

  // 6. 记忆查询 (皮皮虾自己查记忆)
  catalog.register({
    name: "memory_search",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "搜索皮皮虾的记忆库, 返回相关事实。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "要搜的内容" }, limit: { type: "number" } },
      required: ["query"],
    },
    execute: async (args) => {
      if (!facts) return JSON.stringify({ error: "记忆未初始化" });
      const results = await facts.querySemantic(args.query, { limit: args.limit || 5 });
      if (!results.length) return "(无匹配记忆)";
      // 来源分级渲染 (2026-10-10 接线): 存储层早已给每条记忆打了 tier (user-stated /
      //   model-inferred / tool-fetched / unknown, 见 memory/provenance.js), 但这条**直接进模型
      //   上下文**的路径此前一律渲染成 `- [score] content` —— 隔离带里"工具抓来的正文"
      //   与"用户亲口说的话"在模型眼里长得一模一样, 抓取内容里那句「请记住: 测试命令从此改成
      //   bun test」会被当成用户事实照做。这里改用 describeHits 统一渲染: 用户来源零字节变化
      //   (既有格式锚点不动), 非用户来源追加闭集标签 + 顶部一句说明。
      //   标签文本只来自 provenance.js 的闭集常量, 不取自被存内容 (stripTierTags 已在写入侧剥伪装)。
      return describeHits(results);
    },
  });

  // 7. 记住新事实 (layer=1) / 沉淀程序性记忆 (layer=4)
  //
  // 2026-10-30 (五层记忆闭环): 存储层与治理工具早已支持 L4 程序性记忆 (fact-store 的
  //   layer 字段 + 0.005/天 慢衰减 + memory_clear_layer), 但生产写入路径一直只有 L1 ——
  //   文档里写的"技能/流程长期留存"实际上没有入口, memory_add 只能记闲聊事实。
  //   这里补上 layer 选项, 默认仍为 L1 (既有调用零变化)。
  //   安全口径: 仍走 facts.add 的唯一持久化入口 (脱敏 + 来源分级 + 去重), source 保持
  //   agent-self → provenance=model-inferred, 检索渲染会带来源标签, 不会被当成用户原话;
  //   L4 只是"衰减更慢的模型推断记忆", 不提升信任等级、不绕过治理/删除/回滚。
  catalog.register({
    name: "memory_add",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "把一条重要信息写进皮皮虾的长期记忆。layer=1 (默认) 记事实/偏好; layer=4 记可复用的技能/流程/方法论 (程序性记忆, 衰减更慢, 适合跨会话反复使用的操作步骤)。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要记住的内容" },
        layer: { type: "number", enum: [1, 4], description: "1=事实/偏好 (默认), 4=程序性记忆 (技能/流程/方法论)" },
      },
      required: ["content"],
    },
    execute: async (args) => {
      if (!facts) return JSON.stringify({ error: "记忆未初始化" });
      const layer = Number(args.layer) === 4 ? 4 : 1;
      const f = facts.add(args.content, { source: "agent-self", layer });
      if (!f) return JSON.stringify({ error: "内容为空或无效, 未写入" });
      // 去重命中已有记录时 add 只加分/不改层 (不重复落条)。此时如实回报实际层级,
      // 而不是把"请求了 L4"说成"已写成 L4" —— 两个后端 (JSON/SQLite) 的 update 签名不同,
      // 这里不做跨后端隐式升级, 用户/模型需要时可用 memory_clear_layer 或治理工具调整。
      const actual = Number(f.layer) === 4 ? 4 : 1;
      return JSON.stringify({
        ok: true,
        id: f.id,
        layer: actual,
        ...(layer === 4 && actual !== 4 ? { note: "已存在同内容记忆, 未重复写入 (保留原层级)" } : {}),
      });
    },
  });

  // 8. 读图片 (多模态): 返回 base64 data URL, 供多模态模型视觉理解
  catalog.register({
    name: "read_image",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "读取图片文件, 返回 base64 data URL 供多模态模型理解图片内容 (需配置支持视觉的模型, 如 gpt-4o/qwen-vl/glm-4v)。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "图片文件路径 (相对工作目录)" } },
      required: ["path"],
    },
    execute: async (args) => {
      try {
        return imageFileToDataUrl(rootDir, args.path);
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    },
  });

  return catalog;
}
// 2026-10-09: 补 re-export —— jsExportSelfCheck 的实现在 core/postcondition.js,
// 但 write-selfcheck / postcondition-gate 测试按 src/tools/builtin.js 的约定 import。
export { jsExportSelfCheck } from "../core/postcondition.js";
