// src/core/errors.js - 跨层共享的错误语义常量 (零依赖)
//
// 为什么要从 src/tools/seam.js 挪到这里 (2026-10-07 架构守卫发现):
//   TOOL_ERROR_PREFIX 定义原在 tools 层 (L3), 而 core(L1) 与 verify(L2) 都要用它 ——
//   于是出现了 `core → tools` 和 `verify → tools` 两条**反向**边, 并因此形成 3 个依赖环:
//     tools → verify → tools
//     core  → tools  → core
//     agent → core   → tools → orchestrator → agent
//   环的实质不是"谁引用了谁", 是**一个字符串常量被放错了层**: 它描述的是"工具错误的语义",
//   属于协议约定, 不是工具层的实现细节。
//
// 所以下沉到 core (L1): 低层定契约, 高层实现。seam.js 保留同名 re-export,
//   对外契约与 44 处既有引用**一字不改** —— 挪动实现, 不动接口。
export const TOOL_ERROR_PREFIX = "[工具错误]";
