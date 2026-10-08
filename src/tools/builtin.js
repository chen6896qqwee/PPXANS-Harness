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
// 文件可信性的唯一实现在 src/core/postcondition.js (2026-10-05 回合后置条件闸门):
// 本模块只做"per-write 回执"这一处消费, 检查逻辑不在此重复。同一份 jsExportSelfCheck /
// jsSyntaxCheck 也被回合闸门复用 (回执带出的语法结论会被采信, 省一次子进程)。
// builtin → verify 单向依赖 (verify 不 import tools, 无环)。
import { jsExportSelfCheck, jsSyntaxCheck, JS_SELF_CHECK_EXT } from "../core/postcondition.js";
import { debug } from "../utils/logger.js";

export { jsExportSelfCheck };

const execFileP = promisify(execFile);

// 默认 shell provider (未通过 seam 注入时的兜底, 供测试/独立工具目录使用)
const defaultShell = new LocalShellProvider();

// 图片 MIME 表 (read_image + 多模态注入共用)
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

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
const IS_WIN = process.platform === "win32";

// 包含判断 (Windows 大小写不敏感): 同一目录既可写 C:\Dir 也可写 c:\dir,
// 大小写敏感的 startsWith 会把"工作区内的绝对路径"误判成越界 —— 2026-10-05 真跑基准里
// list_dir(path=<沙箱绝对路径>) 就是因此报 路径越界拒绝 (执行报错)。
// 放宽的只是"同一目录的两种拼写", 不是"能被访问的集合" (NTFS 本身大小写不敏感, 且 / 与 \
// 同源), 因此越界/符号链接两条安全不变量都不受影响。POSIX 上分隔符只有 /, 反斜杠是合法文件
// 名字符 —— 那里一律不折叠, 免得 "/work\\evil" 被折成 "/work/evil" 蒙过包含检查。
function cmpPath(p) {
  const s = String(p);
  return IS_WIN ? s.toLowerCase().replace(/[\\/]+/g, "/") : s;
}
function isInside(child, parent) {
  const a = cmpPath(child);
  const b = cmpPath(parent);
  if (a === b) return true;
  return a.startsWith(b.endsWith("/") ? b : b + "/");
}

export function safePath(root, p) {
  // 跨平台一致防护: Windows 盘符路径 (C:\... / C:/... / C:...) 在 Windows 宿主上
  // 会被 resolve 判为绝对路径而越界拒绝, 但在 POSIX 宿主上会被当作普通相对路径
  // 放行 (创建出名为 "C:\Windows" 的怪异文件)。POSIX 宿主上继续在入口拒绝, 保证安全
  // 不变量与宿主平台无关 (2026-10-01 修复: repo_map 测试在 Linux 失败暴露)。
  // Windows 宿主上不能再一刀切拒绝: 那是工作区内绝对路径的唯一合法写法 (见上)。
  if (typeof p === "string" && !IS_WIN && /^[a-zA-Z]:/.test(p)) {
    throw new Error(`路径越界拒绝: ${p}`);
  }
  const resolved = path.resolve(root, p);
  if (!isInside(resolved, root)) {
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
    if (!isInside(target, realRoot)) {
      throw new Error(`路径越界拒绝 (符号链接): ${p}`);
    }
  } catch (e) {
    if (e && e.message && e.message.includes("路径越界拒绝")) throw e;
    // root 不存在等边缘: 退回前缀检查 (已通过)
  }
  return resolved;
}

// ---- 写后自查 (2026-10-05, 真跑基准 write-function 复盘) ----
// 模型写进 .js 的内容根本没有 export, 却宣称"已写入并导出" —— 工具只回 ok:true,
// 字节层面的事实没人回执。write_file / apply_patch 的结果里追加一条**条件式**一行
// 自查: 仅在 .js/.mjs/.cjs、内容非空、且 export / module.exports / exports. 全无时
// 提示"无法被 import"。有导出 / 非 JS / 空内容一律不出现。只报告, 不门控:
// 写入的成功/失败语义完全不变。
// 实现 (jsExportSelfCheck / jsSyntaxCheck / JS_SELF_CHECK_EXT) 已上收到
// src/core/postcondition.js —— 回合后置条件闸门与写后回执共用同一份判定。

