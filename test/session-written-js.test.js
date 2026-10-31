// test/session-written-js.test.js - 会话内新写脚本的执行拦截 (2026-10-31 安全收紧)
//
// 钉住的契约: 命令守卫 argv0 白名单放行 `node app.js`, 但 app.js 若是**本会话**由
// write_file/append_file/move_file/apply_patch 写出的, "写文件 + node 执行" 连招就是
// 绕过白名单的任意代码执行。此测试钉住: 会话内写过的脚本 → run_command 拒;
// 会话开始前就存在的脚本 → 照常可执行 (正常用法不受影响)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCatalog, registerBuiltinTools } from "../src/tools/index.js";
import { registerV3Tools } from "../src/tools/v3.js";

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-sesswrite-"));
}

function mkCatalog(root) {
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: root });
  registerV3Tools(c, { rootDir: root });
  return c;
}

test("安全: write_file 新写的脚本 node 执行被拦 (含链式命令)", async () => {
  const root = mkRoot();
  const c = mkCatalog(root);
  try {
    const w = await c.call("write_file", { path: "evil.js", content: "console.log('pwned');" });
    assert.ok(JSON.parse(w).ok, "写入应成功");
    const r1 = await c.call("run_command", { command: "node evil.js" });
    assert.match(r1, /需人工审批/, "直接执行应被拦");
    assert.ok(!r1.includes("pwned"), "不得有执行输出");
    const r2 = await c.call("run_command", { command: "echo hi && node evil.js" });
    assert.match(r2, /需人工审批/, "链式命令同样应被拦");
    const r3 = await c.call("run_command", { command: 'node ".\\evil.js"' });
    assert.match(r3, /需人工审批/, "引号包裹的相对路径应被拦");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("安全: append_file/apply_patch 写过的脚本同样被拦", async () => {
  const root = mkRoot();
  const c = mkCatalog(root);
  try {
    await c.call("append_file", { path: "fresh.js", content: "console.log('appended');" });
    const r1 = await c.call("run_command", { command: "node fresh.js" });
    assert.match(r1, /需人工审批/, "append 创建的脚本应被拦");

    const p = await c.call("apply_patch", {
      content: "patched.js\n<<<<<<< SEARCH\n=======\nconsole.log('patched');\n>>>>>>> REPLACE",
    });
    assert.ok(JSON.parse(p).ok, "apply_patch 新建应成功");
    const r2 = await c.call("run_command", { command: "node patched.js" });
    assert.match(r2, /需人工审批/, "apply_patch 新建的脚本应被拦");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("安全: 会话前已存在的脚本不受影响 (正常用法放行)", { timeout: 30000 }, async () => {
  const root = mkRoot();
  // 关键: 在注册工具**之前**落盘 —— 不进入会话写登记表
  fs.writeFileSync(path.join(root, "ok.js"), "console.log('PXX_OK_OUTPUT');");
  const c = mkCatalog(root);
  try {
    const r = await c.call("run_command", { command: "node ok.js" });
    assert.ok(!r.includes("需人工审批"), "既有脚本不应被拦");
    assert.ok(r.includes("PXX_OK_OUTPUT"), "应真实执行并拿到输出");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
