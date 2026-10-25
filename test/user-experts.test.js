// test/user-experts.test.js — 可生长专家名册守卫 (2026-10-09, professor-synapse 式)
// 锁语义: ①内置契约不可被用户库顶掉 ②高危域强制 requiresHuman ③落盘可复用 ④自动建档 opt-in
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizePersona, registerUserExpert, resolveExpertWithUser,
  saveUserExperts, loadUserExperts, resolveExpert, userExpertCount,
} from "../src/orchestrator/experts.js";
import { autoCreateExpert } from "../src/tools/delegate.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ue-"));

test("normalizePersona: 字段裁剪 + 默认补全", () => {
  const e = normalizePersona({});
  assert.ok(e.name && e.perspective && e.id);
  assert.equal(e.userCreated, true);
  const long = normalizePersona({ name: "x".repeat(99), perspective: "y".repeat(999) });
  assert.ok(long.name.length <= 24 && long.perspective.length <= 400);
});

test("高危域闸门: 医疗/法律/金融自动建档 → requiresHuman=true", () => {
  assert.equal(normalizePersona({ name: "临床顾问", domain: "医疗" }).requiresHuman, true);
  assert.equal(normalizePersona({ name: "并购顾问", domain: "法律" }).requiresHuman, true);
  assert.equal(normalizePersona({ name: "基金经理", domain: "金融" }).requiresHuman, true);
  assert.equal(normalizePersona({ name: "前端架构师", domain: "前端" }).requiresHuman, false);
});

test("内置契约优先: 同名用户专家不可顶掉内置 id", () => {
  const before = resolveExpert("arch");
  registerUserExpert({ id: "arch", name: "假架构师", domain: "x", perspective: "冒充" });
  assert.equal(resolveExpert("arch"), before, "内置 EXPERTS 必须优先");
  const u = resolveExpertWithUser("完全没见过的领域顾问");
  assert.ok(!u || u.userCreated !== true || u.id !== "arch");
});

test("用户专家: 注册→命中→落盘→重载复用", () => {
  registerUserExpert({ id: "quant-trading", name: "量化交易顾问", domain: "金融", perspective: "从统计套利角度分析" });
  const hit = resolveExpertWithUser("quant-trading");
  assert.ok(hit && hit.userCreated && hit.name === "量化交易顾问");
  assert.equal(hit.requiresHuman, true, "金融域强制人工把关");
  assert.equal(saveUserExperts(tmp), true);
  const n = userExpertCount();
  assert.ok(n >= 1);
  const loaded = loadUserExperts(tmp);
  assert.ok(loaded >= 1, "落盘条目可重载");
  const again = resolveExpertWithUser("量化交易顾问");
  assert.ok(again && again.id === "quant-trading", "重载后按名命中");
});

test("autoCreateExpert: 默认关 / 开启后 LLM 桩建档 / 坏 JSON 不硬造", async () => {
  const llm = { chat: async (msgs) => JSON.stringify({ id: "rust-ffi", name: "FFI顾问", domain: "系统", perspective: "从内存安全边界分析", skills: ["ffi"] }) };
  const off = { config: { agent: {} }, llm, dataDir: tmp }; // auto_create_experts 未开启
  assert.equal(await autoCreateExpert(off, "rust ffi"), null, "默认关闭必须返回 null");

  const on = { config: { agent: { auto_create_experts: true } }, llm, dataDir: tmp };
  const created = await autoCreateExpert(on, "rust ffi");
  assert.ok(created && created.id === "rust-ffi" && created.userCreated);
  assert.ok(created.perspective.includes("自动建档"), "perspective 带溯源标注");
  // 二次解析直接命中用户库 (不再烧 LLM)
  assert.ok(resolveExpertWithUser("rust ffi"));

  const bad = { config: { agent: { auto_create_experts: true } }, llm: { chat: async () => "我不会输出 JSON" }, dataDir: tmp };
  assert.equal(await autoCreateExpert(bad, "别的领域"), null, "坏输出走原错误路径, 不硬造");
  const nollm = { config: { agent: { auto_create_experts: true } } };
  assert.equal(await autoCreateExpert(nollm, "x"), null, "无 llm 不硬造");
});
