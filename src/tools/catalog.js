// src/tools/catalog.js - 工具注册表 (参考 openhanako tool-catalog + deepseek Capability Seam)
// 升级: 能力缝三分法(Definition元数据/Provider实现/Consumer策略) + 热挂载(enable/disable/unregister) + 元数据枚举
import { info } from "../utils/logger.js";
import { normalizeMeta, runWithPolicy, toDescriptor, TOOL_ERROR_PREFIX } from "./seam.js";

export { TOOL_ERROR_PREFIX };

export class ToolCatalog {
  constructor() {
    this.tools = new Map(); // name -> meta (Definition + Provider)
  }

  // ---- Definition + Provider 注册 ----
  register(def) {
    if (!def || typeof def.execute !== "function") {
      throw new Error(`工具注册失败: 需 name + execute (got ${def && def.name})`);
    }
    const meta = normalizeMeta(def); // 关键: execute 缺失由 normalizeMeta 的 name 校验兜底
    this.tools.set(meta.name, meta);
    info(`能力已注册: ${meta.name} [${meta.category}/${meta.power}]`);
    return this;
  }

  // ---- 热挂载: 卸载 ----
  unregister(name) {
    const had = this.tools.delete(name);
    if (had) info(`能力已卸载: ${name}`);
    return had;
  }

  // ---- 热挂载: 启用/禁用 ----
  enable(name) {
    const t = this.tools.get(name);
    if (!t) return false;
    t.enabled = true;
    return true;
  }

  disable(name) {
    const t = this.tools.get(name);
    if (!t) return false;
    t.enabled = false;
    return true;
  }

  // ---- OpenAI 兼容的 tools 格式 (给 LLM 用, 只含启用项) ----
  toOpenAI() {
    return [...this.tools.values()]
      .filter((t) => t.enabled)
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
  }

  // ---- 审计: 可选注入审计哈希链 (未注入时零开销, 保持向后兼容) ----
  // 吸收自 ppx-v2: 每次工具调用落一条 append-only + SHA-256 链式记录, 防审计日志被悄悄改写
  setAudit(auditLog) {
    this.audit = auditLog || null;
    return this;
  }

  // ---- Consumer: 统一策略执行 ----
  async call(name, args, ctx = {}) {
    const meta = this.tools.get(name);
    if (!meta) {
      return `${TOOL_ERROR_PREFIX} 未知工具: ${name}`;
    }
    info(`tool: ${name}(${JSON.stringify(args)})`);
    if (!this.audit) return runWithPolicy(meta, args, ctx);
    const t0 = Date.now();
    try {
      const r = await runWithPolicy(meta, args, ctx);
      const failed = typeof r === "string" && r.startsWith(TOOL_ERROR_PREFIX);
      this.audit.append({ tool: name, args, ok: !failed, error: failed ? String(r).slice(0, 200) : null, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      this.audit.append({ tool: name, args, ok: false, error: e?.message || String(e), ms: Date.now() - t0 });
      throw e;
    }
  }

  has(name) {
    return this.tools.has(name);
  }

  // 元数据查询 (v1.6.0 第四刀: 超时重试需要知道工具是否幂等/超时预算)
  metaOf(name) {
    return this.tools.get(name) || null;
  }

  list() {
    return [...this.tools.keys()];
  }

  // ---- 元数据枚举 (供 selfmod / 追踪) ----
  listDetailed() {
    return [...this.tools.values()].map(toDescriptor);
  }
}
