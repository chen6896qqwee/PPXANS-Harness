// src/tools/sandbox.js - 内置 JS 沙箱执行器 (零依赖)
//
// 用途: 让 agent 能安全地跑一段 JS 做计算/数据变换/格式转换 (CodeAct 能力落地):
//   - 不用 shell 也不落盘, 单轮纯计算, 结果回灌工具循环。
//   - 双层隔离: worker_threads 独立线程 (超时强杀, 死循环也不挂主进程)
//     + node:vm 裁剪全局上下文 (无 require/process/fetch/fs, 纯计算)。
//   - 这不是安全边界意义上的"防恶意"沙箱 (Node 无原生强隔离), 面向的是"防失误":
//     防死循环、防误写文件、防意外网络请求。对不受信代码仍应走 run_command + 沙箱策略审批链。
import path from "node:path";
import { Worker } from "node:worker_threads";
import { TOOL_ERROR_PREFIX } from "./seam.js";
import { debug } from "../utils/logger.js";

const WORKER_URL = new URL("./sandbox-worker.js", import.meta.url);

function err(name, msg) {
  return `${TOOL_ERROR_PREFIX} ${name}: ${msg}`;
}

// 跑一段代码: { ok, result, logs, durationMs } 或 { ok:false, error, logs }
export function runInSandbox(code, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cap = Math.min(Number(timeoutMs) || 3000, 10000);
    let worker;
    try {
      worker = new Worker(WORKER_URL, { workerData: { code: String(code || ""), timeoutMs: cap } });
    } catch (e) {
      return resolve({ ok: false, error: `worker 启动失败: ${e.message}`, logs: [], durationMs: 0 });
    }
    const timer = setTimeout(() => {
      worker.terminate().catch((e) => debug(`[sandbox] terminate 异常: ${e.message}`));
      // terminate 后 message 不会再来, 立即裁决; 哨兵标志防双 resolve
      settled = true;
      resolve({ ok: false, error: `执行超时 (${cap}ms), 线程已强杀`, logs: [], durationMs: Date.now() - t0 });
    }, cap + 500); // vm 层超时通常先触发; 这层兜底异步死循环
    let settled = false;
    worker.on("message", (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...msg, durationMs: Date.now() - t0 });
    });
    worker.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `worker 异常: ${e.message}`, logs: [], durationMs: Date.now() - t0 });
    });
    worker.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `worker 提前退出 (code=${code})`, logs: [], durationMs: Date.now() - t0 });
    });
  });
}

export function registerSandboxTools(catalog, { rootDir = process.cwd() } = {}) {
  void rootDir;
  catalog.register({
    name: "code_run",
    description: "在内置 JS 沙箱里执行一段 JavaScript 并返回结果 (纯计算: 数学/字符串/数组变换/JSON 处理)。沙箱无网络/文件/进程访问, 限时 10s。适合精确计算、数据转换、格式化 —— 比手算可靠, 比 shell 干净。",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "JS 代码 (表达式或语句)。最后一条表达式的值或显式变量为返回值; 用 console.log 输出中间信息" },
        timeout_ms: { type: "number", description: "超时毫秒 (默认 3000, 上限 10000)" },
      },
      required: ["code"],
    },
    category: "compute",
    power: "user",
    idempotent: true,
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    execute: async (args) => {
      const code = String(args.code || "").trim();
      if (!code) return err("code_run", "code 不能为空");
      const r = await runInSandbox(code, { timeoutMs: Number(args.timeout_ms) || 3000 });
      if (!r.ok) {
        return err("code_run", `${r.error}${r.logs?.length ? ` | 输出: ${r.logs.join(" / ").slice(0, 500)}` : ""}`);
      }
      return JSON.stringify({
        ok: true,
        result: r.result,
        logs: (r.logs || []).slice(0, 50),
        durationMs: r.durationMs,
      });
    },
  });
  return catalog;
}
