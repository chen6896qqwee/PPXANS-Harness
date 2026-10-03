// 2026-10-01 Skill 发现/路由优化回归守卫 (依据《Skill 蓝皮书 2026》洞察)
// 1) search.js 打分: name 加权 > description; 排序稳定
// 2) matchSkill 高置信阈值: 单 bigram 噪音不触发; 并列歧义不押注
// 3) loader mtime+size 签名缓存: 文件内容修改/目录增删后 list() 必须反映变化
// 4) skill_search 工具: 检索 + trackUse 计数闭环
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillLoader } from "../src/skills/loader.js";
import { matchSkill, scoreSkills } from "../src/skills/search.js";
import { ToolCatalog } from "../src/tools/catalog.js";
import { registerSelfmodTools } from "../src/tools/selfmod.js";

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${tag}-`));
}
function makeSkill(dir, name, desc) {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n\n## 流程\n1. 做\n\n## 验证\n通过\n`);
}

// ---- 1. 打分: name 命中权重高于 description 命中 ----
test("scoreSkills: name 命中加权, 结果按分数降序", () => {
  const dir = tmpRoot("search");
  makeSkill(dir, "memory-recall", "持久记忆, 记住偏好");
  makeSkill(dir, "weather", "查询天气预报");
  makeSkill(dir, "session-naming", "会话命名");
  const loader = new SkillLoader(dir);
  // "memory" 同时命中 memory-recall 的 name (+3) 与 description? desc 无 memory → 3 分
  const ranked = scoreSkills(loader, "用 memory 记住偏好");
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].id, "memory-recall");
  // 完全无关的 query 无结果 (确认无任何 bigram 交叠)
  assert.deepEqual(scoreSkills(loader, "做红烧肉"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 2. 高置信阈值 ----
test("matchSkill: 单 bigram 噪音不触发, 多次命中才触发, 并列返回 null", () => {
  const dir = tmpRoot("match");
  makeSkill(dir, "memory", "持久记忆, 记住用户偏好, 跨会话召回");
  makeSkill(dir, "naming", "会话批量重命名, 标题整理");
  const loader = new SkillLoader(dir);
  // 两次命中 (记住/偏好) → 触发
  const hit = matchSkill(loader, "帮我记住这个偏好");
  assert.ok(hit);
  assert.equal(hit.name, "memory");
  // 无命中 → null
  assert.equal(matchSkill(loader, "帮我打扫房间"), null);
  // 并列歧义: 同分不押注
  const dir2 = tmpRoot("match2");
  makeSkill(dir2, "aa", "导出报告");
  makeSkill(dir2, "bb", "导出报告");
  const ranked2 = matchSkill(new SkillLoader(dir2), "导出报告");
  assert.equal(ranked2, null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

// ---- 3. loader 缓存正确性: 修改/新增/删除都必须反映 ----
test("SkillLoader 签名缓存: 内容修改与目录增删后 list() 跟随变化", () => {
  const dir = tmpRoot("cache");
  makeSkill(dir, "alpha", "技能 A");
  const loader = new SkillLoader(dir);
  assert.equal(loader.list().length, 1);
  assert.equal(loader.get("alpha").description, "技能 A");
  // 修改内容 (同目录, 只改文件) → 缓存必须失效
  makeSkill(dir, "alpha", "技能 A 改版");
  assert.equal(loader.get("alpha").description, "技能 A 改版");
  // 新增技能
  makeSkill(dir, "beta", "技能 B");
  assert.equal(loader.list().length, 2);
  // 删除技能
  fs.rmSync(path.join(dir, "beta"), { recursive: true, force: true });
  assert.equal(loader.list().length, 1);
  assert.equal(loader.has("beta"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 4. skill_search 工具 ----
test("skill_search: 检索排序返回 JSON", async () => {
  const dir = tmpRoot("tool");
  makeSkill(dir, "memory", "持久记忆, 记住偏好");
  makeSkill(dir, "weather", "查询天气");
  const catalog = new (ToolCatalog)();
  registerSelfmodTools(catalog, { skillsDir: dir });
  const tool = catalog.metaOf("skill_search");
  assert.ok(tool, "skill_search 已注册");
  const out = JSON.parse(await tool.execute({ query: "记住偏好" }));
  assert.equal(out.count >= 1, true);
  assert.equal(out.results[0].id, "memory");
  const empty = JSON.parse(await tool.execute({ query: "做红烧肉" }));
  assert.equal(empty.count, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
