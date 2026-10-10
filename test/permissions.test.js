// test/permissions.test.js — 权限引擎单测
import test from "node:test";
import assert from "node:assert";
import {
  AskForApproval,
  SandboxPolicy,
  TRUSTED_TOOLS,
  createPermissionEngine,
  parseDecision,
  applyPreset,
  currentPreset,
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

// ---- P1-1 回归 (2026-10-10): URL 不是本地路径 ----
// 病根: collectPaths 裸正则把 https://host/path 切成 s://host/path, path.resolve 把 s: 当盘符
//   → 误判"路径越界", git clone / curl / npm --registry 全被拦且理由是假的。
// 本组锁两件事: ①URL 命令不再被误判越界 ②真实越界仍被拦(修复不得放宽安全边界)。
test("P1-1: git clone https://... 不再被误判为路径越界", async () => {
  const root = tmpDir();
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: root,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const d = await eng.check("run_command", { command: "git clone https://github.com/a/b.git" });
  assert.notEqual(d.decision, "deny", `URL 不应触发越界 deny, 实际: ${d.decision} / ${d.reason}`);
});

test("P1-1: curl https://... 与 npm --registry=https://... 不误判越界", async () => {
  const root = tmpDir();
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: root,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const a = await eng.check("run_command", { command: "curl https://api.example.com/v1/data" });
  assert.notEqual(a.decision, "deny", "curl URL 不应越界 deny");
  const b = await eng.check("run_command", { command: "npm install --registry=https://registry.npmjs.org express" });
  assert.notEqual(b.decision, "deny", "npm --registry URL 不应越界 deny");
});

test("P1-1: URL 命令里夹带真实越界路径仍被拦 (修复未放宽边界)", async () => {
  const root = tmpDir();
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: root,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const evil = path.resolve(root, "..", "evil.sh");
  // URL + 真实越界路径混在同一条命令里: 剔 URL 后仍必须抓到越界
  const d = await eng.check("run_command", { command: `curl https://example.com/x -o ${evil}` });
  assert.equal(d.decision, "deny", "URL 之外的真实越界路径必须仍被拦");
  assert.ok(d.reason.includes("越界"));
});

test("P1-1: 经典越界命令不受影响 (cat /etc/passwd 风格)", async () => {
  const root = tmpDir();
  const eng = createPermissionEngine({
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: root,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  const outside = path.isAbsolute(root)
    ? path.join(path.parse(root).root, "etc", "passwd")
    : "/etc/passwd";
  const d = await eng.check("run_command", { command: `cat ${outside}` });
  assert.equal(d.decision, "deny", "绝对路径越界必须被拦");
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

// --- DSH (DeepSeek Harness) 对齐: 具名预设 / 一次性提权 / 应答者链 fail closed ---

test("权限预设: 捆绑应用 + custom 折叠 + 未知预设抛错", () => {
  const eng = createPermissionEngine({ workspaceRoot: os.tmpdir() });
  applyPreset(eng, "read-only");
  assert.equal(eng.sandbox, SandboxPolicy.READ_ONLY);
  assert.equal(eng.approvalMode, AskForApproval.ON_REQUEST);
  assert.equal(currentPreset(eng), "read-only");
  // 手动拧 knob 到非预设组合 → custom
  eng.approvalMode = AskForApproval.NEVER;
  assert.equal(currentPreset(eng), "custom");
  // danger-full-access 预设捆绑 never (DSH 事故复盘: 完全放开必须全自动+可丢弃环境)
  applyPreset(eng, "danger-full-access");
  assert.equal(eng.sandbox, SandboxPolicy.DANGER_FULL_ACCESS);
  assert.equal(eng.approvalMode, AskForApproval.NEVER);
  assert.throws(() => applyPreset(eng, "no-such"), /未知权限预设/);
});

test("一次性提权: 单次消费后自动还原, 且不改审批策略", async () => {
  const root = os.tmpdir();
  const eng = createPermissionEngine({
    workspaceRoot: root,
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    approvalMode: AskForApproval.ON_REQUEST,
  });
  // 越界写: 默认 deny
  let r = await eng.check("write_file", { path: "/etc/evil.txt", content: "x" });
  assert.equal(r.decision, "deny");
  // 人工批准一次性提权到 full: 本次放行 (on-request 下写文件非高危, 直接 allow)
  eng.requestEscalation(SandboxPolicy.DANGER_FULL_ACCESS, { oneShot: true });
  r = await eng.check("write_file", { path: "/etc/evil.txt", content: "x" });
  assert.equal(r.decision, "allow", `提权后应放行, 实际: ${r.reason}`);
  // 第二次: 已消费, 回落 deny
  r = await eng.check("write_file", { path: "/etc/evil.txt", content: "x" });
  assert.equal(r.decision, "deny", "oneShot 应自动还原");
  // 会话级提权 (oneShot=false): 持续生效, 沙箱变了但审批策略没变
  eng.requestEscalation(SandboxPolicy.DANGER_FULL_ACCESS, { oneShot: false });
  r = await eng.check("delete_file", { path: "/etc/passwd" });
  assert.notEqual(r.reason, "", "应正常决策");
  assert.equal(eng.sandbox, SandboxPolicy.WORKSPACE_WRITE, "会话策略本身不被提权改写");
});

test("应答者链: allow/deny 生效, 异常与 NEVER 模式 fail closed", async () => {
  const root = os.tmpdir();
  // 应答者放行
  const engAllow = createPermissionEngine({
    workspaceRoot: root, approvalMode: AskForApproval.ON_REQUEST,
    onAsk: async (tool, args, reason) => "allow",
  });
  assert.equal((await engAllow.check("run_command", { command: "curl http://x" })).decision, "allow");
  // 应答者拒绝
  const engDeny = createPermissionEngine({
    workspaceRoot: root, approvalMode: AskForApproval.ON_REQUEST,
    onAsk: async () => "deny",
  });
  assert.equal((await engDeny.check("run_command", { command: "curl http://x" })).decision, "deny");
  // 应答者抛异常 → fail closed
  const engBoom = createPermissionEngine({
    workspaceRoot: root, approvalMode: AskForApproval.ON_REQUEST,
    onAsk: async () => { throw new Error("UI 挂了"); },
  });
  const rBoom = await engBoom.check("run_command", { command: "curl http://x" });
  assert.equal(rBoom.decision, "deny");
  assert.ok(/fail closed/.test(rBoom.reason), "异常应标注 fail closed");
  // NEVER 模式: 即使注册了应答者, 本该 ask 的调用 (网络被禁的 http_request) 也直接降级拒绝
  const engNever = createPermissionEngine({
    workspaceRoot: root, approvalMode: AskForApproval.NEVER,
    onAsk: async () => "allow",
  });
  const rNever = await engNever.check("http_request", { url: "http://x" });
  assert.equal(rNever.decision, "deny", "never 不进应答者链, ask 直接降级拒绝");
});

// --- ZCode 工具能力门 (声明式元数据裁定) ---

const HIGH_TOOL_CAPS = { my_shell: { destructive: true, riskLevel: "high", sideEffect: "system" } };

test("能力门: high 风险默认 ask, 应答者可裁; autoApproveHighRisk 直通", async () => {
  const eng = createPermissionEngine({
    workspaceRoot: os.tmpdir(), approvalMode: AskForApproval.ON_FAILURE,
    capabilityGate: true, getCapability: (n) => HIGH_TOOL_CAPS[n] || null,
    onAsk: async () => "deny",
  });
  assert.equal((await eng.check("my_shell", {})).decision, "deny", "high 应触发 ask → 应答者拒绝");
  // autoApproveHighRisk: 高风险直通
  const eng2 = createPermissionEngine({
    workspaceRoot: os.tmpdir(), approvalMode: AskForApproval.ON_FAILURE,
    capabilityGate: true, getCapability: (n) => HIGH_TOOL_CAPS[n] || null,
    autoApproveHighRisk: true,
  });
  assert.equal((await eng2.check("my_shell", {})).decision, "allow");
});

test("能力门: high + never 模式降级拒绝 (高危不可静默放行, CVE 教训)", async () => {
  const eng = createPermissionEngine({
    workspaceRoot: os.tmpdir(), approvalMode: AskForApproval.NEVER,
    capabilityGate: true, getCapability: (n) => HIGH_TOOL_CAPS[n] || null,
  });
  const r = await eng.check("my_shell", {});
  assert.equal(r.decision, "deny");
  assert.ok(/降级拒绝/.test(r.reason));
});

test("能力门: plan 模式只读直通, 破坏性拒绝", async () => {
  const eng = createPermissionEngine({
    workspaceRoot: os.tmpdir(), approvalMode: AskForApproval.ON_REQUEST,
    capabilityGate: true, planEnabled: true,
    getCapability: (n) => n === "reader" ? { readOnly: true, riskLevel: "low" }
      : n === "killer" ? { destructive: true, riskLevel: "high" } : null,
  });
  assert.equal((await eng.check("reader", {})).decision, "allow", "plan 模式只读直通");
  assert.equal((await eng.check("killer", {})).decision, "deny", "plan 模式破坏性拒绝");
  // 退出 plan 模式: 恢复正常判定 (高风险 ask)
  eng.planEnabled = false;
  assert.equal((await eng.check("killer", {})).decision, "ask", "退 plan 后高风险走 ask");
});

test("能力门关闭: 行为与旧版完全一致 (向后兼容)", async () => {
  const eng = createPermissionEngine({
    workspaceRoot: os.tmpdir(), approvalMode: AskForApproval.NEVER,
    capabilityGate: false, getCapability: (n) => HIGH_TOOL_CAPS[n] || null,
  });
  assert.equal((await eng.check("my_shell", {})).decision, "allow", "关闸时 high 工具按旧语义放行");
});
