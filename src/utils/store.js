// src/utils/store.js - 零依赖文件存储 (JSON + 原子写)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { debug, warn } from "../utils/logger.js";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, data, "utf8");
  // v1.0.8: rename 覆盖已存在文件在 Windows 并发下可能 EPERM/EEXIST (短窗口), 重试 3 次;
  // 不再降级为非原子直接写 (并发双写可交错损坏文件), 重试仍失败则抛错由调用方处理
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 2) {
        try { fs.unlinkSync(tmp); } catch (e) { debug(`[utils/store] 已忽略异常: ${e && e.message ? e.message : e}`); }
        throw new Error(`原子写失败: ${file} (${e.message})`);
      }
      const end = Date.now() + 30;
      while (Date.now() < end) {} // 短延迟后重试
    }
  }
}

export function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    let raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // 去 BOM
    return JSON.parse(raw);
  } catch (e) {
    // v3.0.1 (P0#1): 解析失败不再完全静默 —— 至少留一条 warn。
    // 注意: 此处**不动文件** (不自作主张改名/删除) —— healer 等组件对损坏文件
    // 有自己的备份恢复契约 (如 healer.js 把 facts.json 改名为 .corrupt-<ts> 后重建),
    // 低层 readJson 若抢先把文件改名会破坏该契约 (实测把 selfheal-bench 炸出 ENOENT)。
    warn(`[utils/store] JSON 解析失败, 返回 fallback (文件保留): ${file} (${e && e.message ? e.message : e})`);
    return fallback;
  }
}

// 带信号的 readJson: 供"读-改-写"型存储 (如 FactStore) 区分「文件不存在」与「文件损坏」。
// 损坏时 (parseFailed=true) 调用方必须避免立即用 fallback 覆盖回写 —— 文件原地保留,
// 交给 healer / 人工恢复。非破坏式: 本函数同样不改名不删除。
export function readJsonGuarded(file, fallback = null) {
  const existedBefore = fs.existsSync(file);
  if (!existedBefore) return { data: fallback, existedBefore: false, parseFailed: false };
  try {
    let raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return { data: JSON.parse(raw), existedBefore: true, parseFailed: false };
  } catch (e) {
    warn(`[utils/store] JSON 损坏 (文件保留待恢复): ${file} (${e && e.message ? e.message : e})`);
    return { data: fallback, existedBefore: true, parseFailed: true };
  }
}

export function writeJson(file, obj) {
  atomicWrite(file, JSON.stringify(obj, null, 2));
}

// 简单跨进程文件锁 (零依赖, 同步): 原子创建 .lock 文件, 临界区内执行 fn, finally 释放
// 用于跨 agent 共享文件的"读-改-写"临界区 (防并发覆盖, 如共享经验库)
// v3.0.1 (P1#5) 两处修复:
//   ① 锁文件写 "pid:ts", 超时后先判持有者存活 —— 活进程持锁时不许抢 (原实现无脑强删锁文件,
//      持有者还在临界区就出现双写, 互斥被破坏 → 数据交错损坏); 死进程/超长持有/自进程残留才强取。
//   ② 等待用 Atomics.wait (OS 级阻塞, 零 CPU), 替代原自旋空转 (20ms×150 轮纯烧 CPU 且卡事件循环)。
const _sleepArr = new Int32Array(new SharedArrayBuffer(4));
function _syncSleep(ms) {
  try { Atomics.wait(_sleepArr, 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end) {} }
}
function _pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; } // EPERM=存在但无权限
}
export function withFileLock(file, fn, { timeoutMs = 3000, pollMs = 20, staleMs = 15000 } = {}) {
  const lock = file + ".lock";
  const acquire = () => {
    try {
      const fd = fs.openSync(lock, "wx"); // 'wx': 已存在则抛错 (原子)
      try { fs.writeSync(fd, `${process.pid}:${Date.now()}`); } catch (e) { debug(`[utils/store] 已忽略异常: ${e && e.message ? e.message : e}`); }
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  // 陈旧锁判定 (v3.0.1 P1#5): 持有者进程已死 / 锁超长持有 / 自进程残留 → 可抢; 活跃进程持有 → 不可抢
  const canSteal = () => {
    try {
      const raw = fs.readFileSync(lock, "utf8").trim();
      const m = /^(\d+):(\d+)$/.exec(raw);
      if (m) {
        const pid = Number(m[1]);
        if (pid === process.pid) return true;                       // 自进程残留
        if (!_pidAlive(pid)) return true;                           // 持有者已死 (崩溃残留)
        if (Date.now() - Number(m[2]) > staleMs) return true;       // 超长持有视为陈旧 (防 pid 复用误判)
        return false;                                               // 活跃进程持锁: 不抢
      }
      // 兼容旧格式 (纯 pid) / 无法解析: 按 mtime 与 pid 存活判
      const legacyPid = parseInt(raw, 10);
      if (Number.isFinite(legacyPid) && legacyPid !== process.pid && !_pidAlive(legacyPid)) return true;
      const st = fs.statSync(lock);
      return Date.now() - st.mtimeMs > staleMs;
    } catch {
      return true; // 锁文件刚被释放/读不到 → 直接尝试抢
    }
  };
  const start = Date.now();
  while (!acquire()) {
    if (Date.now() - start > timeoutMs) {
      // v3.0.1 (P1#5): 活跃进程持锁 → 抛错而非抢锁 (宁可失败不可双写损坏)
      if (!canSteal()) throw new Error(`文件锁被活跃进程持有, 等待 ${timeoutMs}ms 后放弃: ` + lock);
      try { fs.rmSync(lock, { force: true }); } catch (e) { debug(`[utils/store] 已忽略异常: ${e && e.message ? e.message : e}`); } // 陈旧锁强取
      if (!acquire()) throw new Error("文件锁获取超时: " + lock);
      break;
    }
    _syncSleep(pollMs);
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch (e) { debug(`[utils/store] 已忽略异常: ${e && e.message ? e.message : e}`); }
  }
}

export function readText(file, fallback = "") {
  try {
    if (!fs.existsSync(file)) return fallback;
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

export function writeText(file, text) {
  atomicWrite(file, text);
}

export function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line + "\n", "utf8");
}

export function nowISO() {
  return new Date().toISOString();
}

export function logicalDay(d = new Date()) {
  // 逻辑日 (本地时区): 今日/归档/按天检索统一用本地年月日
  // 与 eventsByDay() 的本地解析保持一致, 避免 8 小时时区偏移导致按天检索错位
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 按逻辑日切分 JSONL 的日志目录 (工具轨迹 utils/trace.js 与事件流 core/trace.js 共用)。
// 两个写入器必须落在同一目录, 用同一函数取路径可避免字面量各写一份后悄悄漂移。
export function logsDir(dataDir, sub = "traces") {
  const dir = path.join(dataDir, "logs", sub);
  ensureDir(dir);
  return dir;
}
