// test/fetch-page.test.js - fetch_page 工具测试
// 网络 gate: 默认跳过真实抓取 (mock 环境), PPX_NET_TEST=1 时才真抓
// 与 advanced.tools.test.js 保持一致, 消除 flaky
import test from "node:test";
import assert from "node:assert";
import { ToolCatalog, registerAdvancedTools, Scheduler } from "../src/tools/index.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const NET = process.env.PPX_NET_TEST === "1";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-fp-"));
const cat = new ToolCatalog();
registerAdvancedTools(cat, { dataDir, scheduler: new Scheduler(dataDir), onMemoryNote: () => {} });

test("fetch_page: 工具已注册", () => {
  const t = cat.list();
  assert.ok(t.includes("fetch_page"), "fetch_page 在工具列表");
});

test("fetch_page: 抓取公开网页正文", { skip: !NET, timeout: 20000 }, async () => {
  const r = await cat.call("fetch_page", { url: "https://example.com", maxChars: 500 });
  const j = JSON.parse(r);
  assert.equal(j.status, 200, "HTTP 200");
  assert.ok(j.chars > 0, "有正文内容: " + j.chars);
  assert.ok(/Example Domain/i.test(j.content), "正文含标题文本");
});

test("fetch_page: SSRF 拒绝内网地址", async () => {
  const r = await cat.call("fetch_page", { url: "http://127.0.0.1:8899/" });
  assert.ok(/拒绝|失败|error/i.test(r + ""), "拒绝内网: " + r.slice(0, 80));
});