// ---- search_files 支撑 (2026-10-04): 目录遍历 / 文件名过滤 / 文本判定 ----
// 忽略目录与 repomap 同源 (VCS、依赖、构建产物、数据落盘目录不是检索目标)
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", ".tmp", "tmp", "data", ".workbuddy", "__pycache__"]);
const SEARCH_BIN_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".woff", ".woff2", ".ttf", ".mp3", ".mp4", ".exe", ".dll", ".so", ".node", ".db", ".sqlite"]);
const SEARCH_MAX_FILES = 4000;
const SEARCH_MAX_DEPTH = 14;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// glob -> 正则 (只支持 * / ? 通配, 覆盖 "*.js" 这类文件名过滤)
function globToRe(glob) {
  const body = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`(^|/)${body}$`, "i");
}

function isTextFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (SEARCH_BIN_EXT.has(ext)) return false;
  return true;
}

function walkFiles(root, globRe) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < SEARCH_MAX_FILES) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (out.length >= SEARCH_MAX_FILES) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth >= SEARCH_MAX_DEPTH || SEARCH_SKIP_DIRS.has(ent.name)) continue;
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;
      if (globRe && !globRe.test(full.split(path.sep).join("/"))) continue;
      out.push(full);
    }
  }
  return out;
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
    try { fs.rmSync(tmp, { force: true }); } catch (e) { debug(`[tools/builtin] 已忽略异常: ${e && e.message ? e.message : e}`); }
  }
}

// 读文件的行窗口切片 (纯函数, 便于单测): offset 从 1 开始// 返回 { text, from, to, total, truncated }
export function sliceLines(content, offset = 1, limit = 400) {
  const lines = String(content ?? "").split("\n");
  const total = lines.length;
  const from = Math.max(1, Number(offset) || 1);
  const take = Math.max(1, Math.min(Number(limit) || 400, 2000));
  const start = from - 1;
  if (start >= total) return { text: "", from, to: total, total, truncated: false, pastEnd: true };
  const picked = lines.slice(start, start + take);
  const to = start + picked.length;
  return { text: picked.join("\n"), from, to, total, truncated: to < total, pastEnd: false };
}

