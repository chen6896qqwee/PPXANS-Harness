// src/utils/store.js - 零依赖文件存储 (JSON + 原子写)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
// 2026-10-05 (同步 src): 独立版刻意不依赖主项目 utils/logger.js (不在扁平化范围内),
// debug 降级为空操作 (自愈技能里日志噪声无意义), warn 降级为 console.warn。
const debug = () => {};
const warn = (...a) => console.warn(...a);

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
        try { fs.unlinkSync(tmp); } catch {}
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
    // 注意: 此处**不动文件** (不自作主张改名/删除) —— healer 对损坏文件有自己的备份恢复契约
    // (把 facts.json 改名为 .corrupt-<ts> 后重建), 低层 readJson 若抢先把文件改名会破坏该契约。
    warn(`[utils/store] JSON 解析失败, 返回 fallback (文件保留): ${file} (${e && e.message ? e.message : e})`);
    return fallback;
  }
}

// 带信号的 readJson: 供"读-改-写"型存储区分「文件不存在」与「文件损坏」。
// 损坏时 (parseFailed=true) 调用方必须避免立即用 fallback 覆盖回写 —— 文件原地保留, 交给 healer/人工恢复。
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
// v2026-10-05 (F6): fn **必须是同步函数** —— async 回调会被当场拒绝 (抛 TypeError),
//   因为同步锁无法跨 await 持有; 详见下方 _assertSyncFn 注释。
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
// ---- v2026-10-05 (F6): 临界区回调必须是同步函数 (硬性拒绝异步) ----
// 本锁是**同步**锁: 锁文件在 fn() 返回的那一刻就释放 (finally)。若 fn 是 async 函数, 它返回的
// 只是一个"刚开始执行"的 Promise —— 控制权在函数体内**第一个 await** 处就交回事件循环, 而那时
// 临界区远未结束。于是锁在最需要它的地方静默失效: 两个进程各自"持锁"交错做同一批读-改-写,
// 后写的那一份用基于过期状态的整文件覆盖前一份。
// 取舍: 与其假装持锁, 不如当场拒绝。AsyncFunction 在**取锁之前**就抛错 (回调一次都不会被执行);
// 同步函数返回 thenable 的情况只能事后判定 (它的同步前半段已跑过), 同样抛错并说清互斥已失效。
function _isThenable(v) {
  return !!v && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";
}
function _asyncLockError(api, file, what) {
  return new TypeError(`${api}: ${file} 的临界区回调返回了${what} —— 这把锁只能同步持有, `
    + `fn() 一返回锁就释放, 互斥在 await 之后形同虚设 (正是这一类 bug 造成过记忆数据被覆盖)。`
    + " 请把读-改-写与原子落盘全部改成同步实现 (fs.readFileSync + atomicWrite/writeJson), "
    + "需要 await 的部分 (网络/LLM/向量化) 挪到 withFileLock 之外, 锁内只做同步落盘。");
}
// 取锁前调用: 非函数 / async 函数直接抛错 (fn 一次都不执行, 也不留下锁文件)
function _assertSyncFn(api, file, fn) {
  if (typeof fn !== "function") {
    throw new TypeError(`${api}: fn 必须是同步函数, 收到 ${fn === null ? "null" : typeof fn}: ${file}`);
  }
  if (Object.prototype.toString.call(fn) === "[object AsyncFunction]") {
    throw _asyncLockError(api, file, " async 函数 (其函数体从未执行)");
  }
}
// 持锁中调用: 返回值是 thenable 则抛错 (由调用方 finally 正常释放锁)
function _callSyncFn(api, file, fn) {
  const r = fn();
  if (_isThenable(r)) throw _asyncLockError(api, file, "一个 Promise");
  return r;
}
export function withFileLock(file, fn, { timeoutMs = 3000, pollMs = 20, staleMs = 15000 } = {}) {
  _assertSyncFn("withFileLock", file, fn);
  const lock = file + ".lock";
  const acquire = () => {
    try {
      const fd = fs.openSync(lock, "wx"); // 'wx': 已存在则抛错 (原子)
      try { fs.writeSync(fd, `${process.pid}:${Date.now()}`); } catch {}
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
      try { fs.rmSync(lock, { force: true }); } catch {} // 陈旧锁强取
      if (!acquire()) throw new Error("文件锁获取超时: " + lock);
      break;
    }
    _syncSleep(pollMs);
  }
  try {
    return _callSyncFn("withFileLock", file, fn);
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch {}
  }
}

