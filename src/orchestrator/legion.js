// src/orchestrator/legion.js - Agent 军团编排器
// 管理多个独立 agent 子进程, 支持并行派发任务、按角色分工
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { info, warn, error } from "../utils/logger.js";
import { runDag } from "./dag.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER = path.join(ROOT, "src", "orchestrator", "agent-worker.js");

export class Legion extends EventEmitter {
  constructor({ workerPath = WORKER, nodeBin = process.execPath, maxConcurrent = 8 } = {}) {
    super();
    this.workerPath = workerPath;
    this.nodeBin = nodeBin;
    this.maxConcurrent = maxConcurrent; // 军团整体并发上限: 防止大 DAG/广播瞬间 spawn 海量子进程
    this.agents = new Map(); // { name: { proc, pending: Map<id,{resolve,reject}>, counter } }
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

  // 创建一个 agent 子进程
  spawnAgent(name, { dataDir, globalDataDir, env = {} } = {}) {
    if (this.agents.has(name)) return this.agents.get(name);
    const env2 = { ...process.env, ...env };
    if (dataDir) env2.PPX_AGENT_DATA_DIR = dataDir;
    // 全局共享目录: 跨 agent 共享经验库 (ANS 全局记忆)
    if (globalDataDir) env2.PPX_AGENT_GLOBAL_DATA_DIR = globalDataDir;
    const proc = spawn(this.nodeBin, [this.workerPath], {
      cwd: ROOT,
      env: env2,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const entry = { proc, pending: new Map(), counter: 0 };
    this.agents.set(name, entry);

    proc.stdout.setEncoding("utf8");
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          // step 中间事件: 触发 onProgress 回调, 不消费 pending (等最终 reply)
          if (msg.type === "step" && msg.id && entry.pending.has(msg.id)) {
            const p = entry.pending.get(msg.id);
            if (p && p.onProgress) { try { p.onProgress(msg); } catch {} }
            continue;
          }
          if (msg.id && entry.pending.has(msg.id)) {
            const { resolve, reject } = entry.pending.get(msg.id);
            entry.pending.delete(msg.id);
            if (msg.type === "error") reject(new Error(msg.error));
            else resolve(msg);
          }
        } catch {}
      }
    });
    proc.on("error", (err) => {
      // v1.0.8: spawn 失败 (node bin 不存在等) 兜底, 拒绝所有 pending, 防永久挂起
      error(`agent[${name}] 启动失败: ${err.message}`);
      for (const [, { reject }] of entry.pending) reject(new Error(`agent ${name} 启动失败`));
      entry.pending.clear();
      this.agents.delete(name);
    });
    proc.on("exit", (code) => {
      info(`agent[${name}] 退出 code=${code}`);
      // 拒绝所有 pending
      for (const [, { reject }] of entry.pending) reject(new Error(`agent ${name} 已退出`));
      entry.pending.clear();
      this.agents.delete(name);
      this.emit("exit", name, code);
    });
    info(`agent[${name}] 已启动 (pid=${proc.pid})`);
    return entry;
  }

  // 向某 agent 发消息, 返回 Promise (onProgress 可选: 接收 step 中间事件)
  // v1.0.8: 超时兜底 (默认 30s), worker 卡死/异常不导致 pending 永久挂起
  send(name, msg, { onProgress, timeout = 30000 } = {}) {
    const entry = this.agents.get(name);
    if (!entry || entry.proc.exitCode !== null) {
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
        entry.proc.stdin.write(JSON.stringify({ id, ...msg }) + "\n");
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
  // ⚠️ 实验性 API: 生产代码无内置消费方 (详见 docs/ARCHITECTURE.md)。仅供在交互场景/测试里手动调用。
  // 逐条串行派发, 吞吐低但稳定; 若需高并发的角色分工, 优先用 runDag。
  async dispatch(type, tasks) {
    const names = [...this.agents.keys()];
    const results = [];
    for (let i = 0; i < tasks.length; i++) {
      const name = names[i % names.length];
      try {
        const r = await this.send(name, { type, message: tasks[i] });
        results.push({ agent: name, task: tasks[i], ...r });
      } catch (e) {
        results.push({ agent: name, task: tasks[i], type: "error", error: e.message });
      }
    }
    return results;
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
      try { this.send(name, { type: "shutdown" }).catch(() => {}); } catch {}
    }
    // 等待退出
    await new Promise((r) => setTimeout(r, 300));
    for (const [name, entry] of [...this.agents]) {
      try { entry.proc.kill(); } catch {}
    }
  }

  list() {
    return [...this.agents.keys()].map((n) => ({ name: n, pid: this.agents.get(n).proc.pid }));
  }
}