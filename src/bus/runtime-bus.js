// src/bus/runtime-bus.js - ②循环系: 全局 Runtime 总线 (RC1 §2 动态行为层地基)
// 在 session.js 会话事件日志之上新增一层"全局总线", 打通模块间函数直连的接缝:
//   - Event:   事实广播 (发生了什么), 只读, 谁都能订阅
//   - Command: 意图 (要执行什么), 带 id + 处理器, 返回 Result
//   - State:   全局运行时状态槽 (可读写, 供①/⑦读倾向, 供观测)
// 零依赖, 纯 Node 原生。设计对齐 RC1 §5.2 总线消息类型。
export class RuntimeBus {
  constructor({ name = "runtime", historyLimit = 200 } = {}) {
    this.name = name;
    this._events = new Map();        // type -> Set<handler>
    this._handlers = new Map();      // verb -> handler
    this._state = new Map();         // 状态槽
    this._history = [];              // 最近事件 (可观测/审计)
    this._historyLimit = historyLimit;
    this._seq = 0;                   // 全局序列
    this._interceptors = [];         // 命令前置拦截器 (⑧免疫可挂闸门)
  }

  // ---------- Event (事实广播, 只读) ----------
  emit(type, payload = {}, meta = {}) {
    this._seq++;
    const ev = { seq: this._seq, ts: Date.now(), type, payload, meta };
    this._history.push(ev);
    if (this._history.length > this._historyLimit) this._history.shift();
    const set = this._events.get(type);
    if (set) for (const fn of set) { try { fn(ev); } catch {} }
    return ev;
  }

  on(type, handler) {
    if (!this._events.has(type)) this._events.set(type, new Set());
    this._events.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const set = this._events.get(type);
    if (set) set.delete(handler);
  }

  // ---------- Command (意图 + 处理器, 返回 Result) ----------
  command(verb, payload = {}, { timeoutMs = 0 } = {}) {
    return new Promise((resolve) => {
      const handler = this._handlers.get(verb);
      if (!handler) return resolve({ ok: false, error: `no-command-handler:${verb}`, payload });
      let done = false;
      const finish = (r) => { if (done) return; done = true; resolve(r); };
      const id = `${verb}:${this._seq++}`;
      const cmd = { id, ts: Date.now(), verb, payload };
      // 拦截器链 (⑧免疫: 可在执行前做权限/风险校验, 拒绝则短路)
      const run = async (i) => {
        if (i >= this._interceptors.length) {
          try { finish(await handler(cmd)); }
          catch (e) { finish({ ok: false, error: String(e?.message || e), cmdId: id }); }
          return;
        }
        try {
          await this._interceptors[i](cmd, () => run(i + 1));
        } catch (e) {
          finish({ ok: false, error: String(e?.message || e), cmdId: id, blocked: true });
        }
      };
      run(0);
      if (timeoutMs > 0) setTimeout(() => finish({ ok: false, error: "command-timeout", cmdId: id }), timeoutMs);
      this.emit("command", { id, verb, payload });
    });
  }

  register(verb, handler) { this._handlers.set(verb, handler); return this; }

  // 命令前置拦截器 (⑧免疫闸门挂载点)
  intercept(fn) { this._interceptors.push(fn); return () => { const i = this._interceptors.indexOf(fn); if (i >= 0) this._interceptors.splice(i, 1); }; }

  // ---------- State (运行时状态槽) ----------
  get(key, fallback) {
    if (!this._state.has(key)) return fallback;
    return this._state.get(key);
  }
  set(key, value) { this._state.set(key, value); this._state._rev = (this._state._rev || 0) + 1; this.emit("state", { key, value }); return value; }
  has(key) { return this._state.has(key); }

  // ---------- 观测/审计 ----------
  // 最近事件 (含 command), 供 trace/调试/审计拉取
  recent(n = 50) { return this._history.slice(-n); }
  // 挂总线之旅: 返回可断开回放的订阅器 (调试用)
  trace() {
    const out = [];
    const off = this.on("*", (ev) => out.push(ev));
    return { events: out, stop: off };
  }
  clearHistory() { this._history = []; }
}

export default RuntimeBus;