// 同时持有多把文件锁 (v2026-10-05): 会话按天分片的跨文件 seq 判定用。
// 关键: 先去重再按**路径升序**嵌套获取 —— 所有调用方共用同一全序, 因此不会互相死锁,
// 同一路径也不会被自己锁两次 (withFileLock 的自进程残留判定会"抢"自己的锁, 提前释放)。
// 常见情形只有一个文件 (当天分片), 此时与单次 withFileLock 开销完全一致。
// v2026-10-05 (F6): 与 withFileLock 同一条异步禁令 —— 叶子回调同样必须在锁内全程同步;
// 空文件列表时 fn 会在**无锁**状态下执行, 所以这里独立断言一次, 保证拒绝与文件个数无关。
export function withFileLocks(files, fn, opts) {
  const list = [...new Set((files || []).filter(Boolean))].sort();
  const label = `[${list.join(", ")}]`; // 错误信息用: 一次成型, 不在每层递归里重算
  _assertSyncFn("withFileLocks", label, fn);
  const step = (i) => (i >= list.length
    ? _callSyncFn("withFileLocks", label, fn)
    : withFileLock(list[i], () => step(i + 1), opts));
  return step(0);
}

// ---- 带锁的 JSON 集合存储 (2026-10-10, 同步 src) ----
// 供"多进程共写"的 JSON 数组文件使用: 取锁 → 锁内重读 → 与内存态按 id 并集 → 原子全量写。
// 注意: 锁内不得 await (mutate 必须同步), 否则互斥形同虚设。
export function mutateJsonCollection(file, fallback, mutate, { warnTag = "store", memory = null, idKey = "id" } = {}) {
  let corrupted = null;
  let data = [];
  const run = () => {
    const g = readJsonGuarded(file, null);
    let disk;
    if (g.parseFailed && g.existedBefore) {
      corrupted = archiveCorrupt(file);
      disk = fallback();
    } else {
      disk = Array.isArray(g.data) ? g.data : fallback();
    }
    data = memory ? unionById(disk, memory, idKey) : disk;
    const next = mutate(data);
    if (Array.isArray(next)) data = next;
    writeJson(file, data);
  };
  try {
    withFileLock(file, run);
    return { ok: true, data, corrupted };
  } catch (e) {
    console.log(`[warn] [${warnTag}] 落盘失败 (内存态保留, 下次写入补齐): ${file} (${e && e.message ? e.message : e})`);
    return { ok: false, data, error: e, corrupted };
  }
}

// 按 id 做并集: primary 顺序优先, secondary 中未出现过的追加到尾部。
export function unionById(primary, secondary, idKey = "id") {
  const out = Array.isArray(primary) ? [...primary] : [];
  const seen = new Set(out.map((x) => (x ? x[idKey] : undefined)));
  for (const x of (Array.isArray(secondary) ? secondary : [])) {
    if (!x) continue;
    const k = x[idKey];
    if (k != null && seen.has(k)) continue;
    if (k != null) seen.add(k);
    out.push(x);
  }
  return out;
}

// 把损坏文件改名留档 .corrupt-<ts>; 已有存档时不覆盖 (两次损坏各留一份)。
export function archiveCorrupt(file) {
  try {
    if (!fs.existsSync(file)) return null;
    let dest = `${file}.corrupt-${Date.now()}`;
    let n = 0;
    while (fs.existsSync(dest)) dest = `${file}.corrupt-${Date.now()}-${++n}`;
    fs.renameSync(file, dest);
    return dest;
  } catch {
    return null;
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

// 追加写 (v3.2.3, 同步 src): 供长期累积型文件使用。原实现 readText 全量读 + 拼接 + 全量重写,
// 文件越大每轮成本越高 (O(N) 每次 → 长期累积整体 O(N²)); 追加写把单次降为 O(新增字节)。
export function appendText(file, text) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, String(text == null ? "" : text), "utf8");
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
