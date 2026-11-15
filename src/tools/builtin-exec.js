// src/tools/builtin-exec.js - 内置执行域工具 (2026-11-14 自 builtin.js 按域拆分, 自审唯一 large-module)
//
// 关注点: "一段命令/脚本怎么被安全地跑起来" —— run_command (shell seam + 三道启动闸门:
//   命令守卫/会话写盘脚本/会话包清单)、code_act (默认关, 脚本级 deny)、run_background/job
//   (长任务落 data/jobs 日志)。命令管道助手 (Windows tail/head 内置截取) 与同会话拒绝
//   记忆也属本域。文件域见 ./builtin-file.js; 记忆域见 ./builtin-memory.js。
//
// 模块级状态: deniedCommandMemo (同会话重复被拒命令短路, TTL 10min, 上限 500)。
// 跨域共享: findSessionWrittenScript/Manifest 读 builtin-paths.js 的会话写盘账本
//   (文件域 rememberSessionWrite 落账) —— 两域经由同一模块读写, 不经闭包。
import path from "node:path";
import { scrubPII } from "../utils/pii.js";
import { LocalShellProvider } from "../seam/shell.js";
import { checkCommand, DENY_HINT, normalizeCommand } from "./command-guard.js";
import { formatToolResultHeader, countLines } from "./seam.js";
import { findSessionWrittenScript, findSessionWrittenManifest } from "./builtin-paths.js";
import { runCodeAct } from "./code-act.js";
import { JobRegistry } from "./jobs.js";

// 默认 shell provider (未通过 seam 注入时的兜底, 供测试/独立工具目录使用)
const defaultShell = new LocalShellProvider();

