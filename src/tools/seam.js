// src/tools/seam.js - 能力缝(Capability Seam)辅助层
// 参考 deepseek-harness 的 Capability Seam 三分法:
//   Service Definition(声明/元数据) / Service Provider(execute 实现) / Consumer(runWithPolicy 统一策略入口)
// 零依赖, 纯 Node 原生。保留皮皮虾原有错误语义, 追加超时门禁/禁用门禁/追踪回调。

export const TOOL_ERROR_PREFIX = "[工具错误]";

// ---- B1: 工具结果标准化 (吸收 codex format_exec_output_for_model) ----
// 命令类工具返回统一元数据头, 模型不靠猜判断成败:
//   [exit=0 time=0.42s out=3行] <内容>
//   [exit=1 time=1.02s out=0行][stderr] <错误>
//   [exit=timeout time=30000ms] command timed out after 30000ms
// 纯函数, 可独立测试 (B1 验收点)。
// opts = { ms, lineCount, timedOut, exitCode, timedOutMs }
export function formatToolResultHeader({
  ms = 0,
  lineCount = 0,
  timedOut = false,
  exitCode = null,
  timedOutMs = 0,
} = {}) {
  if (timedOut) {
    return `[exit=timeout time=${ms}ms] command timed out after ${timedOutMs || ms}ms`;
  }
  const codeStr = exitCode === null ? "?" : String(exitCode);
  return `[exit=${codeStr} time=${(ms / 1000).toFixed(2)}s out=${lineCount}行]`;
}

// 计算文本行数 (B1 辅助): 去尾随空行, 纯空白算 0
// 修正: 尾部换行不应多计一行 (echo 输出 "abc\r\n" 应为 1 行)
export function countLines(text) {
  const s = String(text ?? "");
  const t = s.replace(/\r\n/g, "\n").replace(/\n\s*$/, "").trim();
  if (!t) return 0;
  return t.split("\n").length;
}

// power 权限级: user < agent < super
export const POWER_LEVEL = { user: 0, agent: 1, super: 2 };

// ---- Definition 层: 元数据归一化 + 校验 ----
export function normalizeMeta(def = {}) {
  if (!def || typeof def.name !== "string" || !def.name) {
    throw new Error("能力缝 Definition 失败: 需 name");
  }
  return {
    name: def.name,
    description: def.description || "",
    parameters: def.parameters || { type: "object", properties: {}, required: [] },
    // 能力缝新增元数据
    category: def.category || "misc",        // 能力域: file/net/system/memory/selfmod/...
    power: def.power || "user",              // 权限级: user/agent(0栓塞)
    timeoutMs: Number(def.timeoutMs) || 0,   // 0 = 不限时
    idempotent: !!def.idempotent,            // 是否可安全重试
    enabled: def.enabled !== false,          // 默认启用
    execute: def.execute,
    // 工具钩子链 (吸收 OpenClaw before/after 钩子):
    //  before(args, ctx) -> undefined 继续 | 字符串短路 | throw 拒绝
    //  after(args, result, ctx) -> 后处理(结果审计/清理), 错误不阻塞
    before: typeof def.before === "function" ? def.before : null,
    after: typeof def.after === "function" ? def.after : null,
  };
}

// ---- Consumer 层: 统一策略执行 ----
// 统一处理: 禁用门禁 / 实现缺失 / 超时门禁 / 标准错误语义 / 追踪回调
export async function runWithPolicy(meta, args, ctx = {}) {
  if (meta.enabled === false) {
    return `${TOOL_ERROR_PREFIX} ${meta.name}: 能力已禁用`;
  }
  // power 权限门禁: 仅当 ctx.power 明确提供时生效(向后兼容, 无 ctx.power 默认放行)
  if (ctx && ctx.power) {
    const need = POWER_LEVEL[meta.power] ?? 0;
    const have = POWER_LEVEL[ctx.power] ?? 0;
    if (have < need) {
      return `${TOOL_ERROR_PREFIX} ${meta.name}: 权限不足(需要 ${meta.power}, 当前 ${ctx.power})`;
    }
  }
  const fn = meta.execute;
  if (typeof fn !== "function") {
    return `${TOOL_ERROR_PREFIX} ${meta.name}: 无实现(Provider 缺失)`;
  }
  // before 钩子: 返回非 undefined 则短路(不执行), throw 则拒绝
  if (meta.before) {
    try {
      const shortCircuit = await meta.before(args, ctx);
      if (shortCircuit !== undefined && shortCircuit !== null) {
        return typeof shortCircuit === "string" ? shortCircuit : JSON.stringify(shortCircuit);
      }
    } catch (e) {
      return `${TOOL_ERROR_PREFIX} ${meta.name}: before 钩子拒绝: ${e.message}`;
    }
  }
  let timer = null;
  let timedOut = false;
  const ctrl = new AbortController();
  // 超时预算: 工具级声明优先 (meta.timeoutMs > 0), 否则全局默认 (ctx.timeoutMs, agent 从 config.agent.tool_timeout_ms 传入)
  // v1.6.0 (第四刀): 无声明工具不再永不超时 — 有保守全局默认兑底, 避免单个慢工具卡死整个对话
  const effectiveTimeout = meta.timeoutMs > 0 ? meta.timeoutMs : (Number(ctx.timeoutMs) || 0);
  if (effectiveTimeout > 0) {
    timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, effectiveTimeout);
  }
  try {
    // v1.6.0 (第四刀): 双层超时兜底 —
    //   1) signal 传给 execute: 配合的工具提前终止释放资源 (资源超时)
    //   2) Promise.race 强制超时返回: 不响应 signal 的工具也不至于永远挂住对话 (语义超时兜底)
    // 这是文档指出的灰色地带: 光靠 abort 信号, 不配合的工具会无限期挂着。
    const run = () => (fn.length >= 2 ? fn(args, { ...ctx, signal: ctrl.signal }) : fn(args));
    let result;
    if (effectiveTimeout > 0) {
      let raceTimer = null;
      const timeoutGuard = new Promise((_, reject) => {
        raceTimer = setTimeout(() => reject(Object.assign(new Error("timeout"), { timedOut: true })), effectiveTimeout);
      });
      const pRun = Promise.resolve().then(run);
      // 哨兵: 超时赢时工具方后到的 reject 忽略, 防 unhandledRejection 崩进程
      pRun.catch(() => {});
      try {
        result = await Promise.race([pRun, timeoutGuard]);
      } catch (e) {
        if (e && e.timedOut) timedOut = true;
        throw e;
      } finally {
        if (raceTimer) clearTimeout(raceTimer);
      }
    } else {
      result = await run();
    }
    if (timedOut) return `${TOOL_ERROR_PREFIX} ${meta.name}: 超时`;
    if (meta.after) {
      try { await meta.after(args, result, ctx); } catch { /* after 钩子错误不阻塞 */ }
    }
    if (typeof ctx.onResult === "function") ctx.onResult(meta.name, "ok", null);
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (e) {
    if (typeof ctx.onResult === "function") ctx.onResult(meta.name, "error", e.message);
    return `${TOOL_ERROR_PREFIX} ${meta.name}: ${timedOut ? "超时" : e.message}`;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 供 selfmod 工具 / 追踪用的纯净元数据(不含 execute 实现)
export function toDescriptor(meta) {
  return {
    name: meta.name,
    description: meta.description,
    parameters: meta.parameters,
    category: meta.category,
    power: meta.power,
    timeoutMs: meta.timeoutMs,
    idempotent: meta.idempotent,
    enabled: meta.enabled,
  };
}
