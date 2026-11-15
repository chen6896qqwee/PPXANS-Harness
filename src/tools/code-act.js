// src/tools/code-act.js - code_act 沙箱执行 + glob 编译 (2026-11-03 从 builtin.js 拆出)
// code_act: 一次提交脚本批量操作, 压 N 轮工具往返 → 1 轮; 默认关闭 (security.code_act)。
// 沙箱加固 (进程级): 干净环境变量(剥离密钥/令牌) + node 内存上限 + 超时强杀进程树 + 输出上限。
// 2026-11-14: 接入 shell seam —— security.shell_provider="docker" 时脚本真正在容器内执行
//   (workspace 挂载内落临时脚本, 断网 + cap-drop ALL + 资源上限, 与 run_command 同一执行环境);
//   本地模式保持进程级约束不变。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubPII } from "../utils/pii.js";
import { formatToolResultHeader, countLines } from "./seam.js";

const execFileP = promisify(execFile);

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

export async function runCodeAct(rootDir, lang, code, timeoutMs, shell = null, signal = null) {
  const isWin = process.platform === "win32";
  const ext = lang === "node" ? "js" : "py";
  // docker 模式 (shell.kind === "docker"): 临时脚本必须写进挂载内 —— 容器只 bind-mount
  //   workspace, os.tmpdir() 里的脚本容器看不到。本地模式仍走系统临时目录 (不污染工作区)。
  const dockerMode = !!(shell && shell.kind === "docker");
  const tmpDir = dockerMode ? path.join(rootDir, ".ppx", "tmp") : os.tmpdir();
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `ppx_codeact_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`);
  fs.writeFileSync(tmp, code, "utf8");
  const budget = timeoutMs || 30000;
  const t0 = Date.now();
  try {
    let stdout = "", stderr = "", exitCode = 0, envNote = "";
    if (dockerMode) {
      // 容器内路径: host rootDir → 挂载点; 命令串只作为容器 /bin/sh -c 的单参数 (宿主 shell 不解析)
      const mount = String(shell.mount || "/workspace");
      const rel = path.relative(path.resolve(rootDir), tmp).split(path.sep).join("/");
      const scriptInBox = `${mount}/${rel}`;
      const memCap = lang === "node" ? `--max-old-space-size=${CODE_ACT_MEMORY_MB} ` : "";
      const cmdStr = `${lang === "node" ? "node" : "python3"} ${memCap}${JSON.stringify(scriptInBox)}`;
      const r = await shell.exec(cmdStr, { cwd: rootDir, timeoutMs: budget, maxBuffer: CODE_ACT_OUTPUT_MAX, signal });
      if (r && r.ok) {
        stdout = String(r.stdout || "");
        stderr = String(r.stderr || "");
        exitCode = typeof r.code === "number" ? r.code : 0;
        envNote = "[execEnv: docker 容器沙箱]";
      } else {
        const ms = Date.now() - t0;
        if (r && r.timedOut) return formatToolResultHeader({ ms, timedOut: true, timedOutMs: budget });
        const head = formatToolResultHeader({ ms, exitCode: typeof r?.code === "number" ? r.code : 1 });
        const detail = [r && r.stderr, r && r.stdout].filter((s) => String(s || "").trim()).join("\n");
        return head + "\n" + JSON.stringify({ error: detail || "容器内脚本执行失败 (无输出)", code: r?.code ?? 1 });
      }
    } else {
      const interpreter = lang === "node" ? process.execPath : (isWin ? "python" : "python3");
      // node 加内存上限; python 无等价零依赖参数 (docker 模式由容器 --memory 兜底)
      const args = lang === "node" ? [`--max-old-space-size=${CODE_ACT_MEMORY_MB}`, tmp] : [tmp];
      ({ stdout, stderr } = await execFileP(interpreter, args, {
        cwd: rootDir,
        timeout: budget,
        maxBuffer: CODE_ACT_OUTPUT_MAX,
        env: sandboxEnv(),
        windowsHide: true,
      }));
    }
    const ms = Date.now() - t0;
    const out = (stdout || "") + (stderr ? "\n[stderr] " + stderr : "");
    // B1: code_act 同样带统一元数据头 (成功即 exit=0); docker 模式如实标注执行环境
    const head = formatToolResultHeader({ ms, lineCount: countLines(out), exitCode });
    const body = scrubPII(out).cleaned.slice(0, 20000) || "(无输出)";
    return envNote ? `${head}\n${envNote}\n${body}` : `${head}\n${body}`;
  } catch (e) {
    const ms = Date.now() - t0;
    const timedOut = !!(e && (e.killed || /timed out|ETIMEDOUT/i.test(e.message)));
    const head = formatToolResultHeader({ ms, timedOut, timedOutMs: budget });
    // 超时/输出超限/内存超限的友好提示
    if (timedOut) return head;
    return head + "\n" + JSON.stringify({ error: e.message, code: e.code });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

// glob → 正则 (search_files 用): * 匹配同层非分隔字符, ** 跨目录, ? 单字符
// 路径统一按 / 分隔 (path.relative 结果已 normalize), 跨平台一致。
// 2026-11-04 实测修复 (P1): `**/` 必须匹配 0 个目录 —— 旧实现把 "src/tools/**/*.js"
//   译成 `src/tools/.*/[^/]*\.js`, 强制多一层目录, 于是 src/tools/builtin.js 这类
//   直接子文件永远匹配不到 (真实对话里模型搜索 src/tools/**/*.js 得到 "(无匹配文件)")。
//   标准 globstar 语义: `**/` → 零或多层, `**` (结尾) → 任意后缀。
export function globToRegex(pattern) {
  const re = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    // eslint-disable-next-line no-control-regex -- \u0000/\u0001 是 glob→regex 的占位哨兵 (先占后换), 非误用
    .replace(/\u0000/g, ".*")
    // eslint-disable-next-line no-control-regex -- 同上
    .replace(/\u0001/g, "(?:.*/)?");
  return new RegExp("^" + re + "$");
}
