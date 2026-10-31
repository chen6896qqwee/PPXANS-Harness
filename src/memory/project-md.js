// src/memory/project-md.js - 项目指令文件 (AGENTS.md / PPX.md) 发现与加载
// 2026-10-31: 修复"文档与 /init 自创建起就声称 PPX.md 每次启动自动读取, 注入实现从未存在"
//   的缺口 (ARCHITECTURE-V3.md 规划过 project-md 四级记忆, 本模块先落地项目根一级)。
// 同时支持 AGENTS.md —— codex / cursor 等生态的项目指令标准文件, 直接复用无需迁移。
//
// 设计契约 (与 prompts.js 前缀缓存纪律对齐):
//   - 文件未变时 mtime+size 缓存逐字节返回同一串 ⇒ system 静态区稳定, provider 前缀缓存不退化;
//   - 文件变更才会重读并作废从本段起的前缀 (段位由 prompts.js 放在静态区末段, 失效半径最小);
//   - 不存在/不可读/空文件 → 返回 "", 零 token, 绝不阻断主链路。

import fs from "node:fs";
import path from "node:path";

// 支持的项目指令文件 (全部存在时都注入; AGENTS.md 在前 —— 生态标准优先展示)
export const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "PPX.md"];

// 单文件字符预算: 防巨型 README 式文件挤爆 system 预算 (约 3k token / 文件)
const DEFAULT_MAX_CHARS = 6000;

// absPath -> { mtimeMs, size, text }
const _cache = new Map();

function readWithCache(absPath, st) {
  const hit = _cache.get(absPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
  const text = fs.readFileSync(absPath, "utf8").replace(/\r\n/g, "\n").trim();
  _cache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, text });
  return text;
}

// 读取项目指令, 返回注入文本 (无任何文件时为 "")
export function loadProjectInstructions(root, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  let base;
  try { base = path.resolve(String(root || ".")); } catch { return ""; }
  const found = [];
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const p = path.join(base, name);
    let text;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      text = readWithCache(p, st);
    } catch { continue; } // 不存在/不可读 → 跳过 (静默, 零 token)
    if (!text) continue;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars).trimEnd() + `\n…[${name} 超出 ${maxChars} 字符预算已截断]`;
    }
    found.push({ name, text });
  }
  if (!found.length) return "";
  const names = found.map((x) => x.name).join(" / ");
  const body = found.map((x) => `<${x.name}>\n${x.text}\n</${x.name}>`).join("\n\n");
  return `【项目指令】(来自 ${names}) — 以下是本项目的约定, 优先于一般偏好; 与核心价值底线冲突时以核心价值为准:\n\n${body}`;
}

// 仅供测试: 清空 mtime 缓存
export function _clearProjectMdCache() {
  _cache.clear();
}
