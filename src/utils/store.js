// src/utils/store.js - 零依赖文件存储 (JSON + 原子写)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  atomicWrite(file, JSON.stringify(obj, null, 2));
}

// 简单跨进程文件锁 (零依赖, 同步): 原子创建 .lock 文件, 临界区内执行 fn, finally 释放
// 用于跨 agent 共享文件的"读-改-写"临界区 (防并发覆盖, 如共享经验库)
// 锁是同步 busy-wait (低频写场景可接受); 超时视为陈旧锁 (崩溃残留) 强取
export function withFileLock(file, fn, { timeoutMs = 3000, pollMs = 20 } = {}) {
  const lock = file + ".lock";
  const acquire = () => {
    try {
      const fd = fs.openSync(lock, "wx"); // 'wx': 已存在则抛错 (原子)
      try { fs.writeSync(fd, String(process.pid)); } catch {}
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  const start = Date.now();
  while (!acquire()) {
    if (Date.now() - start > timeoutMs) {
      try { fs.rmSync(lock, { force: true }); } catch {} // 陈旧锁强取
      if (!acquire()) throw new Error("文件锁获取超时: " + lock);
      break;
    }
    const end = Date.now() + pollMs;
    while (Date.now() < end) {} // 同步短暂等待
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch {}
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
