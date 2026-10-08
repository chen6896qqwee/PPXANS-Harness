// src/orchestrator/legion.js - Agent 军团编排器
// 管理多个独立 agent 子进程, 支持并行派发任务、按角色分工
//
// 2026-10-07 (全能超级 Agent 扩容): 接入进程级并发治理器 (governor.js)。
//   - 进程总数硬上限不再由本类自持, 而是共享单例 ConcurrencyGovernor (嵌套委派不乘法爆炸)
//   - maxConcurrent (单次派发宽度) 缺省从治理器推导, 运行期可调
//   - 新增 spawnAgents(): 受治理的批量 spawn, delegate / supervisor / legion 模式统一入口
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { info, error, warn, debug } from "../utils/logger.js";
import { createLineReader, writeLine } from "../utils/ndjson.js";
import { runDag } from "./dag.js";
import { getGovernor } from "./governor.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER = path.join(ROOT, "src", "agent-worker.js");

export class Legion extends EventEmitter {
  constructor({ workerPath = WORKER, nodeBin = process.execPath, maxConcurrent = null, governor = null } = {}) {
    super();
    this.workerPath = workerPath;
    this.nodeBin = nodeBin;
    // 共享治理器: 默认取进程单例 —— "能同时活多少子进程"是机器级事实, 不是每个 Legion 各自的私产
    this.governor = governor || getGovernor();
    // maxConcurrent = 单次派发宽度 (DAG 层内 / broadcast / dispatch 的并发度)。
    // 显式传入则优先; 否则跟随治理器 (perCallMax ∩ limit), 动态可调。
    this._maxConcurrent = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : null;
    this.agents = new Map(); // { name: { proc, pending: Map<id,{resolve,reject}>, counter, lease, status } }
  }

  // 单次派发宽度 (运行期可读; 缺省随治理器动态变化)
  get maxConcurrent() {
    if (this._maxConcurrent !== null) return this._maxConcurrent;
    return Math.max(1, Math.min(this.governor.perCallMax, this.governor.limit));
  }
  set maxConcurrent(v) {
    const n = Number(v);
    this._maxConcurrent = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }

  // 有界并发执行器 (转调治理器同一实现, 避免两处口径分叉):
  // 以固定并发度跑一批 async 任务, 超出上限的排队 (背压而非一次性 Promise.all)
  async _mapBounded(items, fn, { concurrency = this.maxConcurrent } = {}) {
    return this.governor.mapBounded(items, fn, { concurrency });
  }

