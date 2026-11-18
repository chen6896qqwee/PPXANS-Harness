// src/orchestrator/legion.js - Agent 军团编排器
// 管理多个独立 agent 子进程, 支持并行派发任务、按角色分工
import { runEnvForChild, announceChildRun } from "../core/run-context.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { info, error } from "../utils/logger.js";
import { createLineReader, writeLine } from "../utils/ndjson.js";
import { runDag } from "./dag.js";
import { getGovernor } from "./governor.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 2026-10-10 修复: 原先 spaw n 的是 src/orchestrator/agent-worker.js —— 那是 2026-10-07
//   "因依赖环移出"后遗留的**旧副本**, 缺 PPX_AGENT_CONFIG_JSON 配置注入与 await shutdown,
//   沙箱/自定义 configFile 场景下子 agent 会退化成"无模型"。指向移出后的唯一新版。
const WORKER = path.join(ROOT, "src", "agent-worker.js");

// 回收等待窗口 (2026-11-12): 原先超时后只投递 SIGTERM 就 resolve, 调用方以为"回收完成",
//   实际进程还在退出途中 —— 全套件并行时被 L2 生命周期测试抓到残留。契约要么不承诺,
//   要么等真实 exit: 优雅窗口 → SIGTERM → 有界等待 → SIGKILL → 最后有界等待。
const EXIT_GRACE_MS = 300;
const EXIT_FORCE_MS = 1500;
const EXIT_AFTER_KILL_MS = 500;

function delayFlag(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    t.unref?.();
  });
}

async function waitForExit(exitPromise, ms) {
  return Promise.race([exitPromise.then(() => true), delayFlag(ms)]);
}

export class Legion extends EventEmitter {
  // defaultTimeout (2026-10-24): 广播/DAG 等编排调用的默认超时。原默认 30s 是按"控制消息"
  //   设的, 但 chat 类消息要跑完整工具循环, 30s 内几乎必超时 —— 军团模式因此形同虚设。
  //   现可经构造参数/PPX_LEGION_TIMEOUT_MS 配置, 默认放宽到 10 分钟。
  constructor({ workerPath = WORKER, nodeBin = process.execPath, maxConcurrent = 8, defaultTimeout = Number(process.env.PPX_LEGION_TIMEOUT_MS) || 600000, poolSize = 0 } = {}) {
    super();
    this.workerPath = workerPath;
    this.nodeBin = nodeBin;
    this.maxConcurrent = maxConcurrent; // 军团整体并发上限: 防止大 DAG/广播瞬间 spawn 海量子进程
    this.defaultTimeout = Math.max(1000, Number(defaultTimeout) || 600000);
    this.agents = new Map(); // { name: { proc, pending: Map<id,{resolve,reject}>, counter } }
    // 并发治理器 (2026-10-31 一期挂接): 此前 governor 写好了却没挂到 Legion 上,
    //   delegate.js/team-room.js 的 `typeof L.spawnAgents === "function"` 恒 false,
    //   spawn 实际绕过配额。现在 spawnAgents 走 acquire(1), 进程生命周期内持有许可。
    this.governor = getGovernor();
    // ---- Worker 热池 (v5.0 P2.1, 2026-11-07) ----
    // 此前每次委派都冷启动一个完整 PPXAgent 子进程 (config 装配 + 插件 + 记忆加载,
    //   秒级); 高频委派下这段启动时间纯粹是税。pool_size > 0 时预先热好 N 个常驻
    //   worker, spawnAgent(name) 优先"接管"一个热 worker (只换登记名, 免冷启动);
    //   空闲 TTL 回收 (默认 15 分钟没人用就杀掉, 不常驻烧内存)。只读委派 (env 带
    //   PPX_AGENT_READONLY) 不接管 —— 池里是全能力 worker, 混用会放大权限。
    this.poolSize = Math.max(0, Number(poolSize) || 0);
    this._pool = [];            // 待接管的热 worker 名单 (["pool-0", ...])
    this._poolMeta = new Map(); // name -> { warmedAt, globalDataDir }
    this._poolSweeper = null;
    this.poolAdopted = 0;       // 生命周期观测: 累计接管次数 (legion_status 可见)
  }

