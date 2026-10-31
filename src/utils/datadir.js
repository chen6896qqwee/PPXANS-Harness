// src/utils/datadir.js - 数据目录解析 (运行时与 `ppx doctor` 共用, 单处实现防止漂移)
// 规则: 显式参数 > PPX_DATA_DIR > 默认目录
// 默认目录: 安装在 node_modules 里时外置到 ~/.ppx (防卸载丢数据), 否则 <root>/data
import path from "node:path";
import os from "node:os";

export function defaultDataDir(root) {
  if (String(root).includes("node_modules")) return path.join(os.homedir(), ".ppx");
  return path.join(root, "data");
}

export function resolveDataDir(root, explicit = null) {
  return explicit || process.env.PPX_DATA_DIR || defaultDataDir(root);
}
