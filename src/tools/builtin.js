// src/tools/builtin.js - 内置工具集 (皮皮虾的手脚) · 装配外壳
// 全部零依赖, 用 Node 原生。
// 2026-11-03 拆分 (原 718 行超 600 阈值): 路径安全检查 → builtin-paths.js, code_act/glob → code-act.js;
//   本文件只保留工具注册; 被拆走的导出在此 re-export, 既有 import 路径不变。
// 2026-11-14 二次拆分 (自审唯一 large-module, 666 行): 按失效域再分 ——
//   文件域 (读/写/追加/删/移/撤销/列目录/搜索/读图 + 锚点编辑) → ./builtin-file.js,
//   执行域 (run_command/code_act/run_background/job + 命令管道助手/拒绝记忆) → ./builtin-exec.js。
//   本文件只剩装配 + get_time + 对外 re-export (既有 import 路径全部不变)。
import { registerFileTools } from "./builtin-file.js";
import { registerExecTools, splitOutputPipeline, applyLinePipeline } from "./builtin-exec.js";
import { registerMemoryTools } from "./builtin-memory.js";

export { sessionWrittenFiles, rememberSessionWrite, imageFileToDataUrl, safePath, sensitiveWriteHint, isNpmManifestPath } from "./builtin-paths.js";
export { runCodeAct, globToRegex } from "./code-act.js";
// 管道助手随执行域迁至 builtin-exec.js, 此处 re-export (test/pipeline 截取器直测的导入点)
export { splitOutputPipeline, applyLinePipeline };

// 注册全部内置工具
export function registerBuiltinTools(catalog, { rootDir, facts, memory, dataDir = null }) {
  // 文件域: 读/写/追加/删/移/撤销/列目录/搜索/读图 (撤销栈为域内闭包, 跨盘/快照回退)
  registerFileTools(catalog, { rootDir });
  // 执行域: run_command/code_act/run_background/job (三道启动闸门 + 命令管道 + 拒绝记忆)
  registerExecTools(catalog, { rootDir, dataDir });

  // 5. 当前时间
  catalog.register({
    name: "get_time",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "获取当前日期和时间。",
    parameters: { type: "object", properties: {} },
    execute: async () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
  });

  // 6-7. 记忆工具 (memory_search / memory_add): 见 ./builtin-memory.js
  registerMemoryTools(catalog, { facts });

  return catalog;
}
// 2026-10-09: 补 re-export —— jsExportSelfCheck 的实现在 verify/postcondition.js,
// 但 write-selfcheck / postcondition-gate 测试按 src/tools/builtin.js 的约定 import。
export { jsExportSelfCheck } from "../verify/postcondition.js";
