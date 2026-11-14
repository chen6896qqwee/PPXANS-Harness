// src/verify/path-evidence.js — 证据类检查共用的路径包含判断 + 读盘上限
// 从 postcondition 拆出 (2026-11-03), 2026-11-12 随验证域整体迁出 core: 回合闸门与声称核对都要按工作区边界
// 解析路径, 再各自往后走 (字节检查 / 行数核对)。放在同一验证域里共享, 避免 claims ↔ postcondition
// 反向 import 成环。
import path from "node:path";

export const READ_MAX_BYTES = 2 * 1024 * 1024; // 检查里读文件的上限, 超大文件不读 (只 stat)

// 工作区包含判断 (与 builtin.safePath 同一不变量, 但不 import 它: 避免 tools↔core 环)
export const IS_WIN = process.platform === "win32";
export function cmpPath(p) {
  const s = String(p);
  return IS_WIN ? s.toLowerCase().replace(/[\\/]+/g, "/") : s;
}
export function isInside(child, parent) {
  const a = cmpPath(child);
  const b = cmpPath(parent);
  if (a === b) return true;
  return a.startsWith(b.endsWith("/") ? b : b + "/");
}
export function resolveInRoot(rootDir, p) {
  const abs = path.resolve(rootDir, String(p));
  if (!isInside(abs, path.resolve(rootDir))) return null; // 越界路径不检查 (工具层已拒绝)
  return abs;
}
