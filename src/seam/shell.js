// src/seam/shell.js - Shell 能力 seam (吸收 dsh Service|Provider|Consumer 三层)
// Service Definition: 命令执行能力, 接口 = exec(cmd, opts) -> Promise<{stdout, stderr, code, ok}>
//   - Service: "shell" 这个能力 (key = "shell")
//   - Provider: LocalShellProvider (本地 execFile, 默认) | DockerShellProvider (容器沙箱, 2026-10-31)
//   - Consumer: run_command / code_act 工具, 通过 ctx.consume("shell") 获取实现, 换 provider 即换执行环境
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// 信号死亡可读化 (吸收 Hermes: 裸退出码 -> 人类可读说明)
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
// keepStdout=false 时丢弃部分输出 (Local 原行为, 避免既有断言漂移); Docker 侧保留部分输出
function mapExecError(e, { keepStdout = false } = {}) {
  const sig = e && e.signal;
  return {
    stdout: keepStdout && e && e.stdout ? String(e.stdout) : "",
    stderr: String(e && e.message || e) + signalNote(sig),
    code: typeof e.code === "number" ? e.code : (sig ? -1 : 1),
    ok: false,
  };
}

// 默认本地 shell provider: 在本机 shell 直接执行命令
// 约定: 永不 throw, 错误编码进返回值 (code != 0 或 ok=false), 与 LLM 重试内核的"失败编码进结果"一致
export class LocalShellProvider {
  async exec(cmd, { cwd, timeoutMs = 30000, maxBuffer = 1024 * 1024, env = null } = {}) {
    const isWin = process.platform === "win32";
    try {
      const { stdout, stderr } = await execFileP(isWin ? "cmd.exe" : "/bin/sh", [isWin ? "/c" : "-c", cmd], {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        env: env || undefined,
        windowsHide: true,
      });
      return { stdout: stdout || "", stderr: stderr || "", code: 0, ok: true };
    } catch (e) {
      return mapExecError(e);
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

  async exec(cmd, { cwd, timeoutMs = 30000, maxBuffer = 1024 * 1024, env = null } = {}) {
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
        console.warn('[shell seam] Docker 不可用 — security.shell_provider=docker 已回退本地执行 (security.docker.missing="fallback", 改 "error" 可强制失败)。');
      }
      return this._fallback.exec(cmd, { cwd, timeoutMs, maxBuffer, env });
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
