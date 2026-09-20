// src/edit/snapshot.js — 编辑快照与回滚
// 编辑前对目标文件做内存快照, 出错时整批回滚 (恢复修改 / 删除新建 / 重建目录)。
// 纯 Node、零依赖、ESM。

import fs from "node:fs";
import path from "node:path";

export const Snapshot = {
  // 读取给定路径的文件内容入内存
  // 返回 { id, entries: Map<path, {existed, content, mtime}> }
  begin(paths = []) {
    const entries = new Map();
    for (const p of paths) {
      let existed = false;
      let content = "";
      let mtime = 0;
      try {
        const stat = fs.statSync(p);
        if (stat.isFile()) {
          existed = true;
          content = fs.readFileSync(p, "utf8");
          mtime = stat.mtimeMs;
        }
      } catch {
        // 文件不存在或不可读 -> existed=false
      }
      entries.set(p, { existed, content, mtime });
    }
    const id =
      "snap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    return { id, entries, createdAt: Date.now() };
  },

  // 快照内文件清单
  list(snap) {
    if (!snap || !snap.entries) return [];
    return [...snap.entries.keys()];
  },

  // 把文件恢复到快照状态
  //  existed=false: 删除运行期间新建的文件
  //  existed=true : 确保目录存在, 先写临时文件再 rename 覆盖 (原子)
  rollback(snap) {
    if (!snap || !snap.entries) return false;
    for (const [p, e] of snap.entries) {
      if (!e.existed) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          /* 忽略删除失败 */
        }
      } else {
        try {
          const dir = path.dirname(p);
          fs.mkdirSync(dir, { recursive: true });
          const tmp =
            p + ".ppx-rollback-" + Math.random().toString(36).slice(2, 10);
          fs.writeFileSync(tmp, e.content, "utf8");
          fs.renameSync(tmp, p);
        } catch {
          /* 忽略恢复失败 */
        }
      }
    }
    return true;
  },
};
