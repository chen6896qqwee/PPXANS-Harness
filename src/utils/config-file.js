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
import { resolveDataDir } from "./datadir.js";

// 备份文件最多保留个数
const MAX_BACKUPS = 3;

// 配置文件位置:
//   源码仓库 / 桌面工作副本 (root 不含 node_modules) → <root>/config/ppx.json
//   npm 全局或本地安装 (root 在 node_modules 里)      → <dataDir>/config.json
// 后者是用户目录, npm 升级会整目录替换包内容, 配置必须放在包外面才不会丢。
export function configFilePath(root) {
  if (String(root).includes("node_modules")) return path.join(resolveDataDir(root), "config.json");
  return path.join(root, "config", "ppx.json");
}

// 旧位置: npm 安装下曾经写在包目录里的配置, 只读兼容 (升级后不存在也无妨)
export function legacyConfigFilePath(root) {
  return path.join(root, "config", "ppx.json");
}

// 读取整个 config: 新位置优先, 再回落旧位置; 都没有返回 fallback
export function readPpxConfig(root, fallback = {}) {
  for (const p of [configFilePath(root), legacyConfigFilePath(root)]) {
    if (!fs.existsSync(p)) continue;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      warn("config 读取失败:", e.message);
      return fallback;
    }
  }
  return fallback;
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
