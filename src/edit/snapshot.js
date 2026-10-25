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
  // 2026-10-24 (R2): 失败不再静默吞 —— 逐文件收集, 返回 { ok, restored, failures }。
  //   "回滚失败还报回滚成功"比不回滚更危险 (调用方以为现场已恢复)。
  rollback(snap) {
    if (!snap || !snap.entries) return { ok: false, restored: 0, failures: [{ path: "?", error: "空快照" }] };
    let restored = 0;
    const failures = [];
    for (const [p, e] of snap.entries) {
      if (!e.existed) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
          restored++;
        } catch (err) {
          failures.push({ path: p, error: `删除新建文件失败: ${err?.message || err}` });
        }
      } else {
        try {
          const dir = path.dirname(p);
          fs.mkdirSync(dir, { recursive: true });
          const tmp =
            p + ".ppx-rollback-" + Math.random().toString(36).slice(2, 10);
          fs.writeFileSync(tmp, e.content, "utf8");
          fs.renameSync(tmp, p);
          restored++;
        } catch (err) {
          failures.push({ path: p, error: `恢复原内容失败: ${err?.message || err}` });
        }
      }
    }
    return { ok: failures.length === 0, restored, failures };
  },
};
