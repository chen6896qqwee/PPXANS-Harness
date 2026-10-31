// test/docker-shell.test.js — Docker 容器沙箱 shell provider (2026-10-31)
// 动机: 命令守卫/路径校验都是"执行前判定", 放行后命令以完整用户权限跑在宿主 shell。
// DockerShellProvider 把放行后的执行环境搬进容器 —— 判定遗漏由内核边界兜底。
// 测试策略: buildDockerRunArgs 纯函数全断言; exec 经依赖注入 (_execFile) 用假 docker 验证
// 探针/回退/报错 —— **不依赖真实 Docker**, 也不受 Windows .cmd spawn 限制。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalShellProvider, DockerShellProvider, buildDockerRunArgs } from "../src/seam/shell.js";

function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-dockersh-${tag}-`));
  return d;
}

// 假 docker exec 实现: 返回 [execFileImpl, 调用记录]
// - mode "ok":   version → 成功; run → stdout 回显参数 (JSON)
// - mode "fail": 一律失败 (模拟 docker 未安装/守护进程未运行)
function fakeDockerExec(mode, log = []) {
  const impl = (bin, args, opts) => {
    log.push({ bin, args, opts });
    if (mode === "fail") {
      const e = new Error("docker: command not found");
      e.code = 127;
      return Promise.reject(e);
    }
    if (args[0] === "version") return Promise.resolve({ stdout: "27.0.0\n", stderr: "" });
    if (args[0] === "run") return Promise.resolve({ stdout: "ARGS:" + JSON.stringify(args.slice(1)) + "\n", stderr: "" });
    return Promise.reject(new Error("unexpected: " + args[0]));
  };
  return impl;
}

function dockerWith(mode) {
  const log = [];
  const p = new DockerShellProvider({ root: tmp("prov"), dockerBin: "docker", _execFile: fakeDockerExec(mode, log) });
  return { p, log };
}

// ---- buildDockerRunArgs 纯函数 ----

test("buildDockerRunArgs: 安全旗标齐全 (断网/cap-drop/no-new-privileges/资源上限)", () => {
  const root = tmp("args");
  const args = buildDockerRunArgs("echo hi", { root, image: "node:22-bookworm" });
  const s = args.join(" ");
  assert.ok(args[0] === "run" && args[1] === "--rm", "一次性容器");
  assert.ok(s.includes("--network none"), "默认断网");
  assert.ok(s.includes("--cap-drop ALL"), "去全部 capabilities");
  assert.ok(s.includes("--security-opt no-new-privileges"), "禁运行期提权");
  assert.ok(s.includes("--memory 1g"));
  assert.ok(s.includes("--cpus 2"));
  assert.ok(s.includes("--pids-limit 256"));
  assert.ok(s.includes("-v"), "workspace bind-mount 存在");
  assert.ok(args[args.length - 1] === "echo hi", "命令串整体作为 /bin/sh -c 单参数");
  assert.ok(args[args.length - 3] === "/bin/sh" && args[args.length - 2] === "-c");
});

test("buildDockerRunArgs: root 内相对 cwd 映射到挂载点; 越界 cwd 报错 (fail-closed)", () => {
  const root = tmp("cwdmap");
  const sub = path.join(root, "pkg", "sub");
  fs.mkdirSync(sub, { recursive: true });
  const args = buildDockerRunArgs("ls", { root, cwd: sub, image: "img" });
  const wIdx = args.indexOf("-w");
  assert.ok(/\/workspace\/pkg\/sub/.test(args[wIdx + 1]), "相对 cwd → 挂载点子路径, 且统一 / 分隔");
  assert.equal(args[args.indexOf("-v") + 1], `${path.resolve(root)}:/workspace`);
  // root 本身 = 挂载点
  const args2 = buildDockerRunArgs("ls", { root, cwd: root, image: "img" });
  assert.equal(args2[args2.indexOf("-w") + 1], "/workspace");
  // 越界 → throw (provider 捕获后编码进返回值)
  assert.throws(() => buildDockerRunArgs("ls", { root, cwd: path.dirname(root), image: "img" }), /不在 workspace 内/);
});

test("buildDockerRunArgs: 宿主环境变量默认零透传 (防密钥入容器), 白名单/显式 env 生效", () => {
  const root = tmp("env");
  process.env.PPX_TEST_SECRET_VAR = "sk-secret-123";
  try {
    // 未列入白名单 → 不透传
    const args0 = buildDockerRunArgs("env", { root, image: "img", envPass: ["LANG"] });
    assert.ok(!args0.join("\n").includes("sk-secret-123"), "白名单外的宿主变量不透传");
    // 列入白名单 → 透传 (调用方自担)
    const args2 = buildDockerRunArgs("env", { root, image: "img", envPass: ["PPX_TEST_SECRET_VAR"] });
    assert.ok(args2.join("\n").includes("sk-secret-123"), "白名单命中的透传");
    // 显式 env map 优先且只透传它的键
    const args3 = buildDockerRunArgs("env", { root, image: "img", env: { FOO: "bar" } });
    assert.ok(args3.includes("-e") && args3.includes("FOO=bar"));
    assert.ok(!args3.join("\n").includes("sk-secret-123"));
  } finally {
    delete process.env.PPX_TEST_SECRET_VAR;
  }
});

test("buildDockerRunArgs: 非法输入 throw (空命令/缺 root)", () => {
  assert.throws(() => buildDockerRunArgs("", { root: "x", image: "img" }), /空命令/);
  assert.throws(() => buildDockerRunArgs("ls", { root: "", image: "img" }), /root/);
});

// ---- DockerShellProvider exec (假 docker, 不依赖真实 Docker) ----

test("DockerShellProvider: docker 可用时走容器执行 (命令串不落宿主 shell)", async () => {
  const { p, log } = dockerWith("ok");
  const r = await p.exec("echo hello && cat secret", { cwd: p.root });
  assert.equal(r.ok, true);
  const args = JSON.parse(r.stdout.replace(/^ARGS:/, ""));
  assert.equal(args[args.length - 3], "/bin/sh");
  assert.equal(args[args.length - 1], "echo hello && cat secret", "整串命令交给容器内 sh, 宿主不解析");
  assert.ok(args.includes("test-img") || args.includes("node:22-bookworm"), "镜像在位");
  const run = log.find((c) => c.args[0] === "run");
  assert.ok(run, "docker run 被调用");
  assert.equal(run.bin, "docker");
  // 宿主侧数组形式 execFile: version 探测 + run 各一次
  assert.deepEqual(log.map((c) => c.args[0]), ["version", "run"]);
});

test("DockerShellProvider: docker 不可用 + missing=fallback → 回退本地执行并一次性告警", async () => {
  const root = tmp("fallback");
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const p = new DockerShellProvider({ root, dockerBin: "docker", missing: "fallback", _execFile: fakeDockerExec("fail") });
    const r1 = await p.exec("echo ping", { cwd: root });
    assert.equal(r1.ok, true, "回退本地后命令真实执行");
    assert.match(r1.stdout, /ping/);
    assert.equal(warns.length, 1, "首次回退告警一次");
    await p.exec("echo pong", { cwd: root });
    assert.equal(warns.length, 1, "告警只发一次");
  } finally {
    console.warn = origWarn;
  }
});

test("DockerShellProvider: docker 不可用 + missing=error → fail-closed 报错 (不回退)", async () => {
  const { p } = dockerWith("fail");
  p.missing = "error";
  const r = await p.exec("echo hi", { cwd: p.root });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /docker 沙箱不可用/);
  assert.match(r.stderr, /shell_provider/, "错误信息给出改法");
  assert.equal(r.stdout, "", "不执行任何东西");
});

test("DockerShellProvider: 探针结果缓存 (只探一次)", async () => {
  const log = [];
  const p = new DockerShellProvider({ root: tmp("probe"), dockerBin: "docker", _execFile: fakeDockerExec("ok", log) });
  await p.exec("echo a", { cwd: p.root });
  await p.exec("echo b", { cwd: p.root });
  assert.equal(log.filter((c) => c.args[0] === "version").length, 1, "version 只探一次");
  assert.ok(p._probe instanceof Promise, "探针缓存为 Promise");
});

test("DockerShellProvider: cwd 越界被拒且报错可读 (不执行)", async () => {
  const { p } = dockerWith("ok");
  const r = await p.exec("cat /etc/passwd", { cwd: path.dirname(p.root) });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /不在 workspace 内/);
  assert.equal(r.stdout, "");
});

test("DockerShellProvider: 运行错误编码进返回值 (非零退出码), 永不 throw", async () => {
  const log = [];
  const p = new DockerShellProvider({ root: tmp("err"), dockerBin: "docker", _execFile: (bin, args) => {
    log.push(args);
    if (args[0] === "version") return Promise.resolve({ stdout: "27\n", stderr: "" });
    const e = new Error("Command failed");
    e.code = 7;
    return Promise.reject(e);
  } });
  const r = await p.exec("exit 7", { cwd: p.root });
  assert.equal(r.ok, false);
  assert.equal(r.code, 7);
});

test("LocalShellProvider 回归: 行为不变 (echo / 非零退出码)", async () => {
  const root = tmp("local");
  const p = new LocalShellProvider();
  const ok = await p.exec("echo local-ok", { cwd: root });
  assert.equal(ok.ok, true);
  assert.match(ok.stdout, /local-ok/);
  const bad = await p.exec("exit 3", { cwd: root });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
});
