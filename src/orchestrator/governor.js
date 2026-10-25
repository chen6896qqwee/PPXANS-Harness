// src/orchestrator/governor.js - 子智能体并发治理器 (Concurrency Governor)
//
// 为什么需要它 (2026-10-07 军团扩容复盘):
//   Legion 自己的 maxConcurrent 只管**单次调用内部**的派发并发 (_mapBounded / runDag 层内)。
//   而 spawn_agent 现在是嵌套可达的 —— 主 agent 派 3 个子 agent, 每个子 agent 又各自派 3 个,
//   三层就是 27 个独立 PPXAgent 进程; 每次委派都 `new Legion()` 各自持一份 8 的额度,
//   "上限"在乘法下等于不存在。真实故障形态不是慢, 是机器被进程打满 (每个子 agent 还各带
//   一份 SQLite/JSON 记忆文件与 LLM 连接)。
//
// 本模块把"能同时活着多少个子进程"提升为**进程级唯一配额**, 与"单次派发多宽"解耦:
//   - limit        : 全局同时存在的子 agent 进程数硬上限 (可运行时调, 用户要的"并发数可调")
//   - perCallMax   : 单次 spawn_agent 一次能拿走的槽位数 (防一次调用吃掉整池)
//   - queueTimeout : 排队等槽位的耐心, 超时即失败而不是无限挂起
//
// 设计取舍:
//   1) 纯 Node、零依赖, 无定时器轮询 —— 用等待者队列 + 释放时 drain。
//   2) acquire(n) 是**批量原子**语义: 要么一次拿到 n 个, 要么排队。
//      否则 3 个并发调用各拿 2 个会把上限 4 撑到 6。
//   3) 超额请求 (n > limit) 不报错而钳到 limit —— 上层意图是"尽可能宽", 不是非法输入。
//   4) release 幂等: 子进程 exit/error/kill 三条路径都会调, 重复调用不得泄漏额度。

export const GOVERNOR_DEFAULTS = {
  limit: 8,             // 全局同时存活子 agent 上限
  perCallMax: 4,        // 单次派发上限
  queueTimeoutMs: 300000, // 排队等槽位超时 (5min: 子 agent 单任务上限 120s, 留足排队余量)
};

// 整数钳制:
//   非有限数 (NaN/undefined/"x") 或低于下限 → 回落默认值。刻意不用"钳到下限" —— 把 limit=-5
//   钳成 1 会把并发彻底冻住, 而用户的本意多半是"配错了", 回落到默认 (8) 才是可预期的行为。
function intOr(v, fallback, { min = 1, max = 256 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, Math.floor(n));
}

import { CrossProcessQuota } from "./quota-file.js";

export class ConcurrencyGovernor {
  constructor({ limit, perCallMax, queueTimeoutMs, name = "default", crossProcess = null } = {}) {
    this.name = name;
    this.limit = intOr(limit, GOVERNOR_DEFAULTS.limit);
    this.perCallMax = intOr(perCallMax, GOVERNOR_DEFAULTS.perCallMax);
    this.queueTimeoutMs = intOr(queueTimeoutMs, GOVERNOR_DEFAULTS.queueTimeoutMs, { min: 1, max: 3600000 });
    this.running = 0;
    this.waiters = []; // FIFO: { n, resolve, reject, timer, tag }
    this.startedAt = Date.now();
    this.peak = 0;
    this.acquired = 0;   // 累计发放的槽位次数
    this.completed = 0;  // 累计归还次数
    this.queued = 0;     // 累计排队次数
    this.timeouts = 0;   // 累计排队超时次数
    this.ungoverned = 0; // 未走治理器直连 spawn 的次数 (同步 spawnAgent 满额时的兜底, 用于诚实报告)
    // 跨进程配额账本 (P0-3): null = 未启用, 只按本进程 limit 治理
    this.cross = null;
    this.crossBlocked = 0; // 因跨进程配额真满而被拒的次数
    if (crossProcess) this.setCrossProcess(crossProcess);
  }

  // 挂载/更换跨进程账本。传 null 关闭。
  // opts: { enabled, file | dataDir, limit }
  setCrossProcess(opts) {
    if (!opts || opts.enabled === false) { this.cross = null; return null; }
    const file = opts.file || (opts.dataDir ? `${opts.dataDir}/legion-quota.json` : null);
    if (!file) { this.cross = null; return null; }
    this.cross = new CrossProcessQuota(file, { limit: opts.limit ?? this.limit });
    return this.cross;
  }

