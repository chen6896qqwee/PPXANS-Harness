// src/tools/sandbox-worker.js - 沙箱工作线程 (配合 sandbox.js)
// worker 隔离 = 第一层边界 (独立线程, 可强杀); node:vm 新上下文 = 第二层 (裁剪全局)。
// 沙箱内**没有** require/import/process/fetch/fs —— 纯计算用途。
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

const logs = [];
const fmt = (v) => {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};
const push = (level) => (...args) => logs.push(`[${level}] ` + args.map(fmt).join(" "));

const sandboxConsole = { log: push("log"), info: push("info"), warn: push("warn"), error: push("error") };

// 裁剪过的全局: 纯计算可用, 无 IO / 网络 / 时器 / 模块加载
const sandbox = {
  console: sandboxConsole,
  Math, JSON, Date, RegExp, Error, TypeError, RangeError, SyntaxError,
  Array, Object, String, Number, Boolean, Symbol, BigInt, Map, Set, WeakMap, WeakSet,
  Promise, isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  structuredClone, NaN, Infinity, undefined,
};
sandbox.globalThis = sandbox;

const timeoutMs = Math.min(Number(workerData?.timeoutMs) || 3000, 10000);
try {
  const result = vm.runInNewContext(String(workerData?.code || ""), sandbox, {
    timeout: timeoutMs,          // 同步代码超时 (vm 层)
    displayErrors: true,
  });
  let out;
  if (typeof result === "bigint") out = String(result);
  else if (typeof result === "function" || (typeof result === "object" && result !== null)) {
    try { out = JSON.parse(JSON.stringify(result)); } catch { out = String(result); }
  } else out = result;
  parentPort.postMessage({ ok: true, result: out, logs });
} catch (e) {
  parentPort.postMessage({ ok: false, error: `${e.name}: ${e.message}`, logs });
}
