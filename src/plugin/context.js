// src/plugin/context.js - 轻量服务注册表 (零依赖插件系统核心)
// 借鉴 deepseek-harness 的 Cordis "everything is a plugin" 理念, 但零依赖、同步、极简:
//   - 插件 = (ctx) => void 函数, 通过 ctx.provide(key, value) 注册服务, ctx.consume(key) 消费服务
//   - 注册是可逆效果: ctx.onDispose(fn) 挂卸载钩子, ctx.dispose() 逆序执行
//   - 支持父子 context: 子 context 的 consume 会向父查找 (用于 agent 内 scope 隔离)
export class Context {
  constructor(parent = null) {
    this.parent = parent;
    this._services = new Map(); // key -> value
    this._disposers = [];       // 可逆效果 (dispose 时逆序执行)
  }

  // 注册服务 (返回 value 便于链式)
  provide(key, value) {
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
