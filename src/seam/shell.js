// src/seam/shell.js - Shell 能力 seam (设计溯源 docs/PROVENANCE.md#dsh Service|Provider|Consumer 三层)
// Service Definition: 命令执行能力, 接口 = exec(cmd, opts) -> Promise<{stdout, stderr, code, ok}>
//   - Service: "shell" 这个能力 (key = "shell")
//   - Provider: LocalShellProvider (本地 execFile, 默认) | DockerShellProvider (容器沙箱, 2026-10-31)
//   - Consumer: run_command / code_act 工具, 通过 ctx.consume("shell") 获取实现, 换 provider 即换执行环境
import { warn as logWarn } from "../utils/logger.js";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// 带整树终止的 execFile (2026-11-14, 评测 P2-2):
// execFile 自带的 timeout 只 kill 直接子进程 (Windows: cmd.exe), 孙进程 (npm/node 长驻脚本)
// 仍持 stdio 管道存活 —— 实测 (test/timeout-semantics-2026-11-14.test.js 心跳探针) 超时后
// 孙进程继续运行, 资源泄漏且 'close' 可能永不触发。因此 timeout 在这里自管:
//   关掉 execFile 的 timeout, 到点对**还活着的直接子进程**做整树终止 (taskkill /T /F 或组杀) ——
//   对活 pid 一次调用即可连孙进程全部带走; 若先让 node 杀掉 cmd.exe 再补刀, pid 已死反而杀不到树。
//   调用方 AbortSignal (seam 的工具预算 abort) 触发同一树杀, 结果上标 aborted。
// 返回形状与 promisify(execFile) 兼容: resolve([stdout, stderr]) / reject(err), err 带部分输出。
function execFileTree(bin, argv, opts, { signal = null, timeoutMs = 0, isWin = false }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let treeKilled = false;
    const finish = (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        if (treeKilled) err.aborted = true;
        try { err.stdout = stdout; err.stderr = stderr; } catch { /* 只读对象: 保留原错误 */ }
        reject(err);
      } else {
        resolve([stdout, stderr]);
      }
    };
    // timeout: 0 —— 进程寿命由本函数的树杀定时器接管 (见上)
    const child = execFile(bin, argv, { ...opts, timeout: 0 }, finish);
    // spawn 失败等异常路径: promisify 语义是 error 事件即 reject (close 可能永远不来)
    child.on("error", (e) => finish(e, undefined, undefined));
    const killTree = () => {
      if (settled) return;
      treeKilled = true;
      try {
        if (isWin) {
          // /T = 连同子进程树, /F = 强制; 不等待 taskkill 自身 (树死后 close 事件驱动后续)
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      } catch { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }
    };
    const killTimer = timeoutMs > 0 ? setTimeout(killTree, timeoutMs) : null;
    const onAbort = () => killTree();
    if (signal) {
      if (signal.aborted) killTree();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    function cleanup() {
      if (killTimer) clearTimeout(killTimer);
      try { signal?.removeEventListener("abort", onAbort); } catch { /* 非 EventTarget: 忽略 */ }
    }
  });
}

// 信号死亡可读化 (设计溯源 docs/PROVENANCE.md#hermes: 裸退出码 -> 人类可读说明)
// 负码/信号(子进程语义)确定性描述; shell 的 128+signum 约定用"通常"措辞
const SIGNAL_NOTES = {
  SIGKILL: "通常内存耗尽(OOM)被内核强杀, 或显式 kill -9",
  SIGTERM: "正常终止请求(可能超时被强杀)",
  SIGSEGV: "段错误(访问非法内存)",
  SIGABRT: "abort 异常终止",
  SIGINT: "Ctrl+C 中断",
  SIGPIPE: "管道断裂(读取端提前关闭)",
  SIGBUS: "总线错误",
  SIGFPE: "浮点异常",
  SIGUSR1: "用户自定义信号 1",
  SIGQUIT: "键盘退出信号",
};
function signalNote(sig) {
  if (!sig) return "";
  const extra = SIGNAL_NOTES[sig] ? " — " + SIGNAL_NOTES[sig] : "";
  return ` (进程被信号 ${sig} 终止${extra})`;
}

