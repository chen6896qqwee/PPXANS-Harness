// test/skill-hub-2026-11-16.test.js — 技能库自省/域目录/导入参数闸门 (离线)
// skill_import 的真实导入需要 GitHub 网络; 这里只钉"没有写目录/坏源/坏仓库"的拒绝路径,
// 以及 skill_coverage/skill_domains 的输出形状, 不让测试依赖外网。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSkillHubTools } from "../src/tools/skill-hub.js";
import { SKILL_DOMAINS } from "../src/skills/registry.js";

function stubCatalog() {
  const defs = new Map();
  return { register(def) { defs.set(def.name, def); }, def(name) { return defs.get(name); } };
}
function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-skillhub-${tag}-`));
}
function fakeRegistry(dir) {
  return {
    loader: { writeDir: dir },
    coverage: () => ({
      total: 3,
      coveredDomains: 2,
      domainCount: 4,
      coverage: 0.5,
      domains: [
        { covered: true, name: "信息与知识处理", id: "knowledge", count: 2, uses: 5, skills: ["web-research", "fact-check"] },
        { covered: false, name: "数据与决策支持", id: "data", count: 0 },
      ],
      uncovered: ["data", "office"],
      unregistered: [{ id: "misc", count: 1 }],
      sources: [{ id: "builtin", exists: true, dir: "/skills" }],
    }),
  };
}

test("skill-hub: skill_domains 列出十二域", async () => {
  const catalog = stubCatalog();
  registerSkillHubTools(catalog, {});
  const out = await catalog.def("skill_domains").execute({}, {});
  assert.equal(SKILL_DOMAINS.length, 12);
  for (const d of SKILL_DOMAINS) assert.ok(out.includes(d.id) && out.includes(d.name), d.id);
});

test("skill-hub: skill_coverage 无注册表时明确报错", async () => {
  const catalog = stubCatalog();
  registerSkillHubTools(catalog, {});
  const out = await catalog.def("skill_coverage").execute({}, {});
  assert.match(out, /技能注册表未装配/);
});

test("skill-hub: skill_coverage 输出覆盖率/缺口/未登记/来源", async () => {
  const dir = tmp("cov");
  try {
    const catalog = stubCatalog();
    registerSkillHubTools(catalog, { getAgent: () => ({ skillRegistry: fakeRegistry(dir) }) });
    const out = await catalog.def("skill_coverage").execute({}, {});
    assert.match(out, /技能总数 3 · 域覆盖 2\/4 \(50%\)/);
    assert.match(out, /✓ 信息与知识处理 \(knowledge\): 2 个, 累计使用 5 次/);
    assert.match(out, /✗ 数据与决策支持 \(data\): 0 个/);
    assert.match(out, /未覆盖域: data, office/);
    assert.match(out, /未登记域名的技能.*misc\(1\)/);
    assert.match(out, /技能源: builtin \/skills/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("skill-hub: skill_import 没有写入目录时拒绝", async () => {
  const catalog = stubCatalog();
  registerSkillHubTools(catalog, {});
  const out = await catalog.def("skill_import").execute({}, {});
  assert.match(out, /\[工具错误\] skill_import: 技能库写入目录不可用/);
});

test("skill-hub: skill_import 无参数列出离线白名单 (或明确无清单)", async () => {
  const dir = tmp("list");
  try {
    const catalog = stubCatalog();
    registerSkillHubTools(catalog, { getAgent: () => ({ skillRegistry: fakeRegistry(dir) }) });
    const out = await catalog.def("skill_import").execute({}, {});
    assert.ok(
      out.includes("可导入的上游技能源") || out.includes("内置上游源清单不可用"),
      "无参数应列白名单或诚实说明清单不可用",
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("skill-hub: skill_import 拒绝未知 from / 坏仓库 / 非 GitHub 主机", async () => {
  const dir = tmp("reject");
  try {
    const catalog = stubCatalog();
    registerSkillHubTools(catalog, { getAgent: () => ({ skillRegistry: fakeRegistry(dir) }) });
    const tool = catalog.def("skill_import");
    const unknown = await tool.execute({ from: "definitely-not-a-source" }, {});
    assert.match(unknown, /不在内置白名单/);
    const badRepo = await tool.execute({ repo: "nope" }, {});
    assert.match(badRepo, /\[工具错误\] skill_import/);
    const badHost = await tool.execute({ repo: "https://evil.example/x" }, {});
    assert.match(badHost, /不允许的主机|GitHub/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
