// test/seam-registry.test.js - P0③: 通用 seam 注册表 (Service Definition/Provider/Consumer)
import { test } from "node:test";
import assert from "node:assert";
import { createSeamRegistry, SeamRegistry } from "../src/seam/registry.js";

test("seam: 声明 → 提供 → 消费", () => {
  const reg = createSeamRegistry();
  reg.define("shell", { desc: "命令执行", interface: ["exec"], consumers: ["run_command", "code_act"] });
  const impl = { exec: async () => ({ ok: true }) };
  reg.provide("shell", impl, { name: "LocalShellProvider" });

  assert.equal(reg.resolve("shell"), impl, "resolve 返回实现");
  assert.equal(reg.require("shell"), impl);
  assert.ok(reg.has("shell"));
  assert.equal(reg.status()[0].impl, "LocalShellProvider");
  assert.deepEqual(reg.status()[0].consumers, ["run_command", "code_act"]);
});

test("seam: 未提供实现时 require 抛错, resolve 返回 null", () => {
  const reg = createSeamRegistry();
  reg.define("embedder");
  assert.equal(reg.resolve("embedder"), null);
  assert.throws(() => reg.require("embedder"), /缺失实现/);
});

test("seam: swap 一行换实现, 消费方跟着切", async () => {
  const reg = createSeamRegistry();
  reg.define("shell", { consumers: ["run_command"] });
  reg.provide("shell", { exec: async () => "local" }, { name: "Local" });
  assert.equal(await reg.resolve("shell").exec(), "local");

  reg.swap("shell", { exec: async () => "sandbox" }, { name: "SandboxShellProvider" });
  assert.equal(reg.status()[0].impl, "SandboxShellProvider", "实现名已切换");
  assert.equal(reg.status()[0].swapped, true, "标记为热替换");
  assert.equal(await reg.resolve("shell").exec(), "sandbox", "消费方拿到新实现");
});

test("seam: 幂等 define 不覆盖已装实现, 合并 consumers", () => {
  const reg = createSeamRegistry();
  reg.define("shell", { consumers: ["run_command"] });
  reg.provide("shell", { exec: async () => "x" });
  reg.define("shell", { consumers: ["code_act"], desc: "更新描述" });

  const st = reg.status()[0];
  assert.ok(st.consumers.includes("run_command"));
  assert.ok(st.consumers.includes("code_act"), "consumers 合并");
  assert.ok(reg.has("shell"), "已有实现未被覆盖");
});

test("seam: 工厂函数 provide 被调用", async () => {
  const reg = createSeamRegistry();
  let built = false;
  reg.define("fs");
  reg.provide("fs", () => { built = true; return { read: async () => "data" }; });
  assert.equal(built, true, "工厂立即求值");
  assert.equal(await reg.resolve("fs").read(), "data");
});

test("seam: 类实例可直接 new 传入", () => {
  class FakeShell { async exec() { return "fake"; } }
  const reg = new SeamRegistry();
  reg.define("shell");
  reg.provide("shell", new FakeShell());
  assert.ok(reg.resolve("shell") instanceof FakeShell);
  assert.equal(reg.status()[0].impl, "FakeShell");
});
