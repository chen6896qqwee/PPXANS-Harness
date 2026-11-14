// src/utils/expand-home.js - ~ 路径展开单源
//
// 2026-11-03 重复消除: skills/loader.js 与 orchestrator/expert-pack.js 此前各持一份
// 逐字相同的实现 (skills 与 experts 两套目录体系互为镜像时抄出来的双份)。
// 展开 ~ 与 ~/ 前缀到用户主目录; 其余原样返回。
import os from "node:os";
import path from "node:path";

export function expandHome(p) {
  const s = String(p || "");
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}
