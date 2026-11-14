// src/tools/custom.js - 用户自定义工具注册
// 目标: 用户不改源码即可扩展 agent 能力。
// 扫描 <customDir>/*.cjs (或 .js), 每个文件导出工具定义 { name, description, parameters, execute },
// 用 ToolCatalog.register 注册, 与内置工具同权 (可被 LLM 调用、可 enable/disable)。
// 示例 (custom-tools/hello.cjs):
//   module.exports = {
//     name: "hello",
//     description: "返回问候语。",
//     parameters: { type: "object", properties: { name: { type: "string" } }, required: [] },
//     execute: async (args) => `你好, ${args.name || "世界"}!`,
//   };
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { info, warn } from "../utils/logger.js";

function isToolDef(v) {
  return v && typeof v === "object" && typeof v.name === "string" && v.name && typeof v.execute === "function";
}

// 同步注册 (构造函数内可用): 用 createRequire 加载 CommonJS 工具文件
export function registerCustomTools(catalog, customDir) {
  if (!customDir || !fs.existsSync(customDir)) return 0;
  const require = createRequire(import.meta.url);
  let files = [];
  try { files = fs.readdirSync(customDir); } catch { return 0; }
  const candidates = files.filter((f) => f.endsWith(".cjs") || f.endsWith(".js")).sort();

  let count = 0;
  for (const f of candidates) {
    const full = path.join(customDir, f);
    try {
      const mod = require(full);
      const def = mod && mod.default ? mod.default : mod;
      if (!isToolDef(def)) {
        warn(`[custom-tools] ${f} 需导出 { name, description, parameters, execute }, 跳过`);
        continue;
      }
      catalog.register(def);
      count += 1;
    } catch (e) {
      warn(`[custom-tools] 加载 ${f} 失败: ${e.message}`);
    }
  }
  if (count) info(`[custom-tools] 已注册 ${count} 个自定义工具`);
  return count;
}
