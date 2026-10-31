// test/update-check.test.js — 自动更新 (2026-10-31, 队列⑤)
// 钉住: semver 比较含 prerelease / 版本串卫生 / TTL 缓存 (含坏缓存容忍) / 双通道 URL
//       / 装机形态判据 / 应用计划 / 通知文案 / CLI 子进程 e2e (本地假 registry, 零真实网络)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  compareSemver,
  sanitizeVersion,
  detectInstallMode,
  checkForUpdate,
  fetchLatestVersion,
  planApply,
  updateNotice,
  RELEASES_URL,
} from "../src/update/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "ppx.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-update-"));
}

// ---- 纯函数 ----

test("compareSemver: 主/次/补丁数值比较 (不按字典序)", () => {
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
  assert.equal(compareSemver("1.10.0", "1.9.0"), 1, "10 > 9 按数值");
  assert.equal(compareSemver("2.0.0", "1.99.99"), 1);
  assert.equal(compareSemver("4.0.0", "4.0.1"), -1);
});

test("compareSemver: prerelease 排序 (semver 规约)", () => {
  assert.equal(compareSemver("4.1.0-beta.1", "4.1.0"), -1, "prerelease < 正式版");
  assert.equal(compareSemver("4.1.0-beta.1", "4.1.0-beta.2"), -1);
  assert.equal(compareSemver("4.1.0-alpha", "4.1.0-beta"), -1);
  assert.equal(compareSemver("4.1.0-beta.1", "4.1.0-beta.1"), 0);
});

test("sanitizeVersion: 只放行 semver 形状 (防响应内容进展示/比较)", () => {
  assert.equal(sanitizeVersion("4.1.0"), "4.1.0");
  assert.equal(sanitizeVersion("v4.1.0"), "4.1.0", "v 前缀剥离 (GitHub tag)");
  assert.equal(sanitizeVersion("4.1.0-beta.1"), "4.1.0-beta.1");
  assert.equal(sanitizeVersion("<script>1.2.3</script>"), null);
  assert.equal(sanitizeVersion("1.2"), null);
  assert.equal(sanitizeVersion(""), null);
  assert.equal(sanitizeVersion(null), null);
});

test("detectInstallMode: node_modules 内 = npm 装机, 否则源码", () => {
  assert.equal(detectInstallMode("/usr/lib/node_modules/ppxans-harness"), "npm");
  assert.equal(detectInstallMode("C:\\Users\\chen\\Desktop\\PPXANS-Harness"), "source");
});

// ---- checkForUpdate: 缓存与失败语义 ----