  // 申请跨进程名额。
  // 返回: 归还函数 (可能是 noop, 表示 fail-open 或未启用) / null 表示"跨进程真满, 不能放行"。
  // fail-open 的判定: 只有 tryAcquire 期间 unavailable 计数**新增**了才算故障放行;
  // 否则就是别的进程真把名额占满了, 必须老实排队。
  _takeCross(n) {
    if (!this.cross) return () => false;
    const u0 = this.cross.unavailable;
    const rel = this.cross.tryAcquire(n);
    if (rel) return rel;
    if (this.cross.unavailable > u0) return () => false; // 账本不可用: 降级为单进程软约束
    this.crossBlocked += 1;
    return null; // 跨进程满额: 拒绝
  }

  // 统一准入: 本地有空 **且** 跨进程拿得到 → 发放组合 lease (两者同时归还)
  _grant(want, tag) {
    if (this.running + want > this.limit) return null;
    const rel = this._takeCross(want);
    if (rel === null) return null;
    const local = this._lease(want, tag);
    let done = false;
    return () => {
      if (done) return false;
      done = true;
      local();
      rel();
      return true;
    };
  }

  // ---- 配置 ----
  configure({ limit, perCallMax, queueTimeoutMs, crossProcess } = {}) {
    if (limit !== undefined) this.setLimit(limit);
    if (perCallMax !== undefined) this.perCallMax = intOr(perCallMax, this.perCallMax);
    if (queueTimeoutMs !== undefined) this.queueTimeoutMs = intOr(queueTimeoutMs, this.queueTimeoutMs, { min: 1, max: 3600000 });
    if (crossProcess !== undefined) this.setCrossProcess(crossProcess);
    return this;
  }

  // 动态调整全局上限 (用户在运行期改"最大子智能体并发数"的入口)。
  // 放宽: 立即 drain, 让排队者进场。收紧: 只影响后续 acquire, 不杀已在跑的进程
  // (硬中断会毁掉半个 DAG 的中间结果; 需要立即收敛请用 legion_set_concurrency 的 drain 语义另行处理)。
  setLimit(n) {
    this.limit = intOr(n, this.limit);
    this._drain();
    return this.limit;
  }

  // 单次派发宽度上限 (取 min 全局上限)
  effPerCall(n) {
    return Math.max(1, Math.min(this.perCallMax, this.limit, Math.max(1, Number(n) || 1)));
  }

