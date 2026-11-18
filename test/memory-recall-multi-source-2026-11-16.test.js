// test/memory-recall-multi-source-2026-11-16.test.js — 架构优化 ③ 消费侧
// retrieval.js 的统一召回契约此前零调用方 (只测不用)。本文件钉住唯一工具面出口:
//   memory_search({multi_source:true}) → 事实+经验+场景+画像 RRF 融合, 每条带来源证据;
//   默认 (不传) 仍是单源事实查询, 输出逐字节不变。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCatalog } from "../src/tools/index.js";
import { registerMemoryTools } from "../src/tools/builtin-memory.js";
import { FactStore } from "../src/memory/fact-store.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-recall-ms-")); }

function makeCatalog(dir) {
  const facts = new FactStore(dir);
  const catalog = new ToolCatalog();
  registerMemoryTools(catalog, { facts });
  const experience = {
    recall: (q) => String(q).includes("命令") || String(q).includes("超时")
      ? [{ id: "e1", lesson: "长命令必须用 run_background, 否则 30s 超时反复烧轮次", task: "执行", uses: 3, score: 10 }]
      : [],
  };
  const scenes = {
    findMatch: (q) => String(q).includes("命令") ? { name: "运维", description: "本机命令执行与排障", score: 1 } : null,
  };
  const personaStore = {
    userPersona: () => ({ lines: ["偏好结论先行", "重视证据"] }),
  };
  return { facts, catalog, agent: { experience, scenes, personaStore } };
}

test("multi_source: 四源并查 + 每条带来源标注 (事实/经验/场景/画像)", async () => {
  const dir = tmp();
  try {
    const { facts, catalog, agent } = makeCatalog(dir);
    facts.add("run_command 默认 30 秒超时, 长任务要用 run_background", { importance: 9, source: "user" });
    const out = await catalog.call("memory_search", { query: "命令超时怎么办", multi_source: true }, { agent });
    assert.ok(out.startsWith("[多源召回]"), `应带多源召回头: ${out.slice(0, 60)}`);
    assert.match(out, /facts:/, "健康度应列出事实源");
    assert.match(out, /\[.*事实.*\]/, "事实条目应带来源标注");
    assert.match(out, /\[.*经验.*\]/, "经验条目应带来源标注 (这是单源路径拿不到的)");
    assert.match(out, /整体|运维|场景/, "场景命中也应进入融合结果");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("multi_source: 默认路径不变 —— 不传时仍只查事实库 (无多源头)", async () => {
  const dir = tmp();
  try {
    const { facts, catalog, agent } = makeCatalog(dir);
    facts.add("普通事实一条", { importance: 5 });
    const out = await catalog.call("memory_search", { query: "普通事实" }, { agent });
    assert.ok(!out.startsWith("[多源召回]"), "默认不得改道多源");
    assert.ok(!out.includes("经验"), "默认不应混入经验源");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("multi_source: 单源故障只降级该源, 不拖垮整次召回", async () => {
  const dir = tmp();
  try {
    const { facts, catalog, agent } = makeCatalog(dir);
    facts.add("即使经验源炸了, 事实仍应返回", { importance: 8 });
    agent.experience = { recall: () => { throw new Error("经验库损坏"); } };
    const out = await catalog.call("memory_search", { query: "经验源炸", multi_source: true }, { agent });
    assert.ok(out.includes("事实仍应返回"), "其他源正常返回");
    assert.match(out, /experience:降级/, "故障源在健康度里如实标注");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("multi_source: scope 只约束事实源, 并在输出头注明 (不静默忽略)", async () => {
  const dir = tmp();
  try {
    const { facts, catalog, agent } = makeCatalog(dir);
    facts.add("全局事实不该出现在 scoped 结果里", { importance: 9, scope: null });
    const out = await catalog.call("memory_search", {
      query: "命令超时", scope: "session", multi_source: true,
    }, { agent });
    assert.match(out, /事实源限定 scope=session:/, "作用域必须在输出头说明");
    assert.ok(!out.includes("全局事实不该出现"), "scope 过滤对事实源生效");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
