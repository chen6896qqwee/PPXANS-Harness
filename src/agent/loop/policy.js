// src/agent/loop/policy.js - 工具循环策略门面 (2026-11-03 拆分)
// 原 682 行单文件超过 600 行巨石阈值, 按文件头一直强调的「策略与执行分离」拆成两块:
//   loop/tool-loop-policy.js  阈值 / ToolLoopPolicy 状态机 / 结果裁剪 / 溢出判定 / 超时重试 / 参数解析
//   loop/tool-loop.js         循环主驱动 runToolLoop + 轮次耗尽收口
// 本文件只做 re-export: `from "../agent/loop/policy.js"` 的 import 路径与导出名全部不变。
export * from "./tool-loop-policy.js";
export * from "./tool-loop.js";
