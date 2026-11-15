// src/tools/jobs.js - 长任务后台执行 (2026-11-13, 评测 P1-6)
//
// 动机: run_command 最多等 30s, 而 npm test / 构建 / 冒烟这类长任务经常跑几分钟。
//   旧行为是模型反复轮询/超时重试, 最后撞工具轮次上限, 用户拿到"做了一半"。
//   这里提供最小的后台原语: 启动即返回 job id, 输出落盘, 模型用 job 工具按需读尾部,
//   不占用工具轮次, 也不会把 30s 超时当成任务失败。
//
// 安全边界 (与 run_command 同口径, 不另开一扇门):
//   · 启动前仍过 checkCommand / 会话自写脚本 / 包清单三道闸门 (由注册处注入 precheck)
//   · 子进程不 detach, 进程退出时统一 kill; 日志落 dataDir/jobs, read_file 侧列为受保护路径
//   · 单 job 日志封顶 10MB, 最多保留 50 个 job 元数据
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir } from "../utils/store.js";
import { noteCatch } from "../utils/catch-log.js";
import { decodeShellBuf } from "../seam/shell.js";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_JOBS = 50;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class JobRegistry {
  constructor(dataDir) {
    this.dir = path.join(dataDir || path.join(process.cwd(), ".ppx"), "jobs");
    ensureDir(this.dir);
    this.jobs = new Map();
    this.seq = 0;
    this._pruneLogs();
    this._exitHook = () => { try { this.cleanup(); } catch { /* 退出路径不抛 */ } };
    process.once("exit", this._exitHook);
  }

  _pruneLogs() {
    try {
      const files = fs.readdirSync(this.dir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => ({ f, m: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      for (const { f } of files.slice(MAX_JOBS)) {
        try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* 被占用则下次再清 */ }
      }
    } catch { /* 目录不可读不阻断启动 */ }
  }

  start({ command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = MAX_LOG_BYTES }) {
    const id = `job_${Date.now().toString(36)}_${++this.seq}`;
    const log = path.join(this.dir, `${id}.log`);
    const stream = fs.createWriteStream(log, { flags: "a" });
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd.exe" : "/bin/sh", [isWin ? "/c" : "-c", command], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job = {
      id,
      command,
      pid: child.pid || null,
      log,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      timedOut: false,
      bytes: 0,
      truncated: false,
      _child: child,
      _stream: stream,
      _tail: "",
      _timer: null,
    };
    const write = (buf) => {
      if (!buf) return;
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
      if (job.bytes >= Number(maxBuffer) || job.bytes >= MAX_LOG_BYTES) {
        if (!job.truncated) {
          job.truncated = true;
          try { stream.write("\n...[后台日志超过上限, 后续输出已丢弃]...\n"); } catch (e) { noteCatch("src/tools/jobs.js#write.truncate", e); }
        }
        return;
      }
      job.bytes += b.length;
      try { stream.write(b); } catch (e) { noteCatch("src/tools/jobs.js#write.stream", e); }
      job._tail = (job._tail + decodeShellBuf(b, isWin)).slice(-4096);
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    child.once("error", (e) => {
      job.status = "failed";
      job.error = e?.message || String(e);
      job.endedAt = new Date().toISOString();
    });
    child.once("exit", (code, signal) => {
      job.status = job.timedOut ? "timeout" : (code === 0 ? "exited" : "failed");
      job.exitCode = code;
      job.signal = signal || null;
      job.endedAt = new Date().toISOString();
      if (job._timer) { clearTimeout(job._timer); job._timer = null; }
      try { stream.end(); } catch (e) { noteCatch("src/tools/jobs.js#exit.stream-end", e); }
    });
    job._timer = setTimeout(() => {
      job.timedOut = true;
      this.kill(id);
    }, Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS));
    if (typeof job._timer.unref === "function") job._timer.unref();
    this.jobs.set(id, job);
    this._pruneJobs();
    return this._view(job, { tail: 2000 });
  }

  _view(job, { tail } = {}) {
    return {
      id: job.id,
      command: job.command,
      pid: job.pid,
      status: job.status,
      exitCode: job.exitCode,
      timedOut: job.timedOut,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      bytes: job.bytes,
      truncated: job.truncated,
      log: job.log,
      ...(tail ? { tail: String(job._tail || "").slice(-Number(tail)) } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  _pruneJobs() {
    const all = [...this.jobs.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    for (const j of all.slice(MAX_JOBS)) {
      if (j.status === "running") continue; // 在跑的绝不逐出
      this.jobs.delete(j.id);
    }
  }

  status(id) {
    const job = this.jobs.get(String(id || ""));
    return job ? this._view(job, { tail: 4000 }) : null;
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map((j) => this._view(j));
  }

  output(id, { offset = 0, limit = 20000 } = {}) {
    const job = this.jobs.get(String(id || ""));
    if (!job) return null;
    let text = "";
    try {
      const st = fs.statSync(job.log);
      const start = Math.max(0, Math.min(Number(offset) || 0, st.size));
      const len = Math.max(1, Math.min(Number(limit) || 20000, 200000));
      const fd = fs.openSync(job.log, "r");
      try {
        const buf = Buffer.alloc(Math.min(len, st.size - start));
        const n = fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.subarray(0, n).toString("utf8");
      } finally { fs.closeSync(fd); }
    } catch (e) {
      text = `[读取日志失败: ${e?.message || e}]`;
    }
    return { ...this._view(job), offset, text };
  }

  kill(id) {
    const job = this.jobs.get(String(id || ""));
    if (!job || job.status !== "running" || !job._child) return false;
    try { job._child.kill("SIGTERM"); } catch { /* 已退出 */ }
    return true;
  }

  cleanup() {
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        try { job._child?.kill("SIGTERM"); } catch { /* 已退出 */ }
      }
      try { job._stream?.end(); } catch { /* 已关闭 */ }
      if (job._timer) { clearTimeout(job._timer); job._timer = null; }
    }
  }
}