  // ---- 获取槽位 ----
  // 返回 release() 函数 (幂等)。排队超时 / limit=0 场景 reject 一个可行动错误。
  acquire(n = 1, { tag = "", timeoutMs } = {}) {
    const want = Math.max(1, Math.min(intOr(n, 1, { min: 1, max: 256 }), this.limit));
    const grant = this._grant(want, tag);
    if (grant) return Promise.resolve(grant);
    this.queued += 1;
    return new Promise((resolve, reject) => {
      const waiter = { n: want, tag, resolve, reject, timer: null, done: false };
      const ms = Number.isFinite(timeoutMs) ? timeoutMs : this.queueTimeoutMs;
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        waiter.done = true;
        this.timeouts += 1;
        reject(new Error(`并发治理器: 等待 ${want} 个子 agent 槽位超时 (${ms}ms, 当前 ${this.running}/${this.limit} 在跑)${tag ? ` [${tag}]` : ""}`));
      }, ms);
      // 刻意 **不 unref()** 这个定时器: 排队等待是真实的未完成工作, 进程不该在有人等锁时静默退出。
      // (试过 unref: 测试/CLI 里出现 "Promise resolution is still pending but the event loop has
      //  already resolved" —— 排队者永远拿不到结果, 比多活几十毫秒危险得多。)
      this.waiters.push(waiter);
      this._drain();
    });
  }

  // 非阻塞: 拿得到就返回 release, 拿不到返回 null (同步 spawn 路径用, 不阻塞事件循环)
  tryAcquire(n = 1, { tag = "" } = {}) {
    const want = Math.max(1, Math.min(intOr(n, 1, { min: 1, max: 256 }), this.limit));
    const grant = this._grant(want, tag);
    if (!grant) { this.ungoverned += 1; return null; }
    return grant;
  }

  _lease(n, tag) {
    this.running += n;
    this.acquired += n;
    if (this.running > this.peak) this.peak = this.running;
    let released = false;
    const self = this;
    return function release() {
      if (released) return false; // 幂等: exit/error/kill 三路径都会调
      released = true;
      self.running = Math.max(0, self.running - n);
      self.completed += n;
      self._drain();
      return true;
    };
  }

  // 把配额发给最早排队且放得下的等待者 (严格 FIFO + 队头阻塞:
  //  队头拿不下就整体等待, 不做"跳队头塞小请求" —— 那会让大队列被饿死)
  _drain() {
    while (this.waiters.length) {
      const head = this.waiters[0];
      if (head.done) { this.waiters.shift(); continue; }
      // 准入判定统一走 _grant: 跨进程配额也满时同样队头阻塞, 不搞"本地有空就放行"的双标
      const grant = this._grant(head.n, head.tag);
      if (!grant) break;
      this.waiters.shift();
      head.done = true;
      if (head.timer) clearTimeout(head.timer);
      head.resolve(grant);
    }
  }

  // acquire → 跑 → 必定归还 (异常路径也不泄漏额度)
  async run(fn, { n = 1, tag = "" } = {}) {
    const release = await this.acquire(n, { tag });
    try { return await fn(); } finally { release(); }
  }

  // 有界并发映射 (与 Legion._mapBounded 同语义; 集中一份避免两处口径分叉)。
  // concurrency 缺省取 effPerCall(items.length)。
  async mapBounded(items, fn, { concurrency } = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];
    const cap = Math.max(1, Math.min(intOr(concurrency, this.effPerCall(list.length), { min: 1, max: 256 }), list.length));
    const results = new Array(list.length);
    let idx = 0;
    const workers = Array.from({ length: cap });
    await Promise.all(workers.map(async () => {
      while (idx < list.length) {
        const i = idx++;
        results[i] = await fn(list[i], i);
      }
    }));
    return results;
  }

  stats() {
    return {
      name: this.name,
      limit: this.limit,
      perCallMax: this.perCallMax,
      running: this.running,
      idle: Math.max(0, this.limit - this.running),
      waiting: this.waiters.filter((w) => !w.done).length,
      waitingSlots: this.waiters.filter((w) => !w.done).reduce((a, w) => a + w.n, 0),
      peak: this.peak,
      acquired: this.acquired,
      completed: this.completed,
      queued: this.queued,
      timeouts: this.timeouts,
      ungoverned: this.ungoverned,
      queueTimeoutMs: this.queueTimeoutMs,
      uptimeMs: Date.now() - this.startedAt,
      // 跨进程账本 (未启用为 null, 启用则如实暴露 total / unavailable —— 治理不能只报一半)
      crossProcess: !this.cross ? { enabled: false } : (() => {
        const s = this.cross.stats();
        return {
          enabled: true,
          file: this.cross.file,
          total: s.total,
          limit: s.limit,
          unavailable: s.unavailable,   // fail-open 次数 (非零 = 账本有问题, 配额实际已降级)
          reaped: s.reaped,             // 回收的死 pid 名额数
          blocked: this.crossBlocked,   // 因跨进程真满被拒的次数
        };
      })(),
    };
  }

  // 排空等待者 (测试/关机用): 让排队者立刻以明确错误失败, 而不是挂在超时上
  drainWaiters(reason = "治理器已关闭") {
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const w of waiters) {
      if (w.done) continue;
      w.done = true;
      if (w.timer) clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
    return waiters.length;
  }
}

// ---- 进程级单例 ----
// 所有 Legion 实例默认共享同一个治理器: "能同时活多少个子进程"是机器级事实, 不该每层各持一份。
let _default = null;

export function getGovernor() {
  if (!_default) _default = new ConcurrencyGovernor({ ...GOVERNOR_DEFAULTS, name: "process" });
  return _default;
}

export function configureGovernor(opts) {
  return getGovernor().configure(opts || {});
}

// 从配置组构造/更新治理器参数 (agent.legion.*)
// dataDir 可选: 需要跨进程配额账本时才用得上 (账本落 <dataDir>/legion-quota.json)
export function governorOptsFromConfig(config, dataDir = null) {
  const c = config?.agent?.legion || {};
  const crossOn = c.cross_process_quota === true;
  return {
    limit: c.max_concurrent_agents,
    perCallMax: c.max_concurrent_per_call,
    queueTimeoutMs: c.queue_timeout_ms,
    crossProcess: { enabled: crossOn, dataDir },
  };
}

// 测试与热重载用: 丢弃单例 (下次 getGovernor 新建)
export function resetGovernor() {
  if (_default) _default.drainWaiters("治理器已重置");
  _default = null;
}

export default { ConcurrencyGovernor, getGovernor, configureGovernor, resetGovernor, governorOptsFromConfig, GOVERNOR_DEFAULTS };
