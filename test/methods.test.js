import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { TOOL_ERROR_PREFIX } from "../src/tools/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function tmpRoot(n){ return fs.mkdtempSync(path.join(os.tmpdir(),`ppx-${n}-`)); }

test("方法型Skill: 三个工具已注册", () => {
  const a = new PPXAgent({ root: tmpRoot("methods") });
  const names = a.tools.list();
  assert.ok(names.includes("humanize"), "humanize 已注册");
  assert.ok(names.includes("write_article"), "write_article 已注册");
  assert.ok(names.includes("clarify"), "clarify 已注册");
  a.shutdown();
});

test("方法型Skill: 无LLM时返回标准错误前缀 (降级不崩)", async () => {
  const a = new PPXAgent({ root: tmpRoot("methods2") });
  // 强制无 LLM
  a.llm = null;
  const r1 = await a.tools.call("humanize", { text: "很高兴为您服务" }, { agent: a });
  assert.ok(r1.startsWith(TOOL_ERROR_PREFIX), "humanize 无LLM应报错: " + r1);
  const r2 = await a.tools.call("write_article", { topic: "测试" }, { agent: a });
  assert.ok(r2.startsWith(TOOL_ERROR_PREFIX), "write_article 无LLM应报错");
  const r3 = await a.tools.call("clarify", { task: "改登录页" }, { agent: a });
  assert.ok(r3.startsWith(TOOL_ERROR_PREFIX), "clarify 无LLM应报错");
  a.shutdown();
});

test("方法型Skill: 缺必填参数返回错误", async () => {
  const a = new PPXAgent({ root: tmpRoot("methods3") });
  const r = await a.tools.call("humanize", {}, { agent: a });
  assert.ok(r.startsWith(TOOL_ERROR_PREFIX), "缺 text 应报错: " + r);
  a.shutdown();
});
