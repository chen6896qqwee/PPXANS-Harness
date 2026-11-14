// src/tools/sandbox-worker.js - 沙箱工作线程 (配合 sandbox.js)
// worker 隔离 = 第一层边界 (独立线程, 可强杀); node:vm 新上下文 = 第二层 (纯计算上下文)。
// 沙箱内**没有** require/import/process/fetch/fs —— 纯计算用途。
//
// realm 隔离铁律 (2026-10-04 安全复审): 绝不把宿主 realm 的对象注入上下文。
// 旧实现把宿主的 Math/JSON/Promise/Object/console 塞进 sandbox 字面量, 沙箱代码可经
// `Promise.resolve().constructor.constructor("return process")()` 跳回宿主 realm,
// 拿到宿主 process → 读尽环境变量、经 process.binding("fs") 任意读写文件。
// 现在: 上下文由 V8 自建 intrinsics (自己的 Object/Promise/Function), 宿主不递任何对象;
// console 与日志缓冲也在上下文内部定义, 宿主只通过上下文内的打包函数取"值语义"的字符串结果。
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

const timeoutMs = Math.min(Number(workerData?.timeoutMs) || 3000, 10000);

// 空上下文: V8 为新上下文生成全套 intrinsics, 与宿主 realm 无任何原型链通路。
// 关键: 沙箱对象必须是 **无原型** 的 —— vm.createContext({}) 里 {} 带宿主 Object.prototype,
// 上下文代码的 `globalThis.constructor` 会先在沙箱对象上命中 (代理转发到 target), 拿到的就是
// **宿主 realm 的 Object** → `globalThis.constructor.constructor("return process")()` 直接跳回
// 宿主 (实测可读 process.env 全量密钥)。Object.create(null) 切断这条通路: constructor 只能
// 落到新上下文自己的 Object.prototype。
const context = vm.createContext(Object.create(null));

// 上下文内自建的 console + 日志缓冲 + 结果打包器。
// __pack/__dumpLogs 由宿主调用 (传值不传宿主对象), 返回值是纯字符串 → 无 realm 通路。
vm.runInContext(
  `var __logs = [];
   function __fmt(v) {
     if (typeof v === "string") return v;
     if (typeof v === "bigint") return String(v);
     try { return JSON.stringify(v) ?? String(v); } catch (e) { return String(v); }
   }
   var console = {
     log: function () { __logs.push("[log] " + Array.prototype.map.call(arguments, __fmt).join(" ")); },
     info: function () { __logs.push("[info] " + Array.prototype.map.call(arguments, __fmt).join(" ")); },
     warn: function () { __logs.push("[warn] " + Array.prototype.map.call(arguments, __fmt).join(" ")); },
     error: function () { __logs.push("[error] " + Array.prototype.map.call(arguments, __fmt).join(" ")); },
   };
   var __pack = function (v) {
     // 沙箱不泵事件循环: 返回 thenable 会被序列化成 {} 让模型误判成功, 显式判读
     if (v && (typeof v === "object" || typeof v === "function") && typeof v.then === "function") {
       return JSON.stringify({ async: true, result: null, logs: __logs });
     }
     try { return JSON.stringify({ result: v, logs: __logs }); }
     catch (e) { return JSON.stringify({ result: String(v), logs: __logs }); }
   };
   var __dumpLogs = function () { return JSON.stringify(__logs); };`,
  context,
  { timeout: 1000, displayErrors: true }
);

try {
  const value = vm.runInContext(String(workerData?.code || ""), context, {
    timeout: timeoutMs, // 同步代码超时 (vm 层)
    displayErrors: true,
  });
  // 序列化在上下文内完成: 大对象/BigInt/循环引用都不把宿主对象带回来
  const packed = JSON.parse(String(context.__pack(value)));
  if (packed.async) {
    // 沙箱不泵事件循环: 返回 Promise 会被序列化成 {} 让模型误判成功
    parentPort.postMessage({
      ok: false,
      error: "返回了 Promise/thenable, 沙箱只支持同步结果。请改写为同步表达式 (纯计算无需 await)",
      logs: packed.logs,
    });
  } else {
    parentPort.postMessage({ ok: true, result: packed.result, logs: packed.logs });
  }
} catch (e) {
  let logs = [];
  try {
    logs = JSON.parse(String(context.__dumpLogs()));
  } catch { /* 上下文已不可用 (超时/崩溃), 丢弃日志不影响裁决 */ }
  parentPort.postMessage({ ok: false, error: `${e.name}: ${e.message}`, logs });
}
