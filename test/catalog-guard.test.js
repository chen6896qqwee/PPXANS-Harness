// test/catalog-guard.test.js - P0①: 免疫闸门接入工具收口 + deny-wins 策略合并
// 修 MERGE-REPORT 遗留 P2 (guard 只盖总线命令, 工具走 catalog 绕过全局闸门)
import { test } from "node:test";
import assert from "node:assert";
import { ToolCatalog, consolidateDecisions } from "../src/tools/catalog.js";
import { installGuard, installGuardOnCatalog } from "../src/ans/guard.js";

function makeCatalog() {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "read_file", description: "读文件",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => "file-content",
  });
  catalog.register({
    name: "delete_asset", description: "删资产",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => "deleted",
  });
  catalog.register({
    name: "echo", description: "回显",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => "echo",
  });
  return catalog;
}

// ---- deny-wins 合并 ----
test("consolidateDecisions: 任一 deny 一票否决 (含低优先级)", () => {
  const r = consolidateDecisions([
    { decision: "allow", priority: 10 },
    { decision: "allow", priority: 1 },
    { decision: "deny", reason: "治理拒绝", priority: 5 },
  ]);
  assert.equal(r.decision, "deny");
  assert.equal(r.reason, "治理拒绝", "取高优先级 deny 的 reason");
});

test("consolidateDecisions: 无 deny 有 ask → ask", () => {
  const r = consolidateDecisions([
    { decision: "allow", priority: 1 },
    { decision: "ask", reason: "敏感操作", priority: 5 },
  ]);
  assert.equal(r.decision, "ask");
});

test("consolidateDecisions: 全 allow / 空 → allow", () => {
  assert.equal(consolidateDecisions([]).decision, "allow");
  assert.equal(consolidateDecisions([{ decision: "allow", priority: 0 }]).decision, "allow");
});

// ---- guard 接入 catalog 收口 ----
test("catalog: 未装 guard 时危险工具可正常执行 (向后兼容)", async () => {
  const catalog = makeCatalog();
  const r = await catalog.call("delete_asset", {});
  assert.equal(r, "deleted");
});

test("catalog: 装 guard 后危险工具被拦截, 普通工具放行", async () => {
  const catalog = makeCatalog();
  // 模拟 guard 句柄 (真实 installGuard 需要 agent.bus, 这里用同结构 state)
  const guard = { _state: { allowList: [], checks: 0, blocked: 0, allowed: 0, audited: [], lastVerdict: null } };
  installGuardOnCatalog(catalog, guard);

  const denied = await catalog.call("delete_asset", {});
  assert.ok(denied.includes("策略拦截"), "危险工具应被免疫闸门拦截");
  assert.ok(denied.includes("免疫闸门"));

  const ok = await catalog.call("read_file", {});
  assert.equal(ok, "file-content", "普通工具放行");
  assert.ok(guard._state.blocked >= 1, "拦截计数 +1");
  assert.ok(guard._state.checks >= 2, "检查计数 +2");
});

test("catalog: approveOnce 授权一次后可执行一次危险工具, 撤销后再拦截", async () => {
  const catalog = makeCatalog();
  // 复用真实 installGuard 的 approveOnce 语义: 走 allowList 变更
  const guard = { _state: { allowList: [], checks: 0, blocked: 0, allowed: 0, audited: [], lastVerdict: null } };
  installGuardOnCatalog(catalog, guard);

  const revoke = () => { const i = guard._state.allowList.indexOf("delete_asset"); if (i >= 0) guard._state.allowList.splice(i, 1); };
  guard._state.allowList.push("delete_asset"); // 授权一次
  const r = await catalog.call("delete_asset", {});
  assert.equal(r, "deleted", "授权后危险工具可执行");
  revoke();
  const r2 = await catalog.call("delete_asset", {});
  assert.ok(r2.includes("策略拦截"), "撤销后再次拦截");
});

test("catalog: 自定义策略订阅者 deny-wins 覆盖低优先级 allow", async () => {
  const catalog = makeCatalog();
  catalog.addPolicySubscriber(async () => ({ decision: "allow" }), { priority: 1, name: "low-allow" });
  catalog.addPolicySubscriber(async (name) => {
    if (name === "echo") return { decision: "deny", reason: "高层策略禁止 echo", priority: 100 };
    return null;
  }, { priority: 100, name: "high-deny" });

  const denied = await catalog.call("echo", {});
  assert.ok(denied.includes("高层策略禁止 echo"), "高优先级 deny 一票否决");
  const ok = await catalog.call("read_file", {});
  assert.equal(ok, "file-content", "其他工具不受影响");
});

test("catalog: 策略订阅者异常不拖垮工具 (fail-open)", async () => {
  const catalog = makeCatalog();
  catalog.addPolicySubscriber(async () => { throw new Error("boom"); }, { name: "broken" });
  const r = await catalog.call("read_file", {});
  assert.equal(r, "file-content", "订阅者异常视同弃权, 工具仍执行");
});

test("catalog: 移除策略订阅者后恢复 (热卸载)", async () => {
  const catalog = makeCatalog();
  const off = catalog.addPolicySubscriber(async (name) => {
    if (name === "read_file") return { decision: "deny", reason: "临时禁止", priority: 50 };
    return null;
  }, { name: "temp" });
  const denied = await catalog.call("read_file", {});
  assert.ok(denied.includes("临时禁止"));
  off();
  const ok = await catalog.call("read_file", {});
  assert.equal(ok, "file-content");
});