// execFile 异常 → 统一 {stdout, stderr, code, ok} 形状 (两个 provider 共用, 永不 throw)
// keepStdout=false 时丢弃部分输出 (Docker 侧保留部分输出)
// 2026-11-13 (评测 P1-5): 本地执行也保留 stdout —— 失败命令的报错信息常在 stdout
//   (npm test / findstr 的匹配结果), 旧行为把它丢掉, 模型只能看到 "Command failed" 壳。
export function decodeShellBuf(buf, isWin) {
  if (buf == null) return "";
  if (typeof buf === "string") return buf;
  const utf8 = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
  if (!isWin || !utf8.includes("\uFFFD")) return utf8;
  // Windows cmd.exe 默认 CP936: UTF-8 解码出现替换符时按 GBK 重解一次 (Node 全量 ICU)
  try {
    const gbk = new TextDecoder("gbk").decode(buf);
    if (gbk && !gbk.includes("\uFFFD")) return gbk;
  } catch { /* ICU 不含 gbk 时保留 utf8 结果 */ }
  return utf8;
}

function mapExecError(e, { keepStdout = false, isWin = false } = {}) {
  const sig = e && e.signal;
  return {
    stdout: keepStdout && e && e.stdout ? decodeShellBuf(e.stdout, isWin) : "",
    stderr: decodeShellBuf(e && e.stderr, isWin) || String(e && e.message || e) + signalNote(sig),
    code: typeof e.code === "number" ? e.code : (sig ? -1 : 1),
    ok: false,
    // execFile 超时会 kill 子进程 (killed/SIGTERM), 旧实现没有把这个信号透传出来,
    // run_command 的 "[工具错误] 超时" 分支因此永远不命中。
    // 2026-11-14 (评测 P2-2): 补杀树 (taskkill /T) 与 abort 触发的终止同样计为 timedOut ——
    //   外部 taskkill 的退出形态是 code=1 而非 signal, 不补这条 run_command 会报"命令失败"。
    timedOut: !!(e && (e.killed || e.signal === "SIGTERM" || e.code === "ETIMEDOUT" || e.aborted)),
    aborted: !!(e && e.aborted),
  };
}

// 默认本地 shell provider: 在本机 shell 直接执行命令
// 约定: 永不 throw, 错误编码进返回值 (code != 0 或 ok=false), 与 LLM 重试内核的"失败编码进结果"一致
export class LocalShellProvider {
  async exec(cmd, { cwd, timeoutMs = 30000, maxBuffer = 8 * 1024 * 1024, env = null, signal = null } = {}) {
    const isWin = process.platform === "win32";
    try {
      const [stdout, stderr] = await execFileTree(isWin ? "cmd.exe" : "/bin/sh", [isWin ? "/c" : "-c", cmd], {
        cwd,
        maxBuffer,
        env: env || undefined,
        windowsHide: true,
        // posix: 让子进程成为组组长, 树杀可用 process.kill(-pid) 连孙进程一起带走;
        // Windows 靠 taskkill /T, 不需要 (也避免 detached 的额外语义)。
        detached: isWin ? undefined : true,
        // 先拿 Buffer 再解码: 直接 utf8 会把 cmd.exe 的 CP936 变成乱码且不可逆
        encoding: "buffer",
      }, { signal, timeoutMs, isWin });
      return {
        stdout: decodeShellBuf(stdout, isWin),
        stderr: decodeShellBuf(stderr, isWin),
        code: 0,
        ok: true,
        aborted: false,
      };
    } catch (e) {
      const out = mapExecError(e, { keepStdout: true, isWin });
      // abort/超时补刀杀树的结果统一标 aborted (调用方可区分"主动中止"与"自然失败")
      out.aborted = !!(e && e.aborted);
      return out;
    }
  }
}

