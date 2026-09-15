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