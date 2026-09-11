// src/seam/shell.js - Shell 能力 seam (吸收 dsh Service|Provider|Consumer 三层)
// Service Definition: 命令执行能力, 接口 = exec(cmd, opts) -> Promise<{stdout, stderr, code, ok}>
//   - Service: "shell" 这个能力 (key = "shell")
//   - Provider: LocalShellProvider (本地 execFile, 默认) | 未来 SandboxShellProvider (Docker/MicroVM)
//   - Consumer: run_command / code_act 工具, 通过 ctx.consume("shell") 获取实现, 换 provider 即换执行环境
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// 信号死亡可读化 (吸收 Hermes: 裸退出码 -> 人类可读说明)
// 负码/信号(子进程语义)确定性描述; shell 的 128+signum 约定用"通常"措辞
const SIGNAL_NOTES = {
  SIGKILL: "通常内存耗尽(OOM)被内核强杀, 或显式 kill -9",
  SIGTERM: "正常终止请求(可能超时被强杀)",
  SIGSEGV: "段错误(访问非法内存)",
  SIGABRT: "abort 异常终止",
  SIGINT: "Ctrl+C 中断",
  SIGPIPE: "管道断裂(读取端提前关闭)",
  SIGBUS: "总线错误",
  SIGFPE: "浮点异常",
  SIGUSR1: "用户自定义信号 1",
  SIGQUIT: "键盘退出信号",
};
function signalNote(sig) {
  if (!sig) return "";
  const extra = SIGNAL_NOTES[sig] ? " — " + SIGNAL_NOTES[sig] : "";
  return ` (进程被信号 ${sig} 终止${extra})`;
}

// 默认本地 shell provider: 在本机 shell 直接执行命令
// 约定: 永不 throw, 错误编码进返回值 (code != 0 或 ok=false), 与 LLM 重试内核的"失败编码进结果"一致
export class LocalShellProvider {
  async exec(cmd, { cwd, timeoutMs = 30000, maxBuffer = 1024 * 1024, env = null } = {}) {
    const isWin = process.platform === "win32";
    try {
      const { stdout, stderr } = await execFileP(isWin ? "cmd.exe" : "/bin/sh", [isWin ? "/c" : "-c", cmd], {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        env: env || undefined,
        windowsHide: true,
      });
      return { stdout: stdout || "", stderr: stderr || "", code: 0, ok: true };
    } catch (e) {
      const sig = e && e.signal;
      return {
        stdout: "",
        stderr: String(e && e.message || e) + signalNote(sig),
        code: typeof e.code === "number" ? e.code : (sig ? -1 : 1),
        ok: false,
      };
    }
  }
}