// ---- Docker 容器沙箱 (2026-10-31, 对标 OpenClaw 的容器隔离 / codex 的 OS 级沙箱) ----
//
// 动机: 命令守卫 + 路径校验都是"执行前判定", 放行后命令以当前用户完整权限跑在宿主 shell 里
// (如 write_file 写 payload.js 再 `node payload.js` 双双放行 = 等价任意代码执行)。Docker
// provider 把放行后的执行环境整个搬进容器 —— 判定遗漏由内核边界兜底。
//
// 语义 (务必读):
//   - workspace bind-mount 到容器 /workspace, cwd 也映射进去 → 命令用相对路径即可, 文件改动
//     经挂载实时落回宿主 (与文件工具同一份磁盘)。
//   - 每条命令 `docker run --rm` 起一次性容器: 文件副作用经挂载持久, **容器内全局状态不跨命令
//     持久** (apt 装的包/容器内写的主目录, 下一条命令就没了)。要装依赖请装进 workspace
//     (npm i → node_modules 在挂载里, 天然持久)。
//   - cwd 必须在 root 内 (fail-closed): 容器只挂载 workspace, 越界 cwd 直接报错。
//   - 宿主侧 execFile 数组形式, 命令串只作为容器内 /bin/sh -c 的单个参数 —— 宿主 shell 不解析。
//
// 加固默认值: --network none (断网) + --cap-drop ALL + --security-opt no-new-privileges +
//   --memory 1g + --cpus 2 + --pids-limit 256; 宿主环境变量默认**零透传** (防密钥入容器)。

// 纯函数: 组装 docker run 参数 (不触 docker, 可单测)。cwd 越界 throw。
export function buildDockerRunArgs(cmd, {
  root,
  mount = "/workspace",
  cwd,
  image,
  network = "none",
  memory = "1g",
  cpus = "2",
  pidsLimit = 256,
  user = "",
  envPass = [],
  env = null, // 显式 env map (可选, 提供时只透传它的键; 否则按 envPass 白名单取 process.env)
}) {
  if (!cmd || typeof cmd !== "string") throw new Error("空命令");
  if (!root) throw new Error("缺少 workspace root");
  const args = ["run", "--rm"];
  if (network) args.push("--network", network);
  if (memory) args.push("--memory", memory);
  if (cpus) args.push("--cpus", cpus);
  if (pidsLimit) args.push("--pids-limit", String(pidsLimit));
  // 内核级加固: 去掉全部 capabilities + 禁止运行期提权
  args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
  args.push("-v", `${path.resolve(root)}:${mount}`);
  // cwd 映射: host 路径 → 容器挂载点相对路径
  let wdir = mount;
  if (cwd) {
    const base = path.resolve(root);
    const abs = path.resolve(cwd);
    const rel = path.relative(base, abs);
    // rel 为 "" 或 "." 都表示 cwd === root (合法); 越界 = 相对路径跳出 (../) 或跨盘符绝对路径
    if (rel && rel !== "." && (rel.startsWith("..") || path.isAbsolute(rel))) {
      throw new Error(`cwd 不在 workspace 内 (docker 沙箱只挂载 workspace): ${cwd}`);
    }
    if (rel && rel !== ".") wdir = mount + "/" + rel.split(path.sep).join("/");
  }
  args.push("-w", wdir);
  if (user) args.push("-u", user);
  // 环境变量白名单透传 (默认不透传 PATH —— 宿主 PATH 会污染容器内 PATH)
  const names = env ? Object.keys(env) : (envPass || []);
  for (const n of names) {
    const v = env ? env[n] : process.env[n];
    if (v != null && String(v).trim() !== "") args.push("-e", `${n}=${v}`);
  }
  args.push(image, "/bin/sh", "-c", cmd);
  return args;
}