  // 创建一个 agent 子进程
  // opts.lease: 由 spawnAgents 预取的治理器槽位 release 函数 (内置使用)
  spawnAgent(name, { dataDir, globalDataDir, env = {}, lease = null } = {}) {
    // 未显式指定 dataDir → worker 退回默认 root(项目根) 的 data/, 即把运行数据写进生产目录。
    // 2026-10-03: test/legion.test.js 曾因此污染真实 data/ (实测 139 个测试中唯一一个), 此处显式告警。
    if (!dataDir) warn(`[legion] spawnAgent(${name}) 未指定 dataDir, worker 将写入默认数据目录 (可能是生产 data/)`);
    if (this.agents.has(name)) {
      // 已存在则复用: 预取的多余槽位必须归还, 否则泄漏配额 (并发上限会随复用次数单调收紧)
      if (lease) { try { lease(); } catch { /* 幂等 release, 失败无害 */ } }
      return this.agents.get(name);
    }
    // 未预取槽位时的兜底: 非阻塞尝试登记。拿到 → 该进程纳入配额统计;
    // 拿不到 (已满) → 照旧 spawn 但计入 ungoverned, 由 legion_status 如实报告, 而不是假装受控。
    let ownLease = lease;
    if (!ownLease) {
      ownLease = this.governor.tryAcquire(1, { tag: name });
      if (!ownLease) warn(`[legion] spawnAgent(${name}) 超出并发上限 (${this.governor.running}/${this.governor.limit}), 本次未被治理器纳管`);
    }
    const env2 = { ...process.env, ...env };
    if (dataDir) env2.PPX_AGENT_DATA_DIR = dataDir;
    // 全局共享目录: 跨 agent 共享经验库 (ANS 全局记忆)
    if (globalDataDir) env2.PPX_AGENT_GLOBAL_DATA_DIR = globalDataDir;
    let proc;
    try {
      proc = spawn(this.nodeBin, [this.workerPath], {
        cwd: ROOT,
        env: env2,
        stdio: ["pipe", "pipe", "inherit"],
      });
    } catch (e) {
      if (ownLease) { try { ownLease(); } catch { /* 幂等 */ } }
      throw e;
    }
    const entry = { proc, pending: new Map(), counter: 0, lease: ownLease || null, spawnedAt: Date.now(), lastUsedAt: Date.now() };
    this.agents.set(name, entry);

    // 槽位归还唯一出口 (release 幂等, 三条退出路径重复调用无害)
    const releaseLease = () => {
      if (!entry.lease) return;
      const r = entry.lease;
      entry.lease = null;
      try { r(); } catch (e) { debug(`[legion] 槽位归还异常 (已忽略): ${e && e.message ? e.message : e}`); }
    };
    entry.releaseLease = releaseLease;

    proc.stdout.setEncoding("utf8");
    const onLine = createLineReader((line) => {
      try {
        const msg = JSON.parse(line);
        // step 中间事件: 触发 onProgress 回调, 不消费 pending (等最终 reply)
        if (msg.type === "step" && msg.id && entry.pending.has(msg.id)) {
          const p = entry.pending.get(msg.id);
          if (p && p.onProgress) { try { p.onProgress(msg); } catch (e) { debug(`[orchestrator/legion] 已忽略异常: ${e && e.message ? e.message : e}`); } }
          return;
        }
        if (msg.id && entry.pending.has(msg.id)) {
          const { resolve, reject } = entry.pending.get(msg.id);
          entry.pending.delete(msg.id);
          if (msg.type === "error") reject(new Error(msg.error));
          else resolve(msg);
        }
      } catch (e) { debug(`[orchestrator/legion] 已忽略异常: ${e && e.message ? e.message : e}`); }
    });
    proc.stdout.on("data", onLine);
    proc.on("error", (err) => {
      // v1.0.8: spawn 失败 (node bin 不存在等) 兜底, 拒绝所有 pending, 防永久挂起
      error(`agent[${name}] 启动失败: ${err.message}`);
      for (const [, { reject }] of entry.pending) reject(new Error(`agent ${name} 启动失败`));
      entry.pending.clear();
      this.agents.delete(name);
      releaseLease();
    });
    proc.on("exit", (code) => {
      info(`agent[${name}] 退出 code=${code}`);
      // 拒绝所有 pending
      for (const [, { reject }] of entry.pending) reject(new Error(`agent ${name} 已退出`));
      entry.pending.clear();
      this.agents.delete(name);
      releaseLease();
      this.emit("exit", name, code);
    });
    info(`agent[${name}] 已启动 (pid=${proc.pid})`);
    return entry;
  }

  // 受治理的批量 spawn (delegate / supervisor / legion 模式统一入口)
  // specs: [{ name, opts? }] → 返回实际启动的名字数组 (已存在的名字不重复启动)
  // 分批: 每批宽度 = 治理器单次派发上限; 每批先原子 acquire(批大小) 再 spawn, 排队而非打爆机器。
  async spawnAgents(specs, { concurrency = null } = {}) {
    const list = (Array.isArray(specs) ? specs : [])
      .map((s) => (typeof s === "string" ? { name: s } : s))
      .filter((s) => s && s.name && !this.agents.has(s.name));
    if (!list.length) return [];
    const cap = Math.max(1, Math.min(
      Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : this.governor.effPerCall(list.length),
      this.governor.limit,
    ));
    const started = [];
    // 逐槽获取而非整批原子获取: 语义等价 (FIFO 队列 + 全局 limit 兜底) 但无"部分移交"泄漏窗口 ——
    // 每个槽位从 acquire 到 spawnAgent 移交之间只有一条路径, 异常就是当场 release。
    for (let i = 0; i < list.length; i += cap) {
      const batch = list.slice(i, i + cap);
      for (const s of batch) {
        // eslint-disable-next-line no-await-in-loop -- 队列顺序即公平性: 串行 acquire 保证 FIFO 不被插队
        const release = await this.governor.acquire(1, { tag: "legion.spawnAgents" });
        try {
          this.spawnAgent(s.name, { ...(s.opts || {}), lease: release });
          started.push(s.name); // 槽位所有权已移交 entry (进程退出时归还)
        } catch (e) {
          try { release(); } catch { /* 幂等 release, 失败无害 */ }
          throw e;
        }
      }
    }
    return started;
  }