// 2026-11-13 (评测 P1-5): Windows cmd.exe 没有 POSIX tail/head, 模型却常写
//   `npm test 2>&1 | tail -40` —— 命令本身成功, 尾管道报 "不是内部或外部命令"。
// 这里在 Windows 上把**末尾**的 tail/head 段剥掉, 用 JS 对输出截取; 其它平台保持原样。
export function splitOutputPipeline(cmd) {
  if (process.platform !== "win32") return { cmd, mode: null, n: 0 };
  const m = String(cmd || "").match(/^(.*)\|\s*(tail|head)\s+(?:-n\s*|-\s*)?(\d+)\s*$/is);
  if (!m || !m[1].trim()) return { cmd, mode: null, n: 0 };
  return { cmd: m[1].trim(), mode: m[2].toLowerCase(), n: Math.max(1, Math.min(Number(m[3]) || 10, 2000)) };
}
export function applyLinePipeline(text, mode, n) {
  if (!mode || !n) return text;
  const lines = String(text ?? "").split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return (mode === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n");
}

// 2026-11-13 (评测 P2-4): read_file/read_document 已拦受保护路径, 但 `cat data/http-token`
// 这类 shell 读取仍是旁路。命令层再收一道: 命令串提到凭证/审计锚点/密钥配置/job 日志即拒。
function mentionsProtectedPath(cmd) {
  const s = String(cmd || "").toLowerCase().replace(/\\/g, "/");
  if (/(^|[/\s"'=<>|&;])http-token(?=$|[\s"'<>|&;])/.test(s)) return "data/http-token";
  if (s.includes("audit-hmac-key")) return ".ppx/audit-hmac-key";
  if (/(^|[/\s"'=<>|&;])config\/ppx\.json(?=$|[\s"'<>|&;])/.test(s)) return "config/ppx.json";
  if (/\/jobs\/[^\s"'<>|&;]+\.log(?=$|[\s"'<>|&;])/.test(s)) return "data/jobs/*.log";
  return null;
}

// 同会话重复被拒命令短路: 模型在收到 "命中后不要重试" 后仍会改写/重发同一命令。
//   key = 会话 + 权限签名 + 规范化命令; 权限变更后签名变化, 不会误伤"用户已放行"的重试。
const deniedCommandMemo = new Map();
const DENIED_MEMO_TTL_MS = 10 * 60 * 1000;
function deniedCmdKey(cmd, ctx) {
  const agent = ctx && ctx.agent;
  const p = agent && agent.permissions;
  const sec = (agent && agent.config && agent.config.security) || {};
  const sk = ctx?.sessionKey || agent?._activeSessionKey || "default";
  const sig = `${p?.approvalMode || ""}|${p?.sandbox || ""}|${p?.networkAccess ? 1 : 0}|${sec.allow_all ? 1 : 0}|${sec.allow_inline_exec ? 1 : 0}`;
  return `${sk}|${sig}|${normalizeCommand(cmd)}`;
}
function rememberDeniedCommand(key) {
  if (!key) return;
  const now = Date.now();
  deniedCommandMemo.set(key, now);
  if (deniedCommandMemo.size > 500) {
    for (const [k, ts] of deniedCommandMemo) {
      if (now - ts > DENIED_MEMO_TTL_MS) deniedCommandMemo.delete(k);
    }
  }
}
function isRecentlyDenied(key) {
  const ts = deniedCommandMemo.get(key);
  if (!ts) return false;
  if (Date.now() - ts > DENIED_MEMO_TTL_MS) { deniedCommandMemo.delete(key); return false; }
  return true;
}

// 三道启动闸门共用 (run_command / run_background): 短路→受保护路径→命令守卫→会话脚本→包清单。
// 命中即拒并记入拒绝记忆 (同会话重复短路的 key 来源)。
function execGates(cmd, ctx, rootDir) {
  const memoKey = deniedCmdKey(cmd, ctx);
  if (isRecentlyDenied(memoKey)) {
    return "同一命令在本会话已被拒绝, 不再重复执行 (未绕过闸门)。请改变方案或让用户调整 security 配置。";
  }
  const protectedHit = mentionsProtectedPath(cmd);
  if (protectedHit) {
    rememberDeniedCommand(memoKey);
    return `受保护路径, 禁止通过命令读取: ${protectedHit} (审计锚点/凭证/含密钥配置)`;
  }
  const opts = (ctx && ctx.agent && ctx.agent.config && ctx.agent.config.security) || {};
  const guard = checkCommand(cmd, opts);
  if (!guard.ok) {
    rememberDeniedCommand(memoKey);
    return guard.reason + DENY_HINT;
  }
  // 2026-10-31 安全收紧: 守卫放行 `node app.js`, 但 app.js 若是本会话刚写出的,
  //   "write_file + node" 连招 = 绕过 argv0 白名单的任意代码执行。命中即拒 (需人工审批)。
  const scriptHit = findSessionWrittenScript(rootDir, cmd, ctx);
  if (scriptHit) {
    rememberDeniedCommand(memoKey);
    return `本会话由写工具新建/修改的脚本不允许直接执行 (需人工审批): ${scriptHit}` + DENY_HINT;
  }
  // 2026-11-08 安全收口: 本会话改过包清单后, npm 系命令同样拒 (scripts 植入 + install 连招)
  const manifestHit = findSessionWrittenManifest(cmd);
  if (manifestHit) {
    rememberDeniedCommand(memoKey);
    return `本会话修改过包清单 (${manifestHit}), npm 系命令暂缓执行以防 scripts 植入连招 (需人工审批)` + DENY_HINT;
  }
  return null;
}

export function registerExecTools(catalog, { rootDir, dataDir = null }) {
  // 4. 执行命令 (安全: 限制在允许目录, 超时)
  catalog.register({
    name: "run_command",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "system", destructive: true },
    description: "执行 shell 命令并返回输出。只能在工作目录内执行, 有超时。Windows 下末尾的 `| tail -N` / `| head -N` 由内置截取器处理。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        timeout_ms: { type: "number", description: "可选超时 (毫秒), 默认取 security.command_timeout_ms" },
      },
      required: ["command"],
    },
    execute: async (args, ctx) => {
      const rawCmd = String(args.command || "").trim();
      if (!rawCmd) return JSON.stringify({ error: "空命令" });
      const pipe = splitOutputPipeline(rawCmd);
      const cmd = pipe.cmd;
      const blocked = execGates(cmd, ctx, rootDir);
      if (blocked) return JSON.stringify({ error: blocked });
      // 通过 shell seam 调用 (可替换 provider: 本地/沙箱/Docker), 换 provider 即换执行环境
      const shell = (ctx?.agent?.ctx && ctx.agent.ctx.consume("shell")) || defaultShell;
      const opts = (ctx && ctx.agent && ctx.agent.config && ctx.agent.config.security) || {};
      const timeoutMs = Number(args.timeout_ms) || Number(opts.command_timeout_ms) || 30000;
      const maxBuffer = Number(opts.max_output_bytes) || 8 * 1024 * 1024;
      const t0 = Date.now();
      // 2026-11-14 (评测 P2-2): 透传 seam 的 abort signal —— 工具预算 (tool_timeout_ms) 到点
      //   时整棵进程树被终止, 不再出现"seam 已超时返回、命令还在后台跑"的泄漏
      //   (timeout_ms 参数允许配得比工具预算大, 此前两层预算互不知晓)。
      const r = await shell.exec(cmd, { cwd: rootDir, timeoutMs, maxBuffer, signal: ctx?.signal });
      const ms = Date.now() - t0;
      // 成功/失败都先过 Windows 尾管道截取 (失败输出同样需要 tail)
      const stdout = applyLinePipeline(r.stdout || "", pipe.mode, pipe.n);
      const stderr = r.stderr || "";
      const timedOut = !!(r && r.timedOut);
      const head = formatToolResultHeader({
        ms,
        lineCount: timedOut ? 0 : countLines(stdout + " " + stderr),
        timedOut,
        timedOutMs: timeoutMs,
        exitCode: r.code,
      });
      if (!r.ok && timedOut) return head + "\n[工具错误] run_command: 超时";
      // findstr 无匹配: Windows 返回 exit=1 但这是**有效的负结果**, 不是执行失败。
      //   直接报错会诱导模型重试/改写命令 (评测里 14 条无效调用来自这里)。
      if (!r.ok && /(^|\s)findstr(\s|$)/i.test(cmd) && r.code === 1 && !String(r.stdout || "").trim()) {
        return head + "\n(findstr 无匹配内容 — 这是正常结果, 不是命令故障)";
      }
      if (!r.ok) {
        const detail = [stderr, stdout].filter((s) => String(s || "").trim()).join("\n");
        return head + "\n[工具错误] run_command: " + (detail || "命令失败 (无输出)");
      }
      const out = stdout + (stderr ? "\n[stderr] " + stderr : "");
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
      // 2026-11-14: code_act 接入 shell seam —— shell_provider=docker 时脚本在容器内执行
      //   (临时脚本落 workspace 挂载内, 断网 + 资源上限), 与 run_command 同一执行环境;
      //   本地模式行为不变。回执头部带 [execEnv: docker 容器沙箱] 如实标注执行环境。
      const shellProv = (ctx?.agent?.ctx && ctx.agent.ctx.consume("shell")) || defaultShell;
      return await runCodeAct(rootDir, lang, code, sec.command_timeout_ms, shellProv, ctx?.signal);
    },
  });

  // 8. 长任务后台执行 (2026-11-13, 评测 P1-6)
  //   与 run_command 共用三道启动闸门 (命令守卫/会话脚本/包清单), 但立即返回 job id;
  //   输出落 dataDir/jobs/<id>.log, 用 job 工具读尾部。用于 npm test / 构建 / 冒烟等
  //   超过 30s 的任务, 避免模型反复超时重试并撞轮次上限。
  const jobs = new JobRegistry(dataDir || path.join(rootDir || process.cwd(), ".ppx"));
  catalog.register({
    name: "run_background",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "system", destructive: true },
    description: "启动一个后台长任务 (npm test/构建/冒烟等) 并立即返回 job id, 不阻塞当前轮次。启动前仍过命令守卫。用 job 工具查看 status/output/kill。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        timeout_ms: { type: "number", description: "后台超时 (默认 10 分钟, 上限 1 小时)" },
      },
      required: ["command"],
    },
    execute: async (args, ctx) => {
      const rawCmd = String(args.command || "").trim();
      if (!rawCmd) return JSON.stringify({ error: "空命令" });
      // 与 run_command 同口径: Windows 末尾 tail/head 不交给 cmd.exe (后台日志本身可全量读)
      const cmd = splitOutputPipeline(rawCmd).cmd;
      const blocked = execGates(cmd, ctx, rootDir);
      if (blocked) return JSON.stringify({ error: blocked });
      const r = jobs.start({ command: cmd, cwd: rootDir, timeoutMs: Number(args.timeout_ms) || undefined });
      return JSON.stringify({ ok: true, ...r, hint: "用 job(action=status|output) 查看进度与输出; 需要停止用 job(action=kill)" });
    },
  });
  catalog.register({
    name: "job",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "system" },
    description: "管理 run_background 启动的后台任务: status(状态+尾部输出) / output(按 offset 分页读日志) / list / kill。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "output", "list", "kill"], description: "默认 status" },
        id: { type: "string", description: "job id (action=list 时省略)" },
        offset: { type: "number", description: "output 起始字节偏移, 默认 0" },
        limit: { type: "number", description: "output 最大字节数, 默认 20000" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args.action || "status").toLowerCase();
      const id = String(args.id || "");
      if (action === "list") return JSON.stringify({ ok: true, jobs: jobs.list() });
      if (!id) return JSON.stringify({ error: "缺少 job id" });
      if (action === "status") {
        const s = jobs.status(id);
        return s ? JSON.stringify({ ok: true, ...s }) : JSON.stringify({ error: `job 不存在: ${id}` });
      }
      if (action === "output") {
        const o = jobs.output(id, { offset: args.offset, limit: args.limit });
        return o ? JSON.stringify({ ok: true, ...o }) : JSON.stringify({ error: `job 不存在: ${id}` });
      }
      if (action === "kill") {
        const ok = jobs.kill(id);
        return JSON.stringify({ ok, id, killed: ok });
      }
      return JSON.stringify({ error: `未知 action: ${action}` });
    },
  });
}