  // 有界并发执行器: 以固定并发度跑一批 async 任务, 超出上限的排队 (背压而非一次性 Promise.all)
  // 这是 broadcast/runDag 层共享的背压口, 避免"并发无数控、大输入一次性打爆子进程数"
  async _mapBounded(items, fn, { concurrency = this.maxConcurrent } = {}) {
    const results = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) });
    await Promise.all(workers.map(async () => {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i], i);
      }
    }));
    return results;
  }

  // 整批 spawn (配额治理入口, 2026-10-31 一期): delegate.js runTeam / team-room
  //   makeLegionExecutor 早已按 `typeof L.spawnAgents === "function"` 预留调用口, 此前
  //   Legion 没有该方法 → 恒退回逐个 spawnAgent 绕过配额。现在每个 spawn 先经
  //   governor.acquire(1) 拿许可 (排队/拒绝由 governor 语义决定), 许可随进程生命周期
  //   持有, 进程 exit/error 时归还 (release 幂等, 重复调不泄漏额度)。
  //   specs 形态 = [{ name, opts }] —— 与两处既有调用点逐字段对齐。
  async spawnAgents(specs = []) {
    return this._mapBounded(specs, async (s) => {
      const name = s?.name;
      if (!name) return { ok: false, error: "spawnAgents: 缺 name" };
      const existed = this.agents.has(name); // 复用场景 (team-room 稳定名) 不占新许可
      let release = null;
      if (!existed) {
        try {
          release = await this.governor.acquire(1, { tag: String(name) });
        } catch (e) {
          return { ok: false, name, error: `配额治理拒绝: ${e.message}` };
        }
      }
      try {
        if (existed) return { ok: true, name, reused: true }; // 复用场景不重 spawn、不占新许可
        this.spawnAgent(name, s.opts || {});
        const entry = this.agents.get(name);
        const onDone = () => { try { release?.(); } catch {} };
        if (entry?.proc) { entry.proc.once("exit", onDone); entry.proc.once("error", onDone); }
        else onDone(); // spawnAgent 已登记失败进程等极端情况: 立即归还
        return { ok: true, name };
      } catch (e) {
        try { release?.(); } catch {}
        return { ok: false, name, error: e.message };
      }
    });
  }

  // 创建一个 agent 子进程 (公开入口: 先试热池接管, 不满足条件走冷启动)
  // v5.0 (P2.1): 热池接管优先 —— 存活热 worker 且请求不带只读 env 时直接换名接管,
  //   免去整段 PPXAgent 冷启动; 数据目录用池槽自己的 (legion/pool-N), 并发隔离不变,
  //   同槽复用串行发生。接管失败/不满足条件走原冷启动路径, 行为兜底不变。
  spawnAgent(name, opts = {}) {
    if (this._poolAdopt(name, opts)) {
      return this.agents.get(name);
    }
    return this._spawnAgentRaw(name, opts);
  }

  // 冷启动主体 (原 spawnAgent 体, 2026-11-06 评估 P1-7 语义保持)
  _spawnAgentRaw(name, { dataDir, globalDataDir, env = {}, cwd = null } = {}) {
    // 2026-11-06 (评估 P1-7): 仅当现存 entry 的进程还活着才复用 —— 旧进程已死但 exit
    //   回调尚未落地时, 旧实现会把"已死 entry"原样返回 (send 恒报"未运行", 变幽灵)。
    //   现允许重 spawn 覆盖死 entry; exit 回调的身份校验保证迟到的旧回调不会误删新登记。
    const existed = this.agents.get(name);
    if (existed && existed.proc && existed.proc.exitCode === null && !existed.proc.signalCode) {
      return existed;
    }
    // 架构优化 ②(2026-11-13): 跨进程血缘 —— 子进程没有父进程的 AsyncLocalStorage,
    //   只能靠 env 把 parentRunId 带过去; 与 src/core/run-context.js 的键名同源。
    const env2 = { ...process.env, ...runEnvForChild("worker"), ...env };
    announceChildRun({ kind: "worker", label: name });
    if (dataDir) env2.PPX_AGENT_DATA_DIR = dataDir;
    // 全局共享目录: 跨 agent 共享经验库 (ANS 全局记忆)
    if (globalDataDir) env2.PPX_AGENT_GLOBAL_DATA_DIR = globalDataDir;
    const proc = spawn(this.nodeBin, [this.workerPath], {
      // 2026-11-16: worktree 隔离时 cwd 指向隔离目录 (worker 以 process.cwd() 为工作区根)
      cwd: cwd || ROOT,
      env: env2,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const entry = { proc, pending: new Map(), counter: 0 };
    this.agents.set(name, entry);

    // 2026-11-16: stdin 的异步 stream error 必须有人接 —— worker 先退出、回收/迟到消息
    // 随后 write 时 EPIPE 不走同步 throw, 没有 error listener 就是宿主 uncaught exception。
    // 处理口径与 proc.on("error") 一致: 拒绝全部 pending, 不吞成"消息已送达"。
    proc.stdin.on("error", (err) => {
      for (const [, { reject }] of entry.pending) reject(new Error(`agent ${name} 写入失败: ${err.message}`));
      entry.pending.clear();
    });

    proc.stdout.setEncoding("utf8");
    const onLine = createLineReader((line) => {
      try {
        const msg = JSON.parse(line);
        // step 中间事件: 触发 onProgress 回调, 不消费 pending (等最终 reply)
        if (msg.type === "step" && msg.id && entry.pending.has(msg.id)) {
          const p = entry.pending.get(msg.id);
          if (p && p.onProgress) { try { p.onProgress(msg); } catch {} }
          return;
        }
        if (msg.id && entry.pending.has(msg.id)) {
          const { resolve, reject } = entry.pending.get(msg.id);
          entry.pending.delete(msg.id);
          if (msg.type === "error") reject(new Error(msg.error));
          else resolve(msg);
        }
      } catch {}
    });
    proc.stdout.on("data", onLine);
    proc.on("error", (err) => {
      // v1.0.8: spawn 失败 (node bin 不存在等) 兜底, 拒绝所有 pending, 防永久挂起
      error(`agent[${name}] 启动失败: ${err.message}`);
      for (const [, { reject }] of entry.pending) reject(new Error(`agent ${name} 启动失败`));
      entry.pending.clear();
      // 2026-11-06 (评估 P1-7): 身份校验后再摘除 —— 旧进程迟到的 exit/error 事件不得
      //   删掉同名的新 entry (kill+respawn 后旧回调仍挂在旧 proc 上)。只清"自己"的登记。
      if (this.agents.get(name) === entry) this.agents.delete(name);
    });
    proc.on("exit", (code) => {
      info(`agent[${name}] 退出 code=${code}`);
      // 拒绝所有 pending
      for (const [, { reject }] of entry.pending) reject(new Error(`agent ${name} 已退出`));
      entry.pending.clear();
      // 2026-11-06 (评估 P1-7): 同上 —— 只摘除仍指向本 entry 的登记, 防幽灵 worker
      if (this.agents.get(name) === entry) this.agents.delete(name);
      this.emit("exit", name, code);
    });
    info(`agent[${name}] 已启动 (pid=${proc.pid})`);
    return entry;
  }

  // ---- Worker 热池 (v5.0 P2.1) ----
  // 预热: 把 poolSize 个常驻 worker 逐个 spawn 出来, ping 确认 boot 完成才算"热"
  //   (worker 进程入口先构造完整 PPXAgent, stdin 早到消息会排队 —— ping 通 = 可干活)。
  //   幂等: 已热的不再补; spawn 失败静默跳过 (池是加速器不是依赖, 失败退冷启动)。
  async warmPool({ globalDataDir } = {}) {
    if (this.poolSize <= 0) return [];
    const warmed = [];
    for (let i = 0; i < this.poolSize; i++) {
      const name = `pool-${i}`;
      const alive = this.agents.get(name);
      if (alive && alive.proc && alive.proc.exitCode === null && !alive.proc.signalCode) {
        if (!this._pool.includes(name)) { this._pool.push(name); this._poolMeta.set(name, { warmedAt: Date.now(), globalDataDir: globalDataDir || null }); }
        warmed.push(name);
        continue;
      }
      try {
        this.spawnAgentCold(name, { globalDataDir });
        const ok = await this._pingUntilWarm(name, 30000);
        if (ok) {
          this._pool.push(name);
          this._poolMeta.set(name, { warmedAt: Date.now(), globalDataDir: globalDataDir || null });
          warmed.push(name);
        }
      } catch { /* 池 worker 起不来: 静默降级为冷启动路径 */ }
    }
    if (this._pool.length) this._poolSweepStart();
    return warmed;
  }

  // 冷启动 (绕过接管逻辑 —— warmPool 自身不能用接管)
  spawnAgentCold(name, opts = {}) {
    return this._spawnAgentRaw(name, opts);
  }
  async _pingUntilWarm(name, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      try {
        await this.send(name, { type: "ping" }, { timeout: 4000 });
        return true;
      } catch {
        if (Date.now() - t0 > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  // 接管判定: 池里有热 worker + 请求不带只读标记 + globalDataDir 与池一致。
  //   接管 = 把 pool-N 的登记换到目标名下 (proc/pending 全部转移), 从池名单摘除。
  _poolAdopt(name, { globalDataDir, env = {}, cwd = null } = {}) {
    if (!this._pool.length) return false;
    if (cwd) return false; // 指定隔离 cwd 的委派不能接管共享池 worker (工作区不同)
    if (env && env.PPX_AGENT_READONLY) return false; // 只读委派不接管 (权限不混用)
    const idx = this._pool.findIndex((n) => {
      const meta = this._poolMeta.get(n);
      return (meta?.globalDataDir || null) === (globalDataDir || null);
    });
    if (idx < 0) return false;
    const poolName = this._pool.splice(idx, 1)[0];
    this._poolMeta.delete(poolName);
    const entry = this.agents.get(poolName);
    if (!entry || !entry.proc || entry.proc.exitCode !== null) return false;
    this.agents.delete(poolName);
    this.agents.set(name, entry);
    this.poolAdopted += 1;
    info(`agent[${name}] 接管热 worker ${poolName} (免冷启动)`);
    this.emit("adopt", name, poolName);
    return true;
  }

  // 空闲回收: 60s 一扫, 超过 TTL (默认 15 分钟, PPX_POOL_TTL_MS 可调) 没被接管的
  //   热 worker 杀掉回收 —— 常驻不等于永驻, 没活干的池不该烧内存。
  _poolSweepStart() {
    if (this._poolSweeper) return;
    const ttl = Math.max(60000, Number(process.env.PPX_POOL_TTL_MS) || 15 * 60 * 1000);
    this._poolSweeper = setInterval(() => {
      const now = Date.now();
      for (const name of [...this._pool]) {
        const meta = this._poolMeta.get(name);
        if (meta && now - meta.warmedAt > ttl) {
          this._pool.splice(this._pool.indexOf(name), 1);
          this._poolMeta.delete(name);
          this.killAgent(name).catch(() => {});
          info(`pool[${name}] 空闲超 TTL, 已回收`);
        }
      }
      if (!this._pool.length && this._poolSweeper) {
        clearInterval(this._poolSweeper);
        this._poolSweeper = null;
      }
    }, 60000);
    if (typeof this._poolSweeper.unref === "function") this._poolSweeper.unref();
  }

  poolStatus() {
    return { size: this.poolSize, warm: this._pool.length, adopted: this.poolAdopted };
  }

  // 向某 agent 发消息, 返回 Promise (onProgress 可选: 接收 step 中间事件)
  // v1.0.8: 超时兜底 (默认 30s), worker 卡死/异常不导致 pending 永久挂起
  send(name, msg, { onProgress, timeout = 30000 } = {}) {
    const entry = this.agents.get(name);
    // 2026-11-16: 进程已死或 stdin 已关时不得再写 —— write 会触发 EPIPE (未被 try 捕获的
    //   异步 stream error), 回收/迟到消息把宿主进程带崩。入口检查先行拒绝。
    if (!entry || entry.proc.exitCode !== null || entry.proc.stdin?.destroyed) {
      return Promise.reject(new Error(`agent ${name} 未运行`));
    }
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
  // 2026-10-24: 返回形状统一为 [{ agent, ok, reply|error }] —— 此前直接展开 worker 回包,
  //   而 mode/legion.js 按 allSettled 形状 ({status,value}) 过滤, 恒判"全部失败"。
  //   现在两种消费方式都兼容: 结果自带 ok 布尔 + reply, 调用方不必再猜形状。
  async broadcast(type, message, { timeout = this.defaultTimeout } = {}) {
    const names = [...this.agents.keys()];
    if (!names.length) throw new Error("军团为空, 先 spawnAgent");
    const results = await this._mapBounded(
      names,
      (n) => this.send(n, { type, message }, { timeout }).then(
        (r) => ({ ok: true, ...r }),
        (e) => ({ ok: false, type: "error", error: e.message })
      )
    );
    return names.map((n, i) => ({ agent: n, ...results[i] }));
  }

  // 按角色分工: 把任务列表分给不同 agent
  // 2026-10-02: 串行 → 有界并行 (_mapBounded 背压, 同 broadcast/runDag 共享 maxConcurrent 口)
  async dispatch(type, tasks, { timeout = this.defaultTimeout } = {}) {
    const names = [...this.agents.keys()];
    if (!names.length) throw new Error("军团为空, 先 spawnAgent");
    return this._mapBounded(tasks, (task, i) => {
      const name = names[i % names.length];
      return this.send(name, { type, message: task }, { timeout })
        .then((r) => ({ agent: name, task, ...r }))
        .catch((e) => ({ agent: name, task, type: "error", error: e.message }));
    });
  }

  // DAG 任务编排: 按依赖拓扑分层执行, 同层并行, 上游结果传入下游 (P3)
  // graph = { nodes: [{ id, task, dependsOn?: [id], agent?: name }] }
  // 返回 { results: {id: reply}, order: [执行顺序] }
  async runDag(graph, { timeout = this.defaultTimeout } = {}) {
    const names = [...this.agents.keys()];
    if (!names.length) throw new Error("军团为空, 先 spawnAgent");
    let rr = 0; // round-robin 派发未指定 agent 的节点
    return runDag(graph, async (id, node, deps) => {
      const agent = node.agent || names[rr++ % names.length];
      const depText = Object.entries(deps)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 500)}`)
        .join("\n");
      const message = node.task + (depText ? "\n\n[上游结果]\n" + depText : "");
      const r = await this.send(agent, { type: "chat", message }, { timeout });
      return r.reply;
    }, { concurrency: this.maxConcurrent });
  }

  // 关闭所有 agent
  // v1.0.8: 先发 shutdown 优雅退出, 300ms 后兜底 kill 仍存活进程 (worker 无响应/卡死时不残留)
  // 2026-10-10 (L2): 返回 Promise —— 调用方 (agent.shutdown) 需 await 到全部回收完成再 exit,
  //   否则进程可能在子 worker 收尾前退出, 留下孤儿进程。
  async shutdownAll() {
    const tasks = [...this.agents].map(([name]) => this.killAgent(name));
    await Promise.allSettled(tasks);
  }

  // 回收单个 agent (2026-10-10, L1): 优雅 shutdown → 短超时兜底 kill → 摘除登记。
  //   幂等: 对不存在/已回收的名字返回 false。返回 Promise<boolean> 以支持 spawn_agent 的
  //   finally 块逐轮回收 (异常分支也要走到 —— 不靠成功分支)。
  async killAgent(name) {
    const entry = this.agents.get(name);
    if (!entry) return false;
    const proc = entry.proc;
    const waitExit = new Promise((resolve) => {
      if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
      proc.once("exit", () => resolve());
    });
    // 先发 shutdown (需登记在场), 再摘除登记 —— 避免回收过程中的并发 send 又落到它头上
    try { this.send(name, { type: "shutdown" }).catch(() => {}); } catch { /* 进程可能已死 */ }
    this.agents.delete(name);
    // 优雅退出窗口: 给 worker 300ms 收尾; 超时则强杀, 并等到真正 exit 再返回 ——
    //   resolve 之后调用方可能立刻 process.exit (agent.shutdown), 不能留下"正在死"的孤儿。
    if (!(await waitForExit(waitExit, EXIT_GRACE_MS))) {
      try { proc.kill(); } catch { /* 已退出 */ }
      if (!(await waitForExit(waitExit, EXIT_FORCE_MS))) {
        try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
        await waitForExit(waitExit, EXIT_AFTER_KILL_MS);
      }
    }
    // 清掉该 agent 上挂着的 pending 请求, 避免调用方永久挂起
    for (const [, p] of entry.pending || []) {
      try { p.reject?.(new Error(`agent ${name} 已回收`)); } catch { /* 已 settle */ }
    }
    entry.pending?.clear?.();
    return true;
  }

  list() {
    return [...this.agents.keys()].map((n) => ({ name: n, pid: this.agents.get(n).proc.pid }));
  }
}