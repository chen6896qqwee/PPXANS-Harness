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
