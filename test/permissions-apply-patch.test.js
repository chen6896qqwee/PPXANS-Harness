// test/permissions-apply-patch.test.js — apply_patch 审批口径守卫 (2026-10-05)
// 背景: apply_patch 在 config 的核心 schema 披露名单里 (模型每轮都看得到它), 但
// REQUIRES_APPROVAL_TOOLS 又把它和 run_command/delete_file 同列 → ON_REQUEST 下判 ask,
// 而 headless 进程没有审批面 (agent/index.js 快速拒绝), 结果是"发给了模型一个它永远
// 用不了的工具" —— 真跑基准 json-edit 就是 sequence:["apply_patch"] + 权限拦截而死。
// 本文件钉死修好后的口径: 工作区内的补丁直通, 越界/落点不明的补丁照旧升级审批,
// 破坏性/可执行类 (run_command/delete_file/rm) 一律不变。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPermissionEngine, AskForApproval, SandboxPolicy } from "../src/permissions/index.js";
import { PPXAgent } from "../src/agent/index.js";

const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-patch-${tag}-`));

const engOn = (root) => createPermissionEngine({
  approvalMode: AskForApproval.ON_REQUEST,
  sandbox: SandboxPolicy.WORKSPACE_WRITE,
  workspaceRoot: root,
});

// aider SR 块: 头一行是路径, 落点藏在 content 字符串里 (collectPaths 只看 args 键值)
const patch = (p, search, replace) =>
  `<<<<<<< SEARCH\n${p}\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

test("工作区内 apply_patch (相对路径落点) → allow, 不再 ask", async () => {
  const root = mk("in");
  try {
    const eng = engOn(root);
    const d = await eng.check("apply_patch", { content: patch("calc.js", "return a - b;", "return a + b;") });
    assert.equal(d.decision, "allow", `工作区内补丁应免审批, 实际: ${d.decision} / ${d.reason}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("工作区内 apply_patch (绝对路径落点, 仍在根内) → allow", async () => {
  const root = mk("abs");
  try {
    const eng = engOn(root);
    const d = await eng.check("apply_patch", { content: patch(path.join(root, "src", "a.js"), "x", "y") });
    assert.equal(d.decision, "allow", `根内绝对路径应免审批, 实际: ${d.reason}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("apply_patch 落点越界 (绝对路径 / ../ 相对穿越) → 仍 ask", async () => {
  const root = mk("out");
  try {
    const eng = engOn(root);
    const outsideAbs = path.resolve(root, "..", "evil.js");
    const d1 = await eng.check("apply_patch", { content: patch(outsideAbs, "x", "y") });
    assert.equal(d1.decision, "ask", `越界绝对路径必须升级审批, 实际: ${d1.decision}`);
    const d2 = await eng.check("apply_patch", { content: patch("../evil.js", "x", "y") });
    assert.equal(d2.decision, "ask", `相对穿越同样必须问 (旧实现只看绝对路径)`);
    // 多块里只要有一块越界 → 整份补丁问 (不是"多数在根内就放行")
    const d3 = await eng.check("apply_patch", {
      content: patch("ok.js", "x", "y") + patch("/etc/passwd", "x", "y"),
    });
    assert.equal(d3.decision, "ask", "混合落点按最危险的那块定级");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("apply_patch 无法证明落点 (content 无合法块 / 块无路径行) → ask (fail closed)", async () => {
  const root = mk("unknown");
  try {
    const eng = engOn(root);
    assert.equal((await eng.check("apply_patch", { content: "随便一段没有标记的文本" })).decision, "ask");
    assert.equal((await eng.check("apply_patch", {})).decision, "ask");
    // 显式 requires_approval 仍是硬要求, 不因"在根内"被绕过
    assert.equal((await eng.check("apply_patch", {
      content: patch("a.js", "x", "y"), requires_approval: true,
    })).decision, "ask", "显式 requires_approval 优先于免审批");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("破坏性/可执行类不在放宽范围内: run_command / delete_file / rm 照旧 ask", async () => {
  const root = mk("keep");
  try {
    const eng = engOn(root);
    for (const [tool, args] of [
      ["run_command", { command: "echo hi" }],
      ["run_command", { command: "git push origin main" }],
      ["delete_file", { path: path.join(root, "a.txt") }],
      ["rm", { path: "a.txt" }],
    ]) {
      const d = await eng.check(tool, args);
      assert.equal(d.decision, "ask", `${tool} (${JSON.stringify(args)}) 必须仍问, 实际: ${d.decision}`);
    }
    // 带删除语义的命令: 只要求"绝不静默放行" (命中命令守卫/越界正则时直接 deny 更严)
    const hard = await eng.check("run_command", { command: "rm -rf ./x" });
    assert.notEqual(hard.decision, "allow", "rm -rf 绝不能 allow");
    // 只读工具不受影响
    assert.equal((await eng.check("read_file", { path: "a.txt" })).decision, "allow");
    // write_file 本来就不审批 (口径一致性的参照)
    assert.equal((await eng.check("write_file", { path: "a.txt", content: "x" })).decision, "allow");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("相对路径越界检测: collectPaths 里的相对落点也会被 resolve 后判包含", async () => {
  const root = mk("rel");
  try {
    const eng = engOn(root);
    // 根内相对路径 → 通过沙箱检查 (不 deny)
    const inside = await eng.check("write_file", { path: "notes/a.txt", content: "x" });
    assert.notEqual(inside.decision, "deny", `根内相对路径不该被沙箱拒绝: ${inside.reason}`);
    // 相对穿越 + 沙箱 WORKSPACE_WRITE → 越界 deny (安全网不变, 只是现在也看得见相对形式)
    const esc = await eng.check("write_file", { path: "../outside.txt", content: "x" });
    assert.equal(esc.decision, "deny", "相对穿越路径应被越界拒绝 (旧实现因只看绝对路径而漏判)");
    const escDir = await eng.check("list_dir", { path: ".." });
    assert.equal(escDir.decision, "deny", "目录类相对越界同样拒绝");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("端到端 (headless, 无审批面): 工作区内 apply_patch 真的能改文件", async () => {
  const root = mk("e2e");
  const agent = new PPXAgent({ root, dataDir: path.join(root, ".ppx") });
  try {
    fs.writeFileSync(path.join(root, "calc.js"), "export function add(a, b) {\n  return a - b;\n}\n", "utf8");
    assert.equal(agent.hasApprovalSurface(), false, "本用例就是 headless 场景");
    const out = String(await agent._runTool("apply_patch", {
      content: patch("calc.js", "  return a - b;", "  return a + b;"),
    }));
    assert.ok(!out.startsWith("[工具错误]"), `不应被权限拦下, 实际: ${out.slice(0, 160)}`);
    assert.ok(/"ok":true/.test(out), `补丁应成功应用, 实际: ${out.slice(0, 160)}`);
    assert.match(fs.readFileSync(path.join(root, "calc.js"), "utf8"), /return a \+ b;/);
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
