// src/orchestrator/quota-file.js - 跨进程并发配额账本 (零依赖)
//
// 为什么需要它 (2026-10-07 评估报告 P0-3):
//   ConcurrencyGovernor 是**进程级单例**, 而子 agent 是真子进程 —— `Legion.spawnAgent` 走的是
//   `spawn(process.execPath, [agent-worker.js])`。主进程把 limit 设成 8, 只意味着"这一个进程
//   最多派 8 个", 而每个子进程若自己也派活 (嵌套委派), 各持一份 8 的额度: 三层嵌套机器上是
//   8×8 而不是 8。治理器在单进程内做得再严谨, 也管不到隔壁进程号。
//
// 做法: 把"机器上同时在跑多少个子 agent"写成一份共享账本, 用 utils/store.withFileLock 的
//   原子创建锁 ('wx') 串行化读写。每个进程只登记自己的 pid → 名额数, 读的时候顺手回收死 pid。
//
// 设计取舍 (都是刻意的选择, 不是省事):
//   1) **同步 API**。withFileLock 的 fn 必须同步, 而 governor.acquire 的热路径也是同步的
//      (tryAcquire 要能在不阻塞事件循环时判定)。所以整个模块不发 Promise。
//   2) **fail-open**。锁抢不到 / 账本损坏 / 磁盘只读 → 返回 null 并计 unavailable, 调用方按
//      "本进程软约束"继续跑, 而不是让一次文件 IO 故障把整个委派链路打挂。这与项目既有的
//      fail-open 钩子栅栏同哲学: 配额是治理手段, 不该变成新的单点故障。失败必须**可见**
//      (stats.unavailable + warn 日志), 不许静默。
//   3) **死 pid 回收靠 process.kill(pid, 0)**。子进程被 kill -9 时没有机会归还名额, 账本会泄漏。
//      读账本时对每个 pid 探活, 死了就把它的名额清掉。这是唯一不需要心跳的方案
//      (心跳要额外的定时器与清理器, 而这里只有"读账本"这一个时机需要准确)。
//   4) **默认关闭**。单进程是绝大多数场景, 无谓的文件锁只会拖慢委派。由
//      `agent.legion.cross_process_quota` 显式开启, 或在 spawn 子进程前由 legion 传入。

import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../utils/store.js";
import { ensureDir } from "../utils/store.js";
import { warn, debug } from "../utils/logger.js";

// pid 存活探测: signal 0 只测存在性, 不发信号。
// 非子进程也能测 (Node 在 Windows 上同样支持), 这正是我们要的 —— 子 agent 是独立进程树。
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // ESRCH = 进程不存在; EPERM = 存在但无权限 (同样视为活着, 不能当死 pid 清掉)
    return e && e.code === "EPERM";
  }
}

const DEFAULT_FILE = "legion-quota.json";

export class CrossProcessQuota {
  /**
   * @param {string} file 账本文件路径 (一般为 <dataDir>/legion-quota.json)
   * @param {{limit?:number, lockTimeoutMs?:number}} opts
   */
  constructor(file, { limit = 8, lockTimeoutMs = 2000 } = {}) {
    this.file = file;
    this.limit = Math.max(1, Math.floor(Number(limit) || 8));
    this.lockTimeoutMs = lockTimeoutMs;
    this.unavailable = 0;  // IO/锁失败次数 (fail-open 计数, 必须对外可见)
    this.reaped = 0;       // 累计回收的死 pid 条目数
    this.lastError = null;
  }

  static inDir(dataDir, opts) {
    return new CrossProcessQuota(path.join(dataDir, DEFAULT_FILE), opts);
  }

  // ---- 账本读写 (必须在锁内) ----
  _read() {
    try {
      if (!fs.existsSync(this.file)) return { v: 1, holders: {} };
      const raw = fs.readFileSync(this.file, "utf8");
      const j = JSON.parse(raw);
      if (!j || typeof j !== "object" || !j.holders || typeof j.holders !== "object") return { v: 1, holders: {} };
      return j;
    } catch (e) {
      // 账本损坏 (半写 / 手改): 当作空账本重建。宁可短暂超发, 也不要卡死整个委派链
      debug(`[quota-file] 账本不可解析, 已按空账本重建: ${e && e.message ? e.message : e}`);
      return { v: 1, holders: {} };
    }
  }

