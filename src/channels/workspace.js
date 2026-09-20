// src/channels/workspace.js - 工作区文件树/文件读取 (从 channels/http.js 抽出, 2026-09-18 重构)
// 职责单一: 给定工作区根目录, 产出「带深度上限与越界防护」的目录树 / 文件内容。
// 供 HTTP 通道的 /api/workspace/tree 与 /api/workspace/read 使用; 无状态纯函数, 便于单测。
import fs from "node:fs";
import path from "node:path";

// 目录树默认跳过项 (重目录/产物/数据)
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", ".cache", ".tmp", "data"]);
const MAX_NODES = 2000;      // 树节点上限 (防超大仓库拖垮响应)
const MAX_READ = 256 * 1024; // 单文件读取上限 256KB

// 解析并校验「工作区内的相对路径」, 越界抛错。返回绝对路径。
// 2026-09-18 修复 (P2): 原实现只做字符串前缀判断, 工作区内指向外部的 symlink 可越界读。
//   现补 realpath 校验 (与 tools/builtin.js 的 safePath 同一策略): 存在的路径解析真实路径,
//   不存在的路径用最近已存在祖先目录的真实路径 + 剩余部分。
export function resolveInside(wsRoot, rel) {
  const rootAbs = path.resolve(wsRoot);
  const cleaned = String(rel || "").replace(/^\/+|\/+$/g, "");
  const abs = cleaned ? path.resolve(rootAbs, cleaned) : rootAbs;
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error("路径越界");
  try {
    const realRoot = fs.realpathSync(rootAbs);
    let target = abs;
    if (fs.existsSync(target)) {
      target = fs.realpathSync(target);
    } else {
      let dir = path.dirname(target);
      while (dir !== rootAbs && dir !== path.dirname(dir) && !fs.existsSync(dir)) dir = path.dirname(dir);
      target = path.join(fs.realpathSync(fs.existsSync(dir) ? dir : rootAbs), path.relative(dir, target));
    }
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
      throw new Error("路径越界 (符号链接)");
    }
  } catch (e) {
    if (e && e.message && e.message.includes("路径越界")) throw e;
    // root 不存在等边缘: 退回前缀检查 (已通过)
  }
  return abs;
}

// 构建目录树。返回 { tree, truncated }。maxDepth 1~8。
export function buildTree(wsRoot, { root: rootArg = "", maxDepth = 3 } = {}) {
  const wsRootAbs = path.resolve(wsRoot);
  const depth = Math.min(Math.max(Number(maxDepth) || 3, 1), 8);
  const baseDir = resolveInside(wsRootAbs, rootArg);
  let count = 0;

  const walk = (dir, rel, d) => {
    if (count >= MAX_NODES) return null;
    let st;
    try { st = fs.statSync(dir, { throwIfNoEntry: false }); } catch { return null; }
    if (!st) return null;
    const node = { name: path.basename(dir) || "/", path: rel, type: "dir", children: [] };
    if (d >= depth) return node;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return node; }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const ent of entries) {
      if (count >= MAX_NODES) break;
      const childRel = rel ? rel + "/" + ent.name : ent.name;
      const childPath = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
          count++;
          const child = walk(childPath, childRel, d + 1);
          if (child) node.children.push(child);
        } else if (ent.isFile()) {
          if (ent.name.startsWith(".")) continue;
          node.children.push({ name: ent.name, path: childRel, type: "file", size: fs.statSync(childPath).size });
          count++;
        }
      } catch { /* 单个节点失败忽略, 不影响整体树 */ }
    }
    return node;
  };

  const tree = walk(baseDir, String(rootArg || "").replace(/^\/+|\/+$/g, ""), 0);
  return { tree, truncated: count >= MAX_NODES, maxDepth: depth, baseDir };
}

// 读取工作区内单个文件 (超限截断)。返回 { path, size, truncated, content }
export function readWorkspaceFile(wsRoot, rel) {
  const file = resolveInside(wsRoot, rel);
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st || !st.isFile()) throw new Error("文件不存在");
  let buf = fs.readFileSync(file);
  const truncated = buf.length > MAX_READ;
  if (truncated) buf = buf.subarray(0, MAX_READ);
  return { path: String(rel || ""), size: st.size, truncated, content: buf.toString("utf8") };
}
