// src/ans/guard.js - 免疫系 (⑧安全治理) 全局闸门 (ANS)
// 在 P0 总线 intercept() 之上搭全局免疫: 任何经总线命令通道的动作执行前先过闸门。
// 能力 (务实, 不硬造):
//   1. 全局审计 - 所有放行/拒绝的命令记入 Auditor 账本 (可离线核实)
//   2. 危险 verb 阻断 - 白名单制: 未显式放行的"危险操作"(删除/清空/覆盖写) 默认拒绝
//   3. 单次审批授权 - 对越出白名单的关键操作可单次放行 (双模式授权)
// 说明: 总线 command 通道 (P0 建) + 免疫闸门 (本模块) 形成"执行前统一安全校验"。
//   现有工具走 catalog/seam (已有局部 runWithPolicy 权限)；本闸门覆盖"走总线命令"的敏感动作 (记忆写/删除等未来接线)。
// P0 (2026-09-15): 新增 installGuardOnCatalog —— 把同一闸门状态挂到 ToolCatalog 策略链,
//   解决 MERGE-REPORT 遗留 P2 (guard 空转: 工具走 catalog 不走总线)。危险判定作用于工具名。
// P0 修复 (2026-09-16): 原 DANGEROUS_RE 前缀匹配对真实工具名 (memory_import/clear_layer 等) 全部落空,
//   blocked 恒为 0 = "假绿灯"。新增: 显式危险工具集 + 参数级判定 (mode/hard/quarantine),
//   并统一判定函数供总线/catalog 两路径复用。审计写失败不再静默 (warn + writeFailures)。
import { hasPII } from "../utils/pii.js";
import { warn } from "../utils/logger.js";

// 危险 verb 前缀: 命中且未显式白名单放行 → 需单次审批或拒绝
const DANGEROUS_RE = /^(delete|remove|clear|wipe|drop|purge|truncate|overwrite)/i;

// 显式危险工具集 (名称级): 工具名不匹配前缀正则, 但本身是不可逆/大影响操作。
// 语义: 未白名单放行即拒绝 (fail-closed), 与 DANGEROUS_RE 前缀判定同权。
const DANGEROUS_TOOLS = new Set([
  "memory_export", // 导出全量记忆 (含软删/归档, 敏感数据外流), 需审批
]);

// 参数级危险判定: 同一工具不同参数风险不同 (可逆 vs 不可逆)。
// 返回 true = 本次调用属高危, 未白名单放行即拒绝。
function argsDangerous(name, args) {
  if (!args || typeof args !== "object") return false;
  if (name === "memory_import") return args.mode === "replace";      // 整体替换全部记忆, 不可逆
  if (name === "memory_clear_layer") return args.hard === true;      // 物理删除, 不可回滚
  if (name === "audit_verify") return args.quarantine === true;      // 隔离并重建审计链 (跳过损坏段)
  return false;
}

// 统一危险判定: 返回 { dangerous, reason }
// 覆盖: 1) 前缀正则 (总线命令/未来工具)  2) 显式危险工具集  3) 参数级判定
// 供 installGuard (总线) 与 installGuardOnCatalog (工具) 两路径复用, 保证口径一致。
export function dangerVerdict(verb, args = null) {
  if (DANGEROUS_RE.test(verb)) return { dangerous: true, reason: "dangerous-prefix" };
  if (DANGEROUS_TOOLS.has(verb)) return { dangerous: true, reason: "dangerous-tool" };
  if (argsDangerous(verb, args)) return { dangerous: true, reason: "dangerous-args" };
  return { dangerous: false, reason: null };
}

// 危险判定: verb 命中危险且未白名单放行 (向后兼容, 供外部调用)
export function isDangerous(verb, allowList = []) {
  return dangerVerdict(verb).dangerous && !allowList.includes(verb);
}

// 默认记审计账本的最大条目
const AUDIT_LIMIT = 200;