// 注册全部内置工具
export function registerBuiltinTools(catalog, { rootDir, facts, memory }) {
  // 1. 读文件
  catalog.register({
    name: "read_file",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "读取文件内容 (行窗口)。返回带行号范围的续读提示, 大文件用 offset 分批读完。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径 (相对工作目录)" },
        offset: { type: "number", description: "起始行号 (从 1 开始, 默认 1)" },
        limit: { type: "number", description: "读取行数 (默认 400, 上限 2000)" },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const p = safePath(rootDir, args.path);
      if (!fs.existsSync(p)) return JSON.stringify({ error: `文件不存在: ${args.path}` });
      if (fs.statSync(p).isDirectory()) return JSON.stringify({ error: `目标是目录: ${args.path}` });
      const content = fs.readFileSync(p, "utf8");
      // v1.0.9: 输出 PII 脱敏 (与 run_command/code_act 一致, 文件可能含密钥/手机号)
      const { text, from, to, total, truncated, pastEnd } = sliceLines(scrubPII(content).cleaned, args.offset, args.limit);
      if (pastEnd) return `[文件 ${args.path} 共 ${total} 行, offset=${from} 已超出末尾]`;
      // 续读提示: 缺这一条时模型只能靠 20k 字符截断盲猜还剩多少 (基线 find-symbol 任务因此反复重读)
      const head = `[${args.path} 第 ${from}-${to} 行 / 共 ${total} 行]`;
      return truncated ? `${head}\n${text}\n[未完: 继续读取请传 offset=${to + 1}]` : `${head}\n${text}`;
    },
  });

  // 1b. 全文检索 (2026-10-04 基线缺口: 无 grep 工具时, 定位一个符号只能 list_dir + 逐个 read_file,
  //     轮次与 token 双高 —— find-symbol/extract-field 两个基准任务就是因此超时的)
  catalog.register({
    name: "search_files",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "在工作目录内做全文/正则检索 (类似 grep -rn), 返回 文件:行号: 命中行。定位符号、找调用点、查配置键的首选, 比逐个 read_file 快得多。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜的文本或正则 (普通子串大小写不敏感)" },
        path: { type: "string", description: "搜索起点目录或单个文件, 默认工作目录" },
        regex: { type: "boolean", description: "query 按正则解析 (默认 false = 普通子串)" },
        glob: { type: "string", description: "文件名过滤, 如 \"*.js\" / \"*.md\" (默认不限)" },
        list_only: { type: "boolean", description: "true = 只列命中文件与命中数, 不返回命中行 (看分布用)" },
        max_results: { type: "number", description: "最多返回多少条命中 (默认 60, 上限 300)" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const query = String(args.query ?? "");
      if (!query) return JSON.stringify({ error: "query 不能为空" });
      let re;
      try {
        re = args.regex ? new RegExp(query, "i") : new RegExp(escapeRe(query), "i");
      } catch (e) {
        return JSON.stringify({ error: `正则无效: ${e.message}` });
      }
      const max = Math.max(1, Math.min(Number(args.max_results) || 60, 300));
      const root = safePath(rootDir, args.path || ".");
      const stat = fs.existsSync(root) ? fs.statSync(root) : null;
      if (!stat) return JSON.stringify({ error: `路径不存在: ${args.path || "."}` });
      const globRe = args.glob ? globToRe(String(args.glob)) : null;
      const files = stat.isDirectory() ? walkFiles(root, globRe) : [root];
      const hits = [];
      const byFile = new Map();
      let scanned = 0;
      for (const file of files) {
        if (hits.length >= max) break;
        if (!isTextFile(file)) continue;
        let content;
        try {
          if (fs.statSync(file).size > 2 * 1024 * 1024) continue; // 超大文件跳过 (不是文本检索对象)
          content = fs.readFileSync(file, "utf8");
        } catch { continue; }
        scanned++;
        if (!content) continue;
        const rel = path.relative(rootDir, file).split(path.sep).join("/");
        re.lastIndex = 0;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          byFile.set(rel, (byFile.get(rel) || 0) + 1);
          if (hits.length < max && !args.list_only) {
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
          if (hits.length >= max && args.list_only) break;
          re.lastIndex = 0;
        }
      }
      if (args.list_only) {
        if (!byFile.size) return `[无命中] query=${query} 已扫描 ${scanned} 个文件`;
        const rows = [...byFile.entries()].sort((a, b) => b[1] - a[1])
          .map(([f, n]) => `${n}  ${f}`);
        return `命中文件 ${rows.length} 个 (query=${query}, 已扫描 ${scanned} 文件):\n${rows.join("\n")}`;
      }
      if (!hits.length) return `[无命中] query=${query} 已扫描 ${scanned} 个文件 (跳过二进制/超 2MB/忽略目录)`;
      const more = byFile.size > new Set(hits.map((h) => h.split(":")[0])).size
        ? ` (仅前 ${hits.length} 条, 用 list_only=true 看完整分布)` : "";
      return `命中 ${hits.length} 条${more} (query=${query}):\n${hits.join("\n")}`;
    },
  });

  // 2. 写文件
  catalog.register({
    name: "write_file",
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "workspace" },
    description: "写入文件 (整体覆盖)。局部修改优先用 apply_patch 的 SEARCH/REPLACE 块, 不必重写全文。",
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
      // 覆盖前先量原文件: 整体重写最容易的事故是"只改两行却把文件写短了"
      const prevSize = fs.existsSync(p) ? fs.statSync(p).size : 0;
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
        const out = { ok: true, bytes: Buffer.byteLength(content) };
        if (prevSize && Buffer.byteLength(content) < prevSize) {
          out.note = `已覆盖 ${args.path}: 原 ${prevSize} 字节 → 现 ${Buffer.byteLength(content)} 字节 (变短 ${prevSize - Buffer.byteLength(content)} 字节)。若这是有意的整体重写可忽略; 若只想改局部, 下次用 apply_patch。`;
        }
        const sc = jsExportSelfCheck(p, content);
        if (sc) out.selfcheck = sc;
        if (JS_SELF_CHECK_EXT.has(path.extname(p).toLowerCase()) && content.trim()) {
          out.syntax = await jsSyntaxCheck(p);
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
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "workspace" },
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
        fs.appendFileSync(p, prefix + content, "utf8");
        return JSON.stringify({ ok: true, appended: Buffer.byteLength(content) });
      } catch (e) {
        return JSON.stringify({ error: `追加失败: ${e.message}` });
      }
    },
  });

  // 2c. 删除文件 (2026-10-02 基线暴露缺口: 无删除工具, agent 只能放弃或绕道)
  catalog.register({
    name: "delete_file",
    capability: { destructive: true, riskLevel: "high", readOnly: false, sideEffect: "workspace" },
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
        fs.unlinkSync(p);
        return JSON.stringify({ ok: true, deleted: args.path });
      } catch (e) {
        return JSON.stringify({ error: `删除失败: ${e.message}` });
      }
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
      // args 可能是 undefined/null (模型给空调用、provider 回传 "null"): 旧写法
      // args.path 直接 TypeError → [工具错误] → 基准轨迹里记成"执行报错 × list_dir"。
      const a = args && typeof args === "object" ? args : {};
      const shown = a.path || ".";
      let p;
      try {
        p = safePath(rootDir, shown);
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
      if (!fs.existsSync(p)) return JSON.stringify({ error: `目录不存在: ${shown} (先确认路径, 或用 path="." 列工作区根)` });
      if (!fs.statSync(p).isDirectory()) return JSON.stringify({ error: `目标是文件不是目录: ${shown} (读内容请用 read_file)` });
      const items = fs.readdirSync(p).map((f) => {
        const fp = path.join(p, f);
        let isDir = false;
        try { isDir = fs.statSync(fp).isDirectory(); } catch { /* 竞态删除/断链: 按文件列出的名字仍可用 */ }
        return `${isDir ? "[D]" : "[F]"} ${f}`;
      });
      // 空目录返回可读标记而非空串: 空结果与失败在模型侧无法区分 (会诱发原地重试)
      return items.length ? items.join("\n") : `(空目录: ${shown})`;
    },
  });

  // 4. 执行命令 (安全: 限制在允许目录, 超时)
  catalog.register({
    name: "run_command",
    capability: { destructive: true, riskLevel: "high", readOnly: false, sideEffect: "system" },
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
    // F1 (2026-10-05): 与 run_command 同类 —— 把模型写的脚本交给 python/node 子进程执行,
    // 落盘/联网完全可能 (execute 里只有 checkCommand 的 deny 黑名单兜底)。
    // 旧能力兜底把它报成 readOnly:true, 于是 plan 模式与「只读巡检」都能静默跑任意代码。
    // 定 high: 默认模式下也要人工确认 (与 run_command/delete_file 同口径);
    // 需要无人值守跑批的用户用 agent.auto_approve_high_risk=true 或 addRule allow 显式放权。
    capability: { riskLevel: "high", readOnly: false, destructive: false, sideEffect: "system" },
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
      const guard = checkCommand(code, { ...sec, allowAll: true, skipInlineExec: true });
      if (!guard.ok) return JSON.stringify({ error: guard.reason + DENY_HINT });
      return runCodeAct(rootDir, lang, code, sec.command_timeout_ms);
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
      const results = facts.query(args.query, { limit: args.limit || 5 });
      return results.length
        ? results.map((r) => `- [${r.score}] ${r.content}`).join("\n")
        : "(无匹配记忆)";
    },
  });

  // 7. 记住新事实
  catalog.register({
    name: "memory_add",
    capability: { riskLevel: "low", readOnly: false, destructive: false, sideEffect: "memory" },
    description: "把一条重要信息写进皮皮虾的长期记忆。",
    parameters: {
      type: "object",
      properties: { content: { type: "string", description: "要记住的内容" } },
      required: ["content"],
    },
    execute: async (args) => {
      if (!facts) return JSON.stringify({ error: "记忆未初始化" });
      const f = facts.add(args.content, { source: "agent-self" });
      return JSON.stringify({ ok: true, id: f.id });
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