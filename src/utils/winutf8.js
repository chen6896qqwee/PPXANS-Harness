// src/utils/winutf8.js - Windows 控制台 UTF-8 引导：强制 chcp 65001 + stdout/stderr 用 utf8
// 根治 PowerShell/GBK 控制台把 Node UTF-8 输出解成乱码（鐨尰铏?/鑳藉姏... 那种）
import { execSync } from "node:child_process";

export function ensureUTF8Console() {
  if (process.platform !== "win32") return;
  try {
    // 改当前控制台活动代码页为 UTF-8（仅当是真实终端时；stdout 非 TTY 时跳过，避免写日志管道报错）
    if (process.stdout?.isTTY) {
      execSync("chcp 65001", { stdio: "ignore", windowsHide: true });
    }
  } catch { /* 非交互/无控制台，忽略 */ }
  try { process.stdout.setDefaultEncoding?.("utf8"); } catch {}
  try { process.stderr.setDefaultEncoding?.("utf8"); } catch {}
}
