// src/tools/seam.js - 能力缝(Capability Seam)辅助层
// 参考 deepseek-harness 的 Capability Seam 三分法:
//   Service Definition(声明/元数据) / Service Provider(execute 实现) / Consumer(runWithPolicy 统一策略入口)
// 零依赖, 纯 Node 原生。保留皮皮虾原有错误语义, 追加超时门禁/禁用门禁/追踪回调。

export const TOOL_ERROR_PREFIX = "[工具错误]";

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
  if (meta.timeoutMs > 0) {
    timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, meta.timeoutMs);
  }
  try {
    // 兼容 execute(args) 与 execute(args, ctx) 两种签名
    const result = fn.length >= 2
      ? await fn(args, { ...ctx, signal: ctrl.signal })
      : await fn(args);
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
