// test/tool-surface-stability-2026-11-18.test.js - 工具面跨机稳定 (release gate 回归)
//
// 背景 (2026-11-18): v5.3.0 GitHub Release 在 ubuntu 上必红, 本机却全绿。
//   git 查下来两条根因都在"README 数字锚点随环境浮动":
//     ① shell 工具: 没有 bash 就整个不注册 → 工具数 / 核心 schema / 上下文 token /
//        MCP 工具数四项同时随机器浮 1 (本地 Windows 无 bash, CI ubuntu 自带 bash)。
//     ② ctx_tokens: 测量用 mkdtempSync 随机临时目录, 而【工作目录】段默认把绝对路径
//        写进 system prompt → 同一份代码在不同路径长度下差 10 token 上下, 跨机必不对齐。
//   本文件钉住两条不变量, 让"工具面与 README 口径"以后再也不会随运行环境漂移。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("shell 工具: 本机无 bash 也照常注册, 执行时如实报不可用", async () => {
  const { ToolCatalog } = await import("../src/tools/catalog.js");
  const { registerShellSessionTools } = await import("../src/tools/shell-session.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-shell-required-"));
  try {
    // 指向一个确定不存在的 shell_path, 模拟"本机没有 bash" (跨平台都不会误判)
    const catalog = new ToolCatalog();
    const res = registerShellSessionTools(catalog, {
      rootDir: root,
      config: { shell_path: path.join(root, "definitely-no-bash-here") },
    });
    const names = catalog.list();
    assert.ok(names.includes("shell"), "工具面必须稳定: 无 bash 也要注册 shell");
    assert.equal(res.available, false, "available 仍如实反映 bash 不可用");

    const tool = catalog.metaOf("shell");
    const out = JSON.parse(await tool.execute({ command: "echo hi" }, {}));
    assert.equal(out.available, false);
    assert.match(out.error, /bash/, "错误信息要说明缺 bash 并给安装指引");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("README 数字口径: ctx_tokens 与临时目录路径长度无关", async () => {
  const { PPXAgent } = await import("../src/agent/index.js");
  const tmpBase = os.tmpdir();
  const saved = process.env.PPX_PROMPT_WORKSPACE_MODE;
  const measure = (dirName) => {
    const root = path.join(tmpBase, dirName);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 首次不存在 */ }
    fs.mkdirSync(root, { recursive: true });
    process.env.PPX_PROMPT_WORKSPACE_MODE = "neutral";
    const a = new PPXAgent({ root, configFile: null });
    try {
      a._context("");
      const st = a._lastContextStats || {};
      return (Number(st.systemTokens) || 0) + (Number(st.toolTokens) || 0);
    } finally {
      try { a.shutdown(); } catch { /* 关闭失败不影响断言 */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    const short = measure("ppx-c1");
    const long = measure("ppx-context-token-stability-probe-long-name");
    assert.equal(long, short, "neutral 口径下 ctx_tokens 不得随工作目录长短变化");
    assert.ok(short > 0, "ctx_tokens 必须是真实测量值, 不能为 0");
  } finally {
    if (saved === undefined) delete process.env.PPX_PROMPT_WORKSPACE_MODE;
    else process.env.PPX_PROMPT_WORKSPACE_MODE = saved;
  }
});

test("README 数字口径: measure() 对同一台机器两次调用结果完全一致", async () => {
  // 只钉可复现性, 不钉具体数字 —— 具体数字由 `npm run verify` 的 readme-sync 项守。
  // (在这里直接断言锚点会形成循环: 新增测试文件本身就让 test_files +1, 测试先红, --fix 反而跑不动。)
  const { measure } = await import("../scripts/readme-sync-check.js");
  const first = await measure();
  const second = await measure();
  assert.deepEqual(second, first, "measure() 必须可复现, 否则 README 锚点永远追不上");
  for (const key of ["tools", "skills", "core_schema", "ctx_tokens", "mcp_tools", "test_files"]) {
    assert.equal(typeof first[key], "number", `measure() 必须给出数值型 ${key}`);
    assert.ok(first[key] > 0, `measure() 的 ${key} 不应为 0`);
  }
});