test("checkForUpdate: 新版本可用; 相同版本不可用", async () => {
  const d = tmpDir();
  try {
    const a = await checkForUpdate({
      currentVersion: "4.0.0", dataDir: d, fetchFn: async () => ({ ok: true, json: async () => ({ version: "4.1.0" }) }),
    });
    assert.equal(a.ok, true);
    assert.equal(a.updateAvailable, true);
    assert.equal(a.latest, "4.1.0");
    const b = await checkForUpdate({
      currentVersion: "4.1.0", dataDir: d, fetchFn: async () => ({ ok: true, json: async () => ({ version: "4.1.0" }) }),
    });
    assert.equal(b.updateAvailable, false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("checkForUpdate: TTL 缓存命中不再发请求; force 绕过; 坏缓存 JSON 容忍", async () => {
  const d = tmpDir();
  try {
    let calls = 0;
    const fetchFn = async () => { calls++; return { ok: true, json: async () => ({ version: "5.0.0" }) }; };
    const a = await checkForUpdate({ currentVersion: "4.0.0", dataDir: d, fetchFn });
    assert.equal(calls, 1);
    assert.equal(a.fromCache, false);
    const b = await checkForUpdate({ currentVersion: "4.0.0", dataDir: d, fetchFn });
    assert.equal(calls, 1, "24h 内第二次检查吃缓存");
    assert.equal(b.fromCache, true);
    assert.equal(b.updateAvailable, true);
    await checkForUpdate({ currentVersion: "4.0.0", dataDir: d, fetchFn, force: true });
    assert.equal(calls, 2, "force 真查");
    fs.writeFileSync(path.join(d, "update-check.json"), "{corrupt!");
    const c = await checkForUpdate({ currentVersion: "4.0.0", dataDir: d, fetchFn });
    assert.equal(c.ok, true, "坏缓存当无缓存, 正常回源");
    assert.equal(calls, 3);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("checkForUpdate: 网络失败 → ok:false 永不 throw (启动路径零风险)", async () => {
  const r = await checkForUpdate({
    currentVersion: "4.0.0", dataDir: tmpDir(), fetchFn: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.updateAvailable, false);
  assert.ok(r.reason.includes("ECONNREFUSED"));
});

test("checkForUpdate: 响应版本号不合法 → ok:false (不进比较)", async () => {
  const r = await checkForUpdate({
    currentVersion: "4.0.0", dataDir: null, fetchFn: async () => ({ ok: true, json: async () => ({ version: "x.y.z" }) }),
  });
  assert.equal(r.ok, false);
});

// ---- 双通道 URL 与解析 ----

test("fetchLatestVersion: npm 通道走 PPX_UPDATE_REGISTRY 镜像覆盖; github 通道解析 tag_name", async () => {
  let seenUrl = "";
  const v = await fetchLatestVersion({
    channel: "npm",
    fetchFn: async (u) => { seenUrl = u; return { ok: true, json: async () => ({ version: "4.2.0" }) }; },
  });
  assert.equal(v, "4.2.0");
  assert.ok(seenUrl.endsWith("/ppxans-harness/latest"), "npm registry latest 端点");

  process.env.PPX_UPDATE_REGISTRY = "https://registry.npmmirror.com";
  await fetchLatestVersion({
    channel: "npm",
    fetchFn: async (u) => { seenUrl = u; return { ok: true, json: async () => ({ version: "4.2.0" }) }; },
  });
  assert.ok(seenUrl.startsWith("https://registry.npmmirror.com/"), "镜像环境变量生效");
  delete process.env.PPX_UPDATE_REGISTRY;

  const g = await fetchLatestVersion({
    channel: "github",
    fetchFn: async (u) => { seenUrl = u; return { ok: true, json: async () => ({ tag_name: "v4.3.0" }) }; },
  });
  assert.equal(g, "4.3.0", "v 前缀剥离");
  assert.ok(seenUrl.includes("api.github.com/repos/"), "GitHub Releases API");
});

test("fetchLatestVersion: HTTP 非 2xx → throw (由 checkForUpdate 转 ok:false)", async () => {
  await assert.rejects(
    () => fetchLatestVersion({ fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
    /HTTP 404/,
  );
});

// ---- 应用计划与通知 ----

test("planApply: npm 装机 → 生成安装命令; 源码 → 手动步骤 (不覆盖本地改动)", () => {
  const npm = planApply("npm", "4.2.0");
  assert.equal(npm.kind, "spawn");
  assert.equal(npm.command, "npm install -g ppxans-harness@4.2.0");
  const src = planApply("source", "4.2.0");
  assert.equal(src.kind, "manual");
  assert.ok(src.lines.join("\n").includes("git pull"));
});

test("updateNotice: 有更新出提示行; 无更新/失败为空", () => {
  assert.match(updateNotice({ ok: true, updateAvailable: true, latest: "4.2.0", current: "4.0.0" }), /4\.2\.0/);
  assert.match(updateNotice({ ok: true, updateAvailable: true, latest: "4.2.0", current: "4.0.0" }), /ppx update/);
  assert.equal(updateNotice({ ok: true, updateAvailable: false }), "");
  assert.equal(updateNotice({ ok: false }), "");
  assert.equal(updateNotice(null), "");
  assert.ok(RELEASES_URL.includes("github.com"));
});

// ---- CLI 子进程 e2e: 本地假 registry (零真实网络) ----

test("端到端: ppx update --check 对本地假 registry 报告新版本并秒退", async () => {
  const dataDir = tmpDir();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: "9.9.9" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, [BIN, "update", "--check"], {
        timeout: 30000,
        env: {
          ...process.env,
          PPX_DATA_DIR: dataDir,
          PPX_UPDATE_REGISTRY: `http://127.0.0.1:${port}`,
          PPX_UPDATE_CHECK: "0", // 显式命令不受影响, 这里顺手证明闸门不查此开关
        },
      }, (err, stdout, stderr) => {
        if (err && err.killed) return reject(new Error("超时未退出"));
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
    });
    assert.equal(out.code, 0);
    assert.match(out.stdout, /9\.9\.9/);
    assert.match(out.stdout, /ppx update/);
    const cache = JSON.parse(fs.readFileSync(path.join(dataDir, "update-check.json"), "utf8"));
    assert.equal(cache.latest, "9.9.9", "检查结果落缓存");
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("端到端: ppx update (源码装机) 打印手动步骤, 不代跑升级", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: "9.9.9" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, [BIN, "update"], {
        timeout: 30000,
        cwd: path.join(HERE, ".."), // 仓库根 = 源码装机形态
        env: { ...process.env, PPX_DATA_DIR: tmpDir(), PPX_UPDATE_REGISTRY: `http://127.0.0.1:${port}` },
      }, (err, stdout, stderr) => {
        if (err && err.killed) return reject(new Error("超时未退出"));
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
    });
    assert.equal(out.code, 0);
    assert.match(out.stdout, /git pull/, "源码装机只给指引");
    assert.doesNotMatch(out.stdout, /npm install -g/, "绝不代跑全局安装");
  } finally {
    server.close();
  }
});
