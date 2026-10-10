// src/utils/config-file.js - config/ppx.json 共享读写 (唯一实现)
// 职责:
//   - configFilePath(root): 统一配置文件路径 (原来 providers/channels/settings 三处各写一份)
//   - readPpxConfig(root):  读整个 config JSON, 缺文件/损坏返回 fallback
//   - writeConfigAtomic:    备份 (保留最近 3 个 .bak) → 原子写 (.tmp + rename), 防中途崩溃损坏
// 收录自 src/config/{providers,channels,settings}.js 的逐字重复实现 (2026-09-18 重构),
// 以后改备份策略/写盘语义只动这一处。
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./store.js";
import { warn } from "./logger.js";

// 备份文件最多保留个数
const MAX_BACKUPS = 3;

export function configFilePath(root) {
  return path.join(root, "config", "ppx.json");
}

// 读取整个 config, 文件不存在或 JSON 损坏时返回 fallback
export function readPpxConfig(root, fallback = {}) {
  const p = configFilePath(root);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    warn("config/ppx.json 读取失败:", e.message);
    return fallback;
  }
}

// 写盘: 先备份 (最多保留最近 MAX_BACKUPS 个 .bak-时间戳), 再原子写 (.tmp + rename)
export function writeConfigAtomic(root, cfg) {
  const p = configFilePath(root);
  if (fs.existsSync(p)) {
    const bak = p + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
    try { fs.copyFileSync(p, bak); } catch (e) { warn("备份失败:", e.message); }
    try {
      const dir = path.dirname(p);
      const base = path.basename(p);
      const baks = fs.readdirSync(dir)
        .filter((f) => f.startsWith(base + ".bak-"))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }));
      baks.sort((a, b) => b.t - a.t);
      for (const old of baks.slice(MAX_BACKUPS)) {
        try { fs.unlinkSync(path.join(dir, old.f)); } catch {}
      }
    } catch {}
  }
  // 原子写: store.atomicWrite 带随机 .tmp 后缀 + Windows rename 重试 (EPERM/EEXIST 兜底)
  atomicWrite(p, JSON.stringify(cfg, null, 2));
}
