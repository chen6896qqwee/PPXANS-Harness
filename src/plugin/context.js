// src/plugin/context.js - 轻量服务注册表 (零依赖插件系统核心)
// 借鉴 deepseek-harness 的 Cordis "everything is a plugin" 理念, 但零依赖、同步、极简:
//   - 插件 = (ctx) => void 函数, 通过 ctx.provide(key, value) 注册服务, ctx.consume(key) 消费服务
//   - 注册是可逆效果: ctx.onDispose(fn) 挂卸载钩子, ctx.dispose() 逆序执行
//   - 支持父子 context: 子 context 的 consume 会向父查找 (用于 agent 内 scope 隔离)
// P2⑧ (2026-09-15): 插件两级权限 (吸收 HanaAgent restricted/full-access 思想) ——
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

export class Context {
  constructor(parent = null, { access = PLUGIN_ACCESS.RESTRICTED } = {}) {
    this.parent = parent;
    this.access = access;       // P2⑧: 当前插件权限位
    this._services = new Map(); // key -> value
    this._disposers = [];       // 可逆效果 (dispose 时逆序执行)
  }

  // P2⑧: 切换权限位 —— 返回共享同一存储的包装 (原型继承), 仅 access 不同。
  // 这样 restricted 插件注册的普通服务, 顶层 ctx.consume 也能查到 (服务仍全局可见),
  // 但敏感 key 注册会被拒绝。
  withAccess(access) {
    const wrapper = Object.create(this);
    wrapper.access = access;
    return wrapper;
  }

  // 注册服务 (返回 value 便于链式)
  provide(key, value) {
    // P2⑧: 敏感服务权限校验 —— restricted 插件注册敏感 key 被拒
    if (SENSITIVE_SERVICES.has(key) && this.access !== PLUGIN_ACCESS.FULL) {
      throw new Error(`[插件权限] 注册 ${key} 需要 full-access, 当前 ${this.access}`);
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