  _write(j) {
    ensureDir(path.dirname(this.file));
    // 先写临时文件再 rename: 避免读到半写状态 (Windows 上 rename 覆盖是原子的)
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j), "utf8");
    fs.renameSync(tmp, this.file);
  }

  // 回收死进程留下的名额 (只在锁内调用)
  _reap(holders) {
    const out = {};
    let reaped = 0;
    for (const [pid, rec] of Object.entries(holders || {})) {
      const n = Number(rec && rec.n);
      if (!Number.isFinite(n) || n <= 0) { reaped++; continue; }
      if (!pidAlive(pid)) { reaped++; continue; } // 进程已死: 名额作废
      out[pid] = { n, ts: rec.ts || Date.now() };
    }
    if (reaped) this.reaped += reaped;
    return out;
  }

  _total(holders) {
    let t = 0;
    for (const rec of Object.values(holders || {})) t += Number(rec?.n) || 0;
    return t;
  }

  /** 当前账本快照 (会顺手回收死 pid, 但保证不小于自身持有的量) */
  stats() {
    try {
      return this._locked((j) => {
        const holders = this._reap(j.holders);
        return { limit: this.limit, total: this._total(holders), holders, unavailable: this.unavailable, reaped: this.reaped };
      });
    } catch (e) {
      return { limit: this.limit, total: -1, holders: {}, unavailable: this.unavailable, reaped: this.reaped, error: String(e?.message || e) };
    }
  }

  _locked(fn) {
    let result;
    try {
      withFileLock(this.file, () => { result = fn(this._read()); }, { timeoutMs: this.lockTimeoutMs });
    } catch (e) {
      this.unavailable += 1;
      this.lastError = String(e?.message || e);
      warn(`[quota-file] 共享账本不可用 (${this.lastError}) —— 本次按 fail-open 降级为单进程配额`);
      throw e;
    }
    return result;
  }

  /**
   * 申请 n 个跨进程名额。
   * @returns {(() => boolean)|null} 归还函数 (幂等) 或 null
   *   null 有两种含义, 调用方必须区分:
   *     - 名额真的满了   → 应该排队/拒绝
   *     - 账本不可用     → fail-open, 按单进程软约束放行 (见 unavailable 计数)
   */
  tryAcquire(n = 1) {
    const want = Math.max(1, Math.min(Math.floor(Number(n) || 1), this.limit));
    try {
      const got = this._locked((j) => {
        const holders = this._reap(j.holders);
        const total = this._total(holders);
        if (total + want > this.limit) {
          this._write({ v: 1, holders }); // 把回收结果落盘, 别让死 pid 一直占位
          return false;
        }
        const key = String(process.pid);
        const cur = holders[key] ? Number(holders[key].n) || 0 : 0;
        holders[key] = { n: cur + want, ts: Date.now() };
        this._write({ v: 1, holders });
        return true;
      });
      if (!got) return null;
    } catch {
      return null; // fail-open: 由调用方看 this.unavailable 判断性质
    }

    const self = this;
    let released = false;
    return function releaseCross() {
      if (released) return false;
      released = true;
      try {
        self._locked((j) => {
          const holders = self._reap(j.holders);
          const key = String(process.pid);
          const cur = holders[key] ? Number(holders[key].n) || 0 : 0;
          const next = cur - want;
          if (next > 0) holders[key] = { n: next, ts: Date.now() };
          else delete holders[key];
          self._write({ v: 1, holders });
        });
      } catch (e) {
        debug(`[quota-file] 归还失败 (已忽略, 死 pid 回收会兜住): ${e?.message || e}`);
      }
      return true;
    };
  }

  /** 清空账本 (测试/重置用) */
  reset() {
    try {
      this._locked(() => { this._write({ v: 1, holders: {} }); });
      return true;
    } catch {
      return false;
    }
  }
}

export default { CrossProcessQuota, pidAlive };
