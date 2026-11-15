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

// 工具结果是否代表失败 (成功/失败/策略拒绝的唯一判据)。
// 2026-11-13 (评测 P1-1): 旧判据只看 startsWith(prefix), 但 run_command 的失败结果
//   形如 "[exit=1 ...]\n[工具错误] ..." —— 元数据头在第一位, 前缀永远匹配不到, 于是
//   执行失败被记成 ok=true, 朴素成功率虚高约 21 个百分点。这里统一覆盖三种形态:
//   1) 直接以 [工具错误] 开头 (策略拦截/参数错误)
//   2) 元数据头之后紧跟 [工具错误] (run_command 执行失败/超时)
//   3) 顶层 {"error":"..."} JSON (文件工具/网络工具的业务失败)
// 只扫前三行, 避免把文件正文里引用的 "[工具错误]" 字样误判成失败。
export function isToolErrorResult(result) {
  let s = "";
  try { s = typeof result === "string" ? result : String(result ?? ""); } catch { return false; }
  if (!s) return false;
  if (s.startsWith(TOOL_ERROR_PREFIX)) return true;
  const firstLines = s.split("\n", 3).join("\n");
  if (firstLines.includes(TOOL_ERROR_PREFIX)) return true;
  const t = s.trimStart();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      if (j && typeof j === "object" && !Array.isArray(j)
        && j.error != null && String(j.error).trim()) return true;
    } catch { /* 非完整 JSON: 不按结构化错误处理 */ }
  }
  return false;
}
