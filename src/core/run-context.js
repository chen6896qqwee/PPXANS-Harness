// src/core/run-context.js - 单一 Run 账本契约 (架构优化 ①②, 2026-11-13)
//
// 问题 (审计结论): 一次用户轮会分叉出 trace 事件流 / 审计哈希链 / 工单账本 / 委派 worker /
//   军团并发 / 话题驻派 六个记录面, 各自生成自己的 id。想回答"这次任务为什么失败", 只能靠
//   时间戳猜关联 —— 多智能体一开, 账就串不起来。
//
// 契约: runId 只有**一个来源** —— 当前 trace 上下文的 traceId (见 src/core/trace.js, 已是
//   AsyncLocalStorage 贯穿)。本模块不重复造 id, 只负责:
//   1. currentRun(): 把 trace 上下文投影成 run 视图 (runId / parentRunId / kind / sessionKey);
//   2. childRunMeta(): 子 agent / 子任务派生时写入 trace meta, 带上 parentRunId;
//   3. runEnvForChild(): 跨进程委派 (legion worker) 用环境变量把血缘带过去 —— 子进程没有
//      父进程的 ALS, 只能走 env; 键名固定, 两个方向都从这里取, 不各写一份字面量;
//   4. setRunSink(): 观测出口由调用方注入 (agent 装配时接 tracer/EQ), core 不认识 bus。
//
// 设计约束: 零运行时依赖; core 层不得 import 上层模块 (arch-guard); 无 trace 上下文时全部
//   返回 null / {} —— 独立脚本直接调用工具不该被迫造一个假 run。
import { currentTrace } from "./trace.js";

// 子进程继承父 run 的环境变量键 (跨进程血缘唯一通道)
export const RUN_ENV_PARENT = "PPX_PARENT_RUN_ID";
export const RUN_ENV_KIND = "PPX_RUN_KIND";

let sink = null;

// 观测出口: fn(type, payload) —— type 形如 "run/child"。异常一律吞掉 (观测不得阻断执行)。
export function setRunSink(fn) {
  sink = typeof fn === "function" ? fn : null;
  return sink;
}

function safeEmit(type, payload) {
  if (!sink) return;
  try { sink(type, payload); } catch { /* 观测失败不阻断主链 */ }
}

// 当前 run 视图。无 trace 上下文时回退到跨进程 env (worker 进程刚启动的那几毫秒还在父轮里)。
export function currentRun() {
  const t = currentTrace();
  if (t) {
    return {
      runId: t.traceId,
      parentRunId: t.parentRunId || process.env[RUN_ENV_PARENT] || null,
      kind: t.runKind || "turn",
      sessionKey: t.sessionKey ?? null,
      channel: t.channel ?? null,
    };
  }
  const inherited = process.env[RUN_ENV_PARENT];
  if (inherited) {
    return { runId: null, parentRunId: inherited, kind: process.env[RUN_ENV_KIND] || "worker", sessionKey: null, channel: null };
  }
  return null;
}

// 记录面 (审计/工单/工具轨迹) 统一用这个取 runId, 不要各自读 trace。
export function currentRunId() {
  return currentRun()?.runId || null;
}

// 子任务派生: 交给 runWithTrace 的 meta, 让子 trace 自动带血缘。
//   runWithTrace(fn, childRunMeta("spawn", "worker-1"))
export function childRunMeta(kind = "child", label = null) {
  const parent = currentRun();
  const meta = { runKind: kind };
  if (label) meta.runLabel = label;
  if (parent?.runId) meta.parentRunId = parent.runId;
  return meta;
}

// 跨进程委派: 环境变量形式 (legion spawn / 子进程 worker)。返回可直接 Object.assign 的对象。
export function runEnvForChild(kind = "worker") {
  const parent = currentRun();
  const env = { [RUN_ENV_KIND]: kind };
  if (parent?.runId) env[RUN_ENV_PARENT] = parent.runId;
  return env;
}

// 派生子 run 的显式宣告 (供委派/军团工具在真正 spawn 前后调用)。
// 返回 child run 的 runId (由 trace 生成) 与父 id; 无父上下文时 parentRunId = null。
export function announceChildRun({ kind = "child", label = null, meta = {} } = {}) {
  const parent = currentRun();
  const payload = {
    kind,
    label,
    parentRunId: parent?.runId || null,
    sessionKey: parent?.sessionKey || null,
    at: Date.now(),
    ...meta,
  };
  safeEmit("run/child", payload);
  return payload;
}

// 一条 run 的血缘链 (由调用方提供 edge 列表; 纯函数, 便于测试与面板渲染)。
// edges: [{runId, parentRunId}] —— 返回 root → 目标 的 runId 数组, 断链时返回已解析前缀。
export function runLineage(runId, edges = []) {
  const parentOf = new Map();
  for (const e of edges || []) {
    if (e && e.runId) parentOf.set(String(e.runId), e.parentRunId ? String(e.parentRunId) : null);
  }
  const chain = [];
  const seen = new Set();
  let cur = runId ? String(runId) : null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(cur);
    cur = parentOf.get(cur) || null;
  }
  return chain;
}
