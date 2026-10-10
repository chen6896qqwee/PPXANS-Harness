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
// 来源分级渲染 (memory_search / 记忆检索路径): 让"工具抓来的正文"带隔离标签进模型上下文
import { describeHits } from "../memory/provenance.js";

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
    .replace(/\u0000/g, ".*");
  return new RegExp("^" + re + "$");
}

// 注册全部内置工具
export function registerBuiltinTools(catalog, { rootDir, facts, memory }) {
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
        fs.writeFileSync(p, content, "utf8");
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

  // 7. 记住新事实
  catalog.register({
    name: "memory_add",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
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
// 2026-10-09: 补 re-export —— jsExportSelfCheck 的实现在 core/postcondition.js,
// 但 write-selfcheck / postcondition-gate 测试按 src/tools/builtin.js 的约定 import。
export { jsExportSelfCheck } from "../core/postcondition.js";
