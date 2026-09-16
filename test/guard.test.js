import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { installGuard } from "../src/ans/guard.js";

function tmp(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-guard-${n}-`)); }

test("Guard: 总线已安装免疫闸门, 可观测", () => {
  const agent = new PPXAgent({ root: tmp("inst") });
  const st = agent.guardStatus();
  assert.ok(st.enabled, "免疫闸门已启用");
  assert.equal(typeof agent.approveGuard, "function");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard: 普通命令放行 + 审计", async () => {
  const agent = new PPXAgent({ root: tmp("allow") });
  let ran = 0;
  agent.bus.register("memory/read", () => { ran++; return { ok: true }; });
  const r = await agent.bus.command("memory/read", {});
  assert.equal(r.ok, true);
  assert.equal(ran, 1, "普通命令执行");
  const st = agent.guardStatus();
  assert.ok(st.checks >= 1, "有一次审计检查");
  assert.equal(st.blocked, 0);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard: 危险 verb 未授信被阻断", async () => {
  const agent = new PPXAgent({ root: tmp("block") });
  agent.bus.register("delete/asset", () => ({ ok: true }));
  const r = await agent.bus.command("delete/asset", {});
  assert.equal(r.ok, false, "危险命令被阻断");
  assert.equal(r.blocked, true, "标记为拦截");
  const st = agent.guardStatus();
  assert.ok(st.blocked >= 1, "阻断计数+1");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard: 白名单危险 verb 放行", async () => {
  // 通过单次审批 approveGuard 放行
  const agent = new PPXAgent({ root: tmp("whitelist") });
  agent.bus.register("delete/cache", () => ({ ok: true }));
  // 先用 approveOnce 放行一次
  const revoke = agent.approveGuard("delete/cache");
  const r = await agent.bus.command("delete/cache", {});
  assert.equal(r.ok, true, "审批后危险命令可执行");
  revoke(); // 撤销 → 再次应被阻断
  const r2 = await agent.bus.command("delete/cache", {});
  assert.equal(r2.ok, false, "撤销审批后再次阻断");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard: config.agent.guardAllowList 静态白名单", async () => {
  const root = tmp("cfg");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ agent: { guardAllowList: ["purge/logs"] } }));
  const agent = new PPXAgent({ root });
  agent.bus.register("purge/logs", () => ({ ok: true }));
  const r = await agent.bus.command("purge/logs", {});
  assert.equal(r.ok, true, "配置白名单的危险命令放行");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- P0 修复负向 canary: catalog 工具路径 (真实工具收口) ----
// 原缺陷: DANGEROUS_RE 前缀匹配对 memory_import/memory_clear_layer 等真实工具名全部落空,
// 工具路径 blocked 恒为 0 (假绿灯)。以下测试证明: 危险调用会被拒, 安全调用不误伤。
const BLOCK_MARKER = "策略拦截";

function assertBlocked(reply) {
  assert.ok(typeof reply === "string" && reply.includes(BLOCK_MARKER),
    `应被免疫闸门拦截, 实际: ${String(reply).slice(0, 120)}`);
}
function assertPassed(reply) {
  assert.ok(typeof reply !== "string" || !reply.includes(BLOCK_MARKER),
    `不应被拦截, 实际: ${String(reply).slice(0, 120)}`);
}

test("Guard[canary]: memory_import(mode=replace) 被拒绝 (参数级 fail-closed)", async () => {
  const agent = new PPXAgent({ root: tmp("imp-replace") });
  const reply = await agent.tools.call("memory_import", { file: "/nonexistent/x.json", mode: "replace" });
  assertBlocked(reply);
  const st = agent.guardStatus();
  assert.ok(st.blocked >= 1, `blocked 应增长 (实际 ${st.blocked})`);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard[canary]: memory_import(mode=merge) 放行 (可逆操作不误伤)", async () => {
  const agent = new PPXAgent({ root: tmp("imp-merge") });
  const reply = await agent.tools.call("memory_import", { file: "/nonexistent/x.json", mode: "merge" });
  assertPassed(reply); // 放行 → 执行层报"文件不存在"而非策略拦截
  const st = agent.guardStatus();
  assert.equal(st.blocked, 0, "merge 模式不应拦截");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard[canary]: memory_clear_layer(hard=true) 被拒绝 (不可逆物理删除)", async () => {
  const agent = new PPXAgent({ root: tmp("clr-hard") });
  const reply = await agent.tools.call("memory_clear_layer", { layer: 1, hard: true });
  assertBlocked(reply);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard[canary]: memory_clear_layer(hard=false) 放行 (软删可回滚)", async () => {
  const agent = new PPXAgent({ root: tmp("clr-soft") });
  const reply = await agent.tools.call("memory_clear_layer", { layer: 1, hard: false });
  assertPassed(reply);
  const st = agent.guardStatus();
  assert.equal(st.blocked, 0, "软删不应拦截");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard[canary]: memory_forget 放行 (软删可逆, 不误伤隐私遗忘诉求)", async () => {
  const agent = new PPXAgent({ root: tmp("forget") });
  const reply = await agent.tools.call("memory_forget", { id_or_content: "不存在的记忆xyz" });
  assertPassed(reply);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard[canary]: 普通工具 read_file 不误伤", async () => {
  const agent = new PPXAgent({ root: tmp("read") });
  const reply = await agent.tools.call("read_file", { path: "/nonexistent/no.txt" });
  assertPassed(reply);
  const st = agent.guardStatus();
  assert.equal(st.blocked, 0, "普通工具不应拦截");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard[canary]: approveGuard 单次授权后危险调用放行 + wouldBlock 计数", async () => {
  const agent = new PPXAgent({ root: tmp("approve") });
  // 未授权 → 拦截
  const r1 = await agent.tools.call("memory_import", { file: "/nonexistent/x.json", mode: "replace" });
  assertBlocked(r1);
  // 授权一次 → 放行 (执行层报文件不存在)
  const revoke = agent.approveGuard("memory_import");
  const r2 = await agent.tools.call("memory_import", { file: "/nonexistent/x.json", mode: "replace" });
  assertPassed(r2);
  const st = agent.guardStatus();
  assert.ok(st.wouldBlock >= 1, `白名单放行高危项应计 wouldBlock (实际 ${st.wouldBlock})`);
  // 撤销 → 再次拦截
  revoke();
  const r3 = await agent.tools.call("memory_import", { file: "/nonexistent/x.json", mode: "replace" });
  assertBlocked(r3);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("Guard[canary]: audit_verify(quarantine=true) 被拒绝 (隔离重建审计链)", async () => {
  const agent = new PPXAgent({ root: tmp("quar") });
  const reply = await agent.tools.call("audit_verify", { quarantine: true });
  assertBlocked(reply);
  const st = agent.guardStatus();
  assert.ok(st.blocked >= 1);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});