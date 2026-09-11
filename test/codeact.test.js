// test/codeact.test.js - code_act 工具 (CodeAct 出口, 默认关闭)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCodeAct, registerBuiltinTools } from "../src/tools/builtin.js";
import { ToolCatalog } from "../src/tools/catalog.js";

function makeCatalog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-codeact-"));
  const catalog = new ToolCatalog();
  registerBuiltinTools(catalog, { rootDir: root, facts: null, memory: null });
  return { root, catalog };
}

test("runCodeAct: node 脚本执行并返回输出", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-codeact-"));
  const out = await runCodeAct(root, "node", "console.log('hello codeact')", 10000);
  assert.ok(out.includes("hello codeact"), `应输出 hello, 实际: ${out}`);
});

test("code_act 工具: 默认关闭 (security.code_act 缺省 false)", async () => {
  const { catalog } = makeCatalog();
  const res = await catalog.call("code_act", { language: "node", code: "console.log(1)" }, { agent: { config: { security: {} } } });
  assert.ok(res.includes("未开启"), `默认应拒绝, 实际: ${res}`);
});

test("code_act 工具: 开启后执行脚本", async () => {
  const { catalog } = makeCatalog();
  const res = await catalog.call("code_act", { language: "node", code: "console.log('ok:42')" }, { agent: { config: { security: { code_act: true } } } });
  assert.ok(res.includes("ok:42"), `开启后应执行, 实际: ${res}`);
});

test("code_act 工具: 代码命中黑名单被拒绝", async () => {
  const { catalog } = makeCatalog();
  const res = await catalog.call("code_act", { language: "node", code: "console.log('rm -rf /')" }, { agent: { config: { security: { code_act: true } } } });
  assert.ok(res.includes("黑名单"), `危险代码应被拒, 实际: ${res}`);
});

test("code_act 工具: 非法语言被拒绝", async () => {
  const { catalog } = makeCatalog();
  const res = await catalog.call("code_act", { language: "bash", code: "echo hi" }, { agent: { config: { security: { code_act: true } } } });
  assert.ok(res.includes("仅支持"), `非法语言应被拒, 实际: ${res}`);
});

test("runCodeAct: 沙箱剥离敏感环境变量", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-codeact-"));
  const prev = process.env.TEST_SECRET_KEY;
  process.env.TEST_SECRET_KEY = "super-secret-value";
  try {
    const out = await runCodeAct(root, "node", "console.log('val=' + (process.env.TEST_SECRET_KEY || 'undefined'))", 10000);
    assert.ok(out.includes("val=undefined"), `沙箱应剥离敏感变量, 实际: ${out}`);
  } finally {
    if (prev === undefined) delete process.env.TEST_SECRET_KEY; else process.env.TEST_SECRET_KEY = prev;
  }
});

test("runCodeAct: 超时强制终止死循环脚本", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-codeact-"));
  const out = await runCodeAct(root, "node", "while(true){}", 1500);
  assert.ok(out.includes("超时") || out.includes("强制终止"), `死循环应被超时强杀, 实际: ${out}`);
});
