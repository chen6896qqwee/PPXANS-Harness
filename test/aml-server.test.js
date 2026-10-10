import test from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createAmlServer } from "../src/aml-server.js";

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aml-"));
  process.env.PPX_AML_DATA = dataDir;
  process.env.PPX_AML_AUTH = "none";
  const server = createAmlServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  try { return await fn(url); }
  finally { await new Promise((r) => server.close(r)); }
}

test("P1#10: aml-server Add/Search 基本流程", { timeout: 15000 }, async () => {
  await withServer(async (url) => {
    const add = await fetch(url("/v1/memories/add"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "s1", messages: [{ role: "user", content: "皮皮虾喜欢实时数据" }] }),
    });
    assert.equal(add.status, 200);
    const addJ = await add.json();
    assert.equal(addJ.status, "ok");
    assert.equal(addJ.stored, 1);
    const search = await fetch(url("/v1/memories/search"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "s1", query: "实时数据" }),
    });
    assert.equal(search.status, 200);
    const sj = await search.json();
    assert.ok(sj.count >= 1, "能检索到刚存的记忆");
  });
});

test("P1#10: aml-server 1MB body 上限返回 413", { timeout: 15000 }, async () => {
  await withServer(async (url) => {
    const big = { scope: "s", messages: [{ content: "x".repeat(2 * 1024 * 1024) }] };
    const r = await fetch(url("/v1/memories/add"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(big),
    });
    assert.equal(r.status, 413);
  });
});

test("P1#10: aml-server 限流 429 (60/min 令牌桶)", { timeout: 15000 }, async () => {
  await withServer(async (url) => {
    let got429 = false;
    for (let i = 0; i < 70; i++) {
      const r = await fetch(url("/health"));
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, "超过 60 req/min 应触发 429");
  });
});

// ---- 回归守卫: ESM 模块顶层副作用 ----
// 缺陷史 (2026-10-09): aml-server.js 曾在模块顶层 `const DATA = process.env.PPX_AML_DATA || ...`
//   并立即 `new FactStore(DATA, {})`。而静态 import 早于调用方任何代码执行, 于是测试里
//   "先设 process.env.PPX_AML_DATA = tmp 再 import" 完全无效 —— 实例仍指向 <项目>/data/aml,
//   仅【导入】本模块就会创建生产数据文件 (实测 4 个测试文件受害, 每次跑测试都污染)。
// 检测手法: 给子进程一个【尚不存在】的探针目录作为 PPX_AML_DATA, 然后只做 import。
//   · 惰性实现 → 探针目录不会被创建
//   · 顶层副作用 → 探针目录被凭空创建 (或写入 facts.json)
// 刻意不用"检查项目 data/ 有没有出现"的写法: 测试进程自身 import 本模块就会先造出该目录,
// 基准(hadBefore)被污染后断言会被跳过, 守卫形同虚设 (已实测踩过)。
test("回归守卫: 仅 import aml-server 不得产生任何磁盘副作用 (模块顶层必须惰性)", async () => {
  const probeDir = path.join(os.tmpdir(), "ppx-aml-nosideeffect-" + process.pid + "-" + Date.now());
  assert.ok(!fs.existsSync(probeDir), "前置条件: 探针目录必须预先不存在");
  try {
    const { execFileSync } = await import("node:child_process");
    const script = `import(${JSON.stringify(new URL("../src/aml-server.js", import.meta.url).href)})`
      + `.then(() => console.log("imported"))`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, PPX_AML_DATA: probeDir },
    });
    assert.match(out, /imported/, "子进程应能成功 import aml-server");
    assert.ok(!fs.existsSync(probeDir),
      "仅 import 就创建了 " + probeDir + " —— 模块顶层仍有副作用, PPX_AML_DATA 隔离会失效, 测试将污染生产目录");
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
});