  // 向某 agent 发消息, 返回 Promise (onProgress 可选: 接收 step 中间事件)
  // v1.0.8: 超时兜底 (默认 30s), worker 卡死/异常不导致 pending 永久挂起
  send(name, msg, { onProgress, timeout = 30000 } = {}) {
    const entry = this.agents.get(name);
    if (!entry || entry.proc.exitCode !== null) {
      return Promise.reject(new Error(`agent ${name} 未运行`));
    }
    entry.lastUsedAt = Date.now();
    const id = ++entry.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        reject(new Error(`agent ${name} 请求超时 (${timeout}ms)`));
      }, timeout);
      entry.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        onProgress,
      });
      try {
        writeLine(entry.proc.stdin, { id, ...msg });
      } catch (e) {
        clearTimeout(timer);
        entry.pending.delete(id);
        reject(new Error(`agent ${name} 写入失败: ${e.message}`));
      }
    });
  }

  // 并行派发: 同一任务广播给多个 agent, 最快返回
  async broadcast(type, message, { timeout = 30000 } = {}) {
    const names = [...this.agents.keys()];
    if (!names.length) throw new Error("军团为空, 先 spawnAgent");
    const results = await this._mapBounded(
      names,
      (n) => this.send(n, { type, message }, { timeout }).catch((e) => ({ type: "error", error: e.message }))
    );
    return names.map((n, i) => ({ agent: n, ...results[i] }));
  }

  // 按角色分工: 把任务列表分给不同 agent
  // 2026-10-02: 串行 → 有界并行 (_mapBounded 背压, 同 broadcast/runDag 共享 maxConcurrent 口)
  async dispatch(type, tasks) {
    const names = [...this.agents.keys()];
    if (!names.length) throw new Error("军团为空, 先 spawnAgent");
    return this._mapBounded(tasks, (task, i) => {
      const name = names[i % names.length];
      return this.send(name, { type, message: task })
        .then((r) => ({ agent: name, task, ...r }))
        .catch((e) => ({ agent: name, task, type: "error", error: e.message }));
    });
  }

  // DAG 任务编排: 按依赖拓扑分层执行, 同层并行, 上游结果传入下游 (P3)
  // graph = { nodes: [{ id, task, dependsOn?: [id], agent?: name }] }
  // 返回 { results: {id: reply}, order: [执行顺序] }
  async runDag(graph) {
    const names = [...this.agents.keys()];
    if (!names.length) throw new Error("军团为空, 先 spawnAgent");
    let rr = 0; // round-robin 派发未指定 agent 的节点
    return runDag(graph, async (id, node, deps) => {
      const agent = node.agent || names[rr++ % names.length];
      const depText = Object.entries(deps)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 500)}`)
        .join("\n");
      const message = node.task + (depText ? "\n\n[上游结果]\n" + depText : "");
      const r = await this.send(agent, { type: "chat", message });
      return r.reply;
    }, { concurrency: this.maxConcurrent });
  }

  // 关闭所有 agent
  // v1.0.8: 先发 shutdown 优雅退出, 300ms 后兜底 kill 仍存活进程 (worker 无响应/卡死时不残留)
  async shutdownAll() {
    for (const [name] of [...this.agents]) {
      try { this.send(name, { type: "shutdown" }).catch(() => {}); } catch (e) { debug(`[orchestrator/legion] 已忽略异常: ${e && e.message ? e.message : e}`); }
    }
    // 等待退出
    await new Promise((r) => setTimeout(r, 300));
    for (const [name, entry] of [...this.agents]) {
      try { entry.proc.kill(); } catch (e) { debug(`[orchestrator/legion] 已忽略异常: ${e && e.message ? e.message : e}`); }
      if (entry.releaseLease) entry.releaseLease();
    }
  }

  // 回收单个 agent (2026-10-04): spawn_agent 的委派名带时间戳, 每次调用都新建 2~4 个子进程,
  // 而军团句柄挂在 agent._legion 上跨调用复用 —— 不按需回收, 长跑进程 (ppx-serve / taskbench)
  // 里的子进程随委派次数线性堆积 (每个都是独立 PPXAgent + 独立数据目录)。
  // 语义与 shutdownAll 相同 (先优雅 shutdown, 宽限期后兜底 kill), 只针对一个名字。
  async killAgent(name, { graceMs = 300 } = {}) {
    const entry = this.agents.get(name);
    if (!entry) return false;
    try { this.send(name, { type: "shutdown" }).catch(() => {}); } catch { /* 进程已退出 */ }
    const exited = new Promise((r) => {
      if (entry.proc.exitCode !== null || entry.proc.signalCode !== null) r();
      else entry.proc.once("exit", r);
    });
    await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs))]);
    try { if (entry.proc.exitCode === null) entry.proc.kill(); } catch { /* 竞态: 已自行退出 */ }
    // exit 事件可能尚未派发到这里, 显式再归还一次 (release 幂等, 不重复扣减)
    if (entry.releaseLease) entry.releaseLease();
    this.agents.delete(name);
    return true;
  }

  list() {
    return [...this.agents.keys()].map((n) => {
      const e = this.agents.get(n);
      return { name: n, pid: e.proc.pid, governed: !!e.lease, sinceMs: Date.now() - (e.spawnedAt || Date.now()) };
    });
  }

  // 军团 + 治理器联合视图 (legion_status 工具消费; 诚实报告未纳管进程数)
  status() {
    return { agents: this.list(), governor: this.governor.stats(), maxConcurrent: this.maxConcurrent };
  }
}