export class DockerShellProvider {
  constructor(opts = {}) {
    this.root = path.resolve(opts.root || process.cwd());
    this.mount = opts.mount || "/workspace";
    this.image = opts.image || "node:22-bookworm";
    this.network = opts.network !== undefined ? opts.network : "none";
    this.memory = opts.memory || "1g";
    this.cpus = opts.cpus || "2";
    this.pidsLimit = opts.pidsLimit != null ? opts.pidsLimit : 256;
    this.user = opts.user || "";
    this.envPass = Array.isArray(opts.envPass) ? opts.envPass : ["LANG", "LC_ALL", "TZ"];
    this.dockerBin = opts.dockerBin || "docker";
    this.missing = opts.missing === "error" ? "error" : "fallback"; // docker 不可用时的行为
    this.kind = "docker";
    // execFile 依赖注入 (测试用假 docker; 生产为默认 promisify(execFile))
    this._execFile = opts._execFile || execFileP;
    this._probe = null;      // 缓存探针结果 (Promise<boolean>)
    this._warned = false;
    this._fallback = new LocalShellProvider();
  }

  // 探测 docker 守护进程可用 (首次调用后缓存; 10s 上限防挂死启动)
  async _ensureAvailable() {
    if (!this._probe) {
      this._probe = this._execFile(this.dockerBin, ["version", "--format", "{{.Server.Version}}"], {
        timeout: 10000,
        windowsHide: true,
      }).then(() => true).catch(() => false);
    }
    return this._probe;
  }

  async exec(cmd, { cwd, timeoutMs = 30000, maxBuffer = 1024 * 1024, env = null, signal = null } = {}) {
    // 2026-11-14 (评测 P2-2): 与 LocalShellProvider 对齐接受 abort signal。
    //   已中止的调用不再起容器; 运行中容器的树杀不做 (容器由 --rm 自清理, 宿主侧只能 kill CLI),
    //   fallback 回本地执行时 signal 全量透传 (本地树杀生效)。
    if (signal && signal.aborted) {
      return { stdout: "", stderr: "[shell] 执行已被中止 (abort), 未启动容器。", code: 1, ok: false, aborted: true };
    }
    const available = await this._ensureAvailable();
    if (!available) {
      if (this.missing === "error") {
        return {
          stdout: "",
          stderr: `[docker 沙箱不可用] security.shell_provider=docker 但 Docker 守护进程未运行或未安装 (bin=${this.dockerBin})。`
            + "启动 Docker Desktop / 安装 Docker, 或把 security.shell_provider 改回 \"local\"。",
          code: 1,
          ok: false,
        };
      }
      // fallback: 显式一次性告警后回退本地执行 (保持可用性; 告警让用户知道沙箱没生效)
      if (!this._warned) {
        this._warned = true;
        logWarn('[shell seam] Docker 不可用 — security.shell_provider=docker 已回退本地执行 (security.docker.missing="fallback", 改 "error" 可强制失败)。');
      }
      return this._fallback.exec(cmd, { cwd, timeoutMs, maxBuffer, env, signal });
    }
    let args;
    try {
      args = buildDockerRunArgs(cmd, {
        root: this.root, mount: this.mount, cwd, image: this.image,
        network: this.network, memory: this.memory, cpus: this.cpus,
        pidsLimit: this.pidsLimit, user: this.user, envPass: this.envPass, env,
      });
    } catch (e) {
      return { stdout: "", stderr: `[docker 沙箱] ${e.message}`, code: 1, ok: false };
    }
    try {
      const { stdout, stderr } = await this._execFile(this.dockerBin, args, {
        timeout: timeoutMs,
        maxBuffer,
        windowsHide: true,
      });
      return { stdout: stdout || "", stderr: stderr || "", code: 0, ok: true };
    } catch (e) {
      // 超时: 宿主侧 kill 的是 docker CLI, 容器靠 --rm 自清理; 保留部分输出尽力带回
      const out = mapExecError(e, { keepStdout: true });
      if (e && e.killed && out.stdout) return { ...out, stderr: (out.stderr || "") + "\n[容器超时被终止]" };
      return out;
    }
  }
}
