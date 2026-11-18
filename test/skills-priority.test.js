// test/skills-priority.test.js — 技能优先级反转 (2026-10-31, 队列⑥: 项目 > 用户 > 内置)
// 背景: 此前 skillRootsFromConfig 顺序为 [builtin, user, project] 且 loader first-wins =
//   **内置压住一切** —— 与 v2 文档宣称的"用户覆盖内置"直接相反; 更严重的是 agent 主路径
//   只传内置单根, 用户级/项目级技能在技能清单注入 / load_skill / 覆盖率里永远不可见。
// 钉住: 完整回落链 (项目→用户→内置) / 默认项目根 / 内置只读 / agent 多根接线 /
//   selfmod 同口径 (list 全量 + create_skill 落可写根)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillLoader } from "../src/skills/loader.js";
import { skillRootsFromConfig } from "../src/skills/registry.js";
import { ToolCatalog, registerSelfmodTools } from "../src/tools/index.js";
import { PPXAgent } from "../src/agent/index.js";

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-skill-prio-"));
}

function writeSkill(rootDir, id, desc) {
  const dir = path.join(rootDir, ...id.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: ${desc}\ndomain: data\n---\n\n## 流程\n1. 步骤\n`, "utf8");
}

test("优先级链路: 同 id 项目 > 用户 > 内置, 逐层删除逐层回落", () => {
  const proj = tmp();
  const user = tmp();
  const builtin = tmp();
  try {
    writeSkill(proj, "data/probe", "来自项目");
    writeSkill(user, "data/probe", "来自用户");
    writeSkill(builtin, "data/probe", "来自内置");
    const roots = [
      { id: "project", dir: proj, kind: "project", writable: true },
      { id: "user", dir: user, kind: "user", writable: true },
      { id: "builtin", dir: builtin, kind: "builtin", writable: false },
    ];
    const l = new SkillLoader({ roots });
    assert.equal(l.get("data/probe").description, "来自项目");
    assert.equal(l.get("data/probe").source, "project");
    // 删除后用 invalidate() 重扫 —— Windows 上父目录 mtime 更新延迟/合并不可预测
    // (loader SCAN_STABLE_MS 注), 裸删后的自动探测天然有毫秒级盲区; mtime 自动失效
    // 已由 skills-scan-cache 套件覆盖, 这里钉的是**回落顺序**本身。
    fs.rmSync(path.join(proj, "data", "probe"), { recursive: true, force: true });
    l.invalidate();
    assert.equal(l.get("data/probe").description, "来自用户", "项目层删除 → 回落用户");
    assert.equal(l.get("data/probe").source, "user");
    fs.rmSync(path.join(user, "data", "probe"), { recursive: true, force: true });
    l.invalidate();
    assert.equal(l.get("data/probe").description, "来自内置", "用户层删除 → 回落内置");
    assert.equal(l.get("data/probe").source, "builtin");
    // 写入根: 项目根可写在前 = writeDir 落项目 (用户产物不进内置代码树)
    assert.equal(l.writeDir, path.resolve(proj));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(user, { recursive: true, force: true });
    fs.rmSync(builtin, { recursive: true, force: true });
  }
});

test("agent 接线: 项目级技能在 agent 主路径可见且压过内置同 id", async () => {
  const root = tmp();
  try {
    // 项目根同 id 覆盖内置: <root>/.ppx/skills 压过 <root>/skills
    writeSkill(path.join(root, ".ppx", "skills"), "data/override-probe", "项目定制版");
    writeSkill(path.join(root, "skills"), "data/override-probe", "内置版");
    writeSkill(path.join(root, ".ppx", "skills"), "data/proj-only", "项目独有");
    const agent = new PPXAgent({ root, configFile: null });
    try {
      assert.equal(agent.skills.get("data/override-probe").description, "项目定制版", "项目压过内置");
      assert.equal(agent.skills.get("data/override-probe").source, "project");
      assert.ok(agent.skills.has("data/proj-only"), "项目独有技能可见");
      assert.ok(agent.skills.has("data/override-probe"), "list/has 全路径可见");
      // registry 覆盖率与 agent 读同一份多根 loader (同 id 溯源一致)
      assert.deepEqual(agent.skillRegistry.roots.map((r) => r.kind), ["project", "user", "builtin"]);
      const cov = agent.skillRegistry.coverage();
      // coverage 只保证总量口径; 这里锁 loader/registry 同源 (无分叉实例)
      assert.equal(agent.skillRegistry.loader, agent.skills, "registry 与 agent 共用一份 loader");
      assert.ok(cov.total >= 2, "覆盖率统计含项目技能");
    } finally {
      await agent.shutdown();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selfmod 同口径: list_capabilities 全量可见, create_skill 落可写根 (项目优先)", async () => {
  const root = tmp();
  try {
    writeSkill(path.join(root, "skills"), "code/builtin-skill", "内置技能");
    const roots = skillRootsFromConfig({ skills: { project_dir: path.join(root, ".ppx", "skills"), user_dir: "" } }, root);
    const writeDir = (roots.find((r) => r.writable) || roots[0]).dir;
    const cat = new ToolCatalog();
    registerSelfmodTools(cat, { roots, writeDir });
    // load_skill 读内置 (多根 loader); read 返回剥掉 frontmatter 的正文
    const loaded = await cat.call("load_skill", { id: "code/builtin-skill" });
    assert.ok(!String(loaded).startsWith("[工具错误]"), "内置技能经多根 loader 可读");
    assert.ok(String(loaded).includes("1. 步骤"), "正文内容正确");
    // create_skill 落项目根 (.ppx/skills), 不落内置
    const r = await cat.call("create_skill", { name: "prio-probe", description: "新技能", content: "## 流程\n1. x\n\n## 验证\ny" });
    assert.ok(r.includes("已创建技能"), r);
    assert.ok(fs.existsSync(path.join(root, ".ppx", "skills", "prio-probe", "SKILL.md")), "落项目可写根");
    assert.ok(!fs.existsSync(path.join(root, "skills", "prio-probe")), "不写内置代码树");
    // 新技能立即可读 (同 loader 实例, 目录 mtime 失效缓存); read 返回剥掉 frontmatter 的正文
    const again = await cat.call("load_skill", { id: "prio-probe" });
    assert.ok(String(again).includes("1. x"), "创建后立即可 load_skill");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