// 安装免疫闸门: 挂到 agent.bus.intercept(), 返回可观测状态
// opts.intercept: 是否实际拦截 (true=默认审计+危险阻断; false=仅审计不阻断, 用于灰度)
export function installGuard(agent, opts = {}) {
  if (!agent.bus || typeof agent.bus.intercept !== "function") {
    return { enabled: false, reason: "no-bus" };
  }
  const { intercept = true, allowList = [], ledgerLimit = AUDIT_LIMIT } = opts;
  const state = {
    enabled: true,
    intercept,
    allowList: [...allowList],
    checks: 0,
    blocked: 0,
    allowed: 0,
    wouldBlock: 0,     // 观测到危险但被白名单放行/灰度放行的次数 (闸门"在工作"的可见性)
    writeFailures: 0,  // 审计账本写失败次数 (不静默吞)
    audited: [],
    lastVerdict: null,
  };

  const record = (verdict, cmd, note) => {
    state.checks++;
    if (verdict === "block") state.blocked++;
    else if (verdict === "allow" || verdict === "approve") state.allowed++;
    state.audited.push({ verdict, verb: cmd.verb, id: cmd.id, ts: Date.now(), note, payloadHasPII: hasPII(JSON.stringify(cmd.payload || {})) });
    if (state.audited.length > ledgerLimit) state.audited = state.audited.slice(-ledgerLimit);
    // 写 Auditor 账本 (若装了); 写失败不静默吞, 计数 + warn (审计承诺不能被悄悄破坏)
    try {
      if (agent.auditor && typeof agent.auditor.record === "function") {
        agent.auditor.record("guard", { verdict, verb: cmd.verb, note });
      }
    } catch (e) {
      state.writeFailures++;
      warn(`[guard] 审计账本写入失败 (${cmd.verb}): ${e?.message || e}`);
    }
    state.lastVerdict = { verdict, verb: cmd.verb, note };
  };

  // 卸载钩子
  const off = agent.bus.intercept(async (cmd, next) => {
    const verb = String(cmd.verb || "");
    const { dangerous, reason } = dangerVerdict(verb, cmd.payload);
    const allowed = state.allowList.includes(verb);
    if (!dangerous || allowed) {
      if (dangerous && allowed) state.wouldBlock++; // 白名单放行的高危项仍计数, 让"闸门在观察"可见
      record("allow", cmd, dangerous ? "dangerous-whitelisted" : "normal");
    } else if (intercept) {
      record("block", cmd, reason || "dangerous-not-whitelisted");
      throw new Error("免疫闸门: 危险命令未授信而阻断: " + verb);
    } else {
      state.wouldBlock++;
      record("allow", cmd, "dangerous-observed-not-blocked");
    }
    await next();
  });

  // 单次审批授权: 放行一次危险 verb (一次用完自动失效)
  const approveOnce = (verb) => { state.allowList.push(verb); return () => removeAllow(verb); };
  const removeAllow = (verb) => { const i = state.allowList.indexOf(verb); if (i >= 0) state.allowList.splice(i, 1); };
  const status = () => ({ enabled: state.enabled, intercept: state.intercept, checks: state.checks, blocked: state.blocked, allowed: state.allowed, wouldBlock: state.wouldBlock, writeFailures: state.writeFailures, allowList: [...state.allowList], recent: state.audited.slice(-10) });

  return { off, approveOnce, status, _state: state };
}

// ---- P0: 免疫闸门接入工具执行收口 (ToolCatalog 策略链) ----
// 与 installGuard (总线版) 共享同一 state: allowList / 计数 / 审计记录全部复用,
// 所以 agent.approveGuard("delete/x") 一次授权同时作用于总线命令和工具调用。
// catalog.addPolicySubscriber 已保证: 策略订阅者异常不拖垮工具 (fail-open + 日志)。
export function installGuardOnCatalog(catalog, guardHandle) {
  if (!catalog || typeof catalog.addPolicySubscriber !== "function") {
    return { enabled: false, reason: "no-catalog" };
  }
  const state = guardHandle?._state;
  if (!state) return { enabled: false, reason: "no-guard-state" };
  const off = catalog.addPolicySubscriber(async (name, args, ctx) => {
    const verb = String(name || "");
    const { dangerous, reason } = dangerVerdict(verb, args);
    const allowed = state.allowList.includes(verb);
    if (!dangerous || allowed) {
      if (dangerous && allowed) state.wouldBlock++;
      state.checks++;
      state.allowed++;
      state.audited.push({ verdict: "allow", verb, ts: Date.now(), note: dangerous ? "dangerous-whitelisted" : "normal", payloadHasPII: hasPII(JSON.stringify(args || {})) });
      if (state.audited.length > AUDIT_LIMIT) state.audited = state.audited.slice(-AUDIT_LIMIT);
      return null; // 弃权 = allow (放行)
    }
    state.checks++;
    state.blocked++;
    state.audited.push({ verdict: "block", verb, ts: Date.now(), note: reason || "dangerous-not-whitelisted", payloadHasPII: hasPII(JSON.stringify(args || {})) });
    if (state.audited.length > AUDIT_LIMIT) state.audited = state.audited.slice(-AUDIT_LIMIT);
    if (typeof guardHandle.status === "function") {
      try {
        // 同步状态到 guard 的 lastVerdict (可观测)
        const st = guardHandle._state;
        st.lastVerdict = { verdict: "block", verb, note: reason || "dangerous-not-whitelisted" };
      } catch {}
    }
    return { decision: "deny", reason: "免疫闸门: 危险工具未授信: " + verb, priority: 100 };
  }, { name: "immune-guard", priority: 100 });
  return { enabled: true, off };
}

// 可观测摘要 (读已安装实例)
export function guardStatus(agent) {
  return agent.__guard ? agent.__guard.status() : { enabled: false };
}
