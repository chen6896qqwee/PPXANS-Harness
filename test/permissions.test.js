// test/permissions.test.js — 权限引擎单测
import test from "node:test";
import assert from "node:assert";
import {
  AskForApproval,
  SandboxPolicy,
  TRUSTED_TOOLS,
  createPermissionEngine,
  parseDecision,
} from "../src/permissions/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-perm-"));
}

test("last-match-wins: 后添加的 deny 覆盖先前的 allow", async () => {
  const eng = createPermissionEngine({ approvalMode: AskForApproval.NEVER });
  eng.addRule("git *", "allow");
  eng.addRule("git push", "deny");
  const d = await eng.check("run_command", { command: "git push origin main" });
  assert.equal(d.decision, "deny");
});

test("last-match-wins: 后添加的 allow 覆盖先前的 deny", async () => {
  const eng = createPermissionEngine({ approvalMode: AskForApproval.NEVER });
  eng.addRule("git push", "deny");
  eng.addRule("git *", "allow");
  const d = await eng.check("run_command", { command: "git push origin main" });
  assert.equal(d.decision, "allow");
});

test("规则通配符: '*' 匹配任意工具为 ask", async () => {
  const eng = createPermissionEngine({ approvalMode: AskForApproval.ON_REQUEST });
  eng.addRule("*", "ask");
  const d = await eng.check("run_command", {});
  assert.equal(d.decision, "ask");
});

test("deny-wins: deny 规则直接拒绝, 不被后续 allow 之外的逻辑推翻", async () => {
  const eng = createPermissionEngine({ approvalMode: AskForApproval.NEVER });
  eng.addRule("rm *", "deny");
  const d = await eng.check("run_command", { command: "rm -rf x" });
  assert.equal(d.decision, "deny");
  assert.ok(d.reason.includes("deny"));
});

test("只读沙箱: 写/执行类工具升级为 ask", async () => {
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.READ_ONLY,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const d = await eng.check("run_command", { command: "echo hi" });
  assert.equal(d.decision, "ask");
});

test("只读沙箱: 读工具不受影响仍放行", async () => {
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.READ_ONLY,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const d = await eng.check("read_file", { path: "x" });
  assert.equal(d.decision, "allow");
});

test("只读沙箱: allow 规则可放行写工具", async () => {
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.READ_ONLY,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  eng.addRule("run_command", "allow");
  const d = await eng.check("run_command", { command: "echo hi" });
  assert.equal(d.decision, "allow");
});

test("workspace 沙箱: 路径越界拒绝 (跨平台 ../../ 外部)", async () => {
  const root = tmpDir();
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: root,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const outside = path.resolve(root, "..", "evil.txt");
  const d = await eng.check("edit_file", { path: outside });
  assert.equal(d.decision, "deny");
  assert.ok(d.reason.includes("越界"));
});

test("workspace 沙箱: Windows 风格绝对路径越界拒绝", async () => {
  const root = tmpDir();
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: root,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  // 构造一个明显在 root 之外的绝对路径
  const outside = path.isAbsolute(root)
    ? path.join(path.parse(root).root, "Windows", "System32", "x.txt")
    : path.resolve("/abs/outside/x.txt");
  const d = await eng.check("edit_file", { path: outside });
  assert.equal(d.decision, "deny");
});

test("workspace 沙箱: 工作区内路径放行", async () => {
  const root = tmpDir();
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: root,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const inside = path.join(root, "a.txt");
  const d = await eng.check("edit_file", { path: inside });
  assert.equal(d.decision, "allow");
});

test("workspace 沙箱: cwd 越界也拒绝", async () => {
  const root = tmpDir();
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: root,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const d = await eng.check("run_command", { command: "ls", cwd: path.resolve(root, "..") });
  assert.equal(d.decision, "deny");
});

test("网络关闭: http 类工具升级 ask", async () => {
  const eng = createPermissionEngine({
    networkAccess: false,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const d = await eng.check("http_request", { url: "http://x" });
  assert.equal(d.decision, "ask");
});

test("网络开启: http 类工具不因此升级", async () => {
  const eng = createPermissionEngine({
    networkAccess: true,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const d = await eng.check("http_request", { url: "http://x" });
  assert.equal(d.decision, "allow");
});

test("canUseTool 优先: deny 回调直接拒绝", async () => {
  const eng = createPermissionEngine({
    canUseTool: async () => ({ behavior: "deny", message: "casdk deny" }),
  });
  const d = await eng.check("run_command", {});
  assert.equal(d.decision, "deny");
  assert.equal(d.reason, "casdk deny");
});

test("canUseTool 覆盖规则: allow 回调放行命中 deny 规则的调用", async () => {
  const eng = createPermissionEngine({
    canUseTool: async () => "allow",
    approvalMode: AskForApproval.NEVER,
  });
  eng.addRule("*", "deny");
  const d = await eng.check("read_file", {});
  assert.equal(d.decision, "allow");
});

test("never 模式: ask 规则降级为 deny", async () => {
  const eng = createPermissionEngine({ approvalMode: AskForApproval.NEVER });
  eng.addRule("run_command", "ask");
  const d = await eng.check("run_command", {});
  assert.equal(d.decision, "deny");
});

test("unless-trusted: 非白名单工具 ask, 白名单工具 allow", async () => {
  const eng = createPermissionEngine({ approvalMode: AskForApproval.UNLESS_TRUSTED });
  assert.equal((await eng.check("run_command", {})).decision, "ask");
  assert.equal((await eng.check("read_file", {})).decision, "allow");
});

test("on-request: requires_approval 工具 ask, 其余 allow", async () => {
  const eng = createPermissionEngine({ approvalMode: AskForApproval.ON_REQUEST });
  assert.equal((await eng.check("run_command", {})).decision, "ask");
  assert.equal((await eng.check("read_file", {})).decision, "allow");
});

test("TRUSTED_TOOLS 含预期工具", () => {
  for (const t of ["get_time", "list_dir", "read_file", "memory_search", "repo_map", "goal_board", "status"]) {
    assert.ok(TRUSTED_TOOLS.includes(t), t);
  }
});

test("parseDecision 兼容字符串与对象", () => {
  assert.equal(parseDecision("allow"), "allow");
  assert.equal(parseDecision("deny"), "deny");
  assert.equal(parseDecision({ behavior: "allow" }), "allow");
  assert.equal(parseDecision({ decision: "deny" }), "deny");
  assert.equal(parseDecision(null), null);
});
