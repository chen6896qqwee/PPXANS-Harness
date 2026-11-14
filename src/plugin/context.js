// src/plugin/context.js - 轻量服务注册表 (零依赖插件系统核心)
// 设计溯源 docs/PROVENANCE.md#dsh 的 Cordis "everything is a plugin" 理念, 但零依赖、同步、极简:
//   - 插件 = (ctx) => void 函数, 通过 ctx.provide(key, value) 注册服务, ctx.consume(key) 消费服务
//   - 注册是可逆效果: ctx.onDispose(fn) 挂卸载钩子, ctx.dispose() 逆序执行
//   - 支持父子 context: 子 context 的 consume 会向父查找 (用于 agent 内 scope 隔离)
// P2⑧ (2026-09-15): 插件两级权限 (设计溯源 docs/PROVENANCE.md#hanaagent restricted/full-access 思想) ——
//   敏感服务 (路由/生命周期/页面/工具链) 只允许 full-access 插件注册; restricted 插件
//   只能注册普通服务。compose 时校验, 违规注册直接拒绝 (代码强制, 不靠约定)。
export const PLUGIN_ACCESS = { RESTRICTED: "restricted", FULL: "full-access" };

// 敏感服务: 仅 full-access 插件可注册 (注册到这些 key 会触发权限校验)
const SENSITIVE_SERVICES = new Set([
  "routes",        // HTTP 路由
  "lifecycle",     // 生命周期钩子
  "tools",         // 工具链
  "shell",         // 命令执行
  "pages",         // 页面
  "providers",     // LLM provider
  "extensions",    // 扩展
]);

// 能力白名单与清单契约同在 protocol (L0), 避免 Web 管理页反向依赖本层。
// 诚实边界: 这是"服务注册范围"控制, 不是沙箱 —— 插件代码仍在主进程里跑。
export { PLUGIN_CAPABILITIES } from "../protocol/index.js";

export class Context {
  // capabilities: null = 未声明 (仅用于内核/程序化可信插件, 沿用旧的"full-access 即可");
  //               string[] = 显式能力集 (清单插件必须显式声明, 空数组 = 不能注册任何敏感服务)。
  constructor(parent = null, { access = PLUGIN_ACCESS.RESTRICTED, capabilities = null } = {}) {
    this.parent = parent;
    this.access = access;             // P2⑧: 当前插件权限位
    this.capabilities = capabilities; // 2026-11-02: 敏感服务能力集 (null=旧行为)
    this._services = new Map();       // key -> value
    this._disposers = [];             // 可逆效果 (dispose 时逆序执行)
  }

  // P2⑧: 切换权限位 —— 返回共享同一存储的包装 (原型继承), 仅 access 不同。
  // 这样 restricted 插件注册的普通服务, 顶层 ctx.consume 也能查到 (服务仍全局可见),
  // 但敏感 key 注册会被拒绝。
  // 2026-11-02: 同时带上能力集。未显式声明能力 = 空集 (清单插件 deny-by-default);
  //   restricted 无论声明什么能力都没有敏感注册权 (access 先决条件)。
  withAccess(access, capabilities = []) {
    const wrapper = Object.create(this);
    wrapper.access = access;
    wrapper.capabilities = access === PLUGIN_ACCESS.FULL ? (capabilities || []) : [];
    return wrapper;
  }

  // 注册服务 (返回 value 便于链式)
  provide(key, value) {
    // P2⑧: 敏感服务权限校验 —— restricted 插件注册敏感 key 被拒
    if (SENSITIVE_SERVICES.has(key) && this.access !== PLUGIN_ACCESS.FULL) {
      throw new Error(`[插件权限] 注册 ${key} 需要 full-access, 当前 ${this.access}`);
    }
    // 2026-11-02: full-access 还要逐项声明能力。capabilities=null 是内核/程序化插件旧行为。
    if (SENSITIVE_SERVICES.has(key) && this.capabilities !== null && !this.capabilities.includes(key)) {
      throw new Error(`[插件权限] 注册 ${key} 需要清单声明 capabilities: ["${key}"] (当前 [${this.capabilities.join(", ")}])`);
    }
    this._services.set(key, value);
    return value;
  }

  // 消费服务: 先查自己, 再向上查父 context
  consume(key) {
    if (this._services.has(key)) return this._services.get(key);
    if (this.parent) return this.parent.consume(key);
    return undefined;
  }

  has(key) {
    if (this._services.has(key)) return true;
    if (this.parent) return this.parent.has(key);
    return false;
  }

  // 注册可逆效果 (卸载时执行), 返回取消函数
  onDispose(fn) {
    this._disposers.push(fn);
    return () => {
      const i = this._disposers.indexOf(fn);
      if (i >= 0) this._disposers.splice(i, 1);
    };
  }

  // 卸载: 逆序执行所有 disposer
  async dispose() {
    for (const fn of [...this._disposers].reverse()) {
      try { await fn(); } catch {}
    }
    this._disposers = [];
    this._services.clear();
  }
}
