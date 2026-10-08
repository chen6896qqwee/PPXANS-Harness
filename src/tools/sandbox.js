// src/tools/sandbox.js - 内置 JS 沙箱执行器 (零依赖)
//
// 用途: 让 agent 能安全地跑一段 JS 做计算/数据变换/格式转换 (CodeAct 能力落地):
//   - 不用 shell 也不落盘, 单轮纯计算, 结果回灌工具循环。
//   - 双层隔离: worker_threads 独立线程 (超时强杀 + 堆上限 + 空 env/execArgv)
//     + node:vm 新上下文 (V8 自建 intrinsics, 无 require/process/fetch/fs, 纯计算)。
//   - 上下文不接收任何宿主 realm 对象 (2026-10-04 复审封堵 Promise→constructor→process 跳跃),
//     因此脚本层面拿不到环境变量与文件系统。仍非 OS 级强隔离边界: 不受信场景请配审批链。
import path from "node:path";
import { Worker } from "node:worker_threads";
import { TOOL_ERROR_PREFIX } from "./seam.js";
import { debug } from "../utils/logger.js";

const WORKER_URL = new URL("./sandbox-worker.js", import.meta.url);

function err(name, msg) {
  return `${TOOL_ERROR_PREFIX} ${name}: ${msg}`;
}

// 跑一段代码: { ok, result, logs, durationMs } 或 { ok:false, error, logs }
// opts: timeoutMs 执行上限 / maxHeapMb 线程堆上限 (防大内存 DoS, 沙箱无 IO 但能吃内存)
//   maxHeapMb 经 worker_threads resourceLimits.maxOldGenerationSizeMb 真实强制执行
//   (Node 原生, 零依赖): 超限 worker 以 ERR_WORKER_OUT_OF_MEMORY 终止, 走 error/exit
//   分支裁决为 ok:false, 不拖垮宿主进程。默认 128 (下限 16), 与历史行为一致。
//   maxHeapMb <= 0 = 不设堆上限 (off, 仅供 harness/测试显式关闭; code_run 工具面不暴露关档)。
export function runInSandbox(code, { timeoutMs = 3000, maxHeapMb = 128 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cap = Math.min(Number(timeoutMs) || 3000, 10000);
    const heapMb = Number(maxHeapMb);
    const resourceLimits = Number.isFinite(heapMb) && heapMb > 0
      ? { maxOldGenerationSizeMb: Math.max(16, heapMb) }
      : undefined; // 显式关闭: 不传 resourceLimits, worker 跟随进程默认
    let worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: { code: String(code || ""), timeoutMs: cap },
        // 不继承主进程 execArgv: 宿主启动 flag (如 --input-type/--experimental-*) 会让 worker 起不来
        execArgv: [],
        // 不给 worker 继承环境变量: 纵深防御, 沙箱即使被绕过也不该看到 API Key
        env: {},
        // 堆上限: 超限由 worker 侧 OOM 退出走 error/exit 分支裁决, 不拖垮主进程
        ...(resourceLimits ? { resourceLimits } : {}),
      });
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
    description: "在内置 JS 沙箱里执行一段 JavaScript 并返回结果 (纯计算: 数学/字符串/数组变换/JSON 处理)。沙箱无网络/文件/进程访问, 限时 10s, 线程堆上限默认 128MB (超限直接终止, 不影响宿主)。适合精确计算、数据转换、格式化 —— 比手算可靠, 比 shell 干净。",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "JS 代码 (表达式或语句)。最后一条表达式的值或显式变量为返回值; 用 console.log 输出中间信息" },
        timeout_ms: { type: "number", description: "超时毫秒 (默认 3000, 上限 10000)" },
        max_heap_mb: { type: "number", description: "沙箱线程堆上限 MB (默认 128, 下限 16; 仅可调大或收紧上限, 不支持关闭)" },
      },
      required: ["code"],
    },
    category: "compute",
    power: "user",
    idempotent: true,
    // 2026-10-04 安全复审: realm 跳跃封堵后沙箱确实无 IO/网络/进程通路, 但仍能消耗 CPU 与堆,
    // 故按 medium 记账而非 low —— 熔断/降档策略可据此区别对待纯计算与真副作用工具。
    // F1 (2026-10-05): readOnly 由 true 改 false。理由: 能力门的 readOnly 是给 plan 模式与
    //   只读沙箱用的「可静默直通」豁免, 而 code_run 执行的是模型现写的代码 ——
    //   沙箱是"尽力而为的强限制", 不是 OS 级边界 (本文件头注原话: 不受信场景请配审批链)。
    //   把"执行模型代码"标成只读, 等于让计划模式跑任意代码; 纯计算仍需审批的场景没增加
    //   (medium 在默认 workspace-write 模式下照旧静默放行)。
    capability: { readOnly: false, destructive: false, riskLevel: "medium", sideEffect: "compute" },
    execute: async (args) => {
      const code = String(args.code || "").trim();
      if (!code) return err("code_run", "code 不能为空");
      // 堆上限走 tool → runInSandbox → worker resourceLimits 的真实强制路径:
      // 未传 = 默认 128MB (与历史行为一致); 传值仅接受正数 (下限 16 由 runInSandbox 兜),
      // 0/负数/非法值一律回落默认 —— 模型侧没有"关掉内存上限"的入口。
      const heapArg = Number(args.max_heap_mb);
      const sandboxOpts = { timeoutMs: Number(args.timeout_ms) || 3000 };
      if (Number.isFinite(heapArg) && heapArg > 0) sandboxOpts.maxHeapMb = heapArg;
      const r = await runInSandbox(code, sandboxOpts);
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
