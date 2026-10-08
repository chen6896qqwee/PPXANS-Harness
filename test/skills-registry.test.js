// test/skills-registry.test.js - 内置技能层 v2 (多源 + 领域二级目录 + 覆盖率) 2026-10-07
// 钉住的不变量:
//   ① 多根装配: 同 id 时先到的根胜出 (内置打底 → 用户覆盖 → 附加收尾)
//   ② 领域二级目录: skills/<domain>/<skill>/SKILL.md 可被发现; 扁平 skills/<skill>/ 仍然可用
//   ③ 命中 SKILL.md 的目录不再下钻 (技能内的 references/ 不算独立技能)
//   ④ 覆盖率: 分母是登记的域目录, 未登记 domain 的技能归 uncategorized 且不被算作"已覆盖一个域"
//   ⑤ 写盘根与读取根分离: writeDir 只落可写根
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillLoader, expandHome } from "../src/skills/loader.js";
import { SkillRegistry, SKILL_DOMAINS, DOMAIN_IDS, skillRootsFromConfig, createSkillRegistry } from "../src/skills/registry.js";
import { scanSkillIds, lintSkillDir } from "../src/skills/lint.js";

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-skreg-${tag}-`));

function writeSkill(root, rel, { name, desc = "描述占位", extra = "" } = {}) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  const leaf = String(name || rel.split("/").pop());
  fs.writeFileSync(path.join(dir, "SKILL.md"),
    `---\nname: ${leaf}\ndescription: ${desc}\n${extra}---\n\n# ${leaf}\n\n## 流程\n1. 做\n\n## 验证\n通过\n`, "utf8");
}

test("domains: 十二个能力域登记齐全且 id 唯一", () => {
  const ids = SKILL_DOMAINS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, "域 id 不重复");
  assert.equal(ids.length, 12, "11 个能力域 + 1 个元能力域");
  for (const d of SKILL_DOMAINS) {
    assert.ok(d.name && d.desc, `${d.id} 缺名称或说明`);
    assert.ok(DOMAIN_IDS.has(d.id));
  }
});

test("loader v2: 领域二级目录与扁平目录混装, 都能被发现", () => {
  const root = tmp("mixed");
  try {
    writeSkill(root, "brainstorm");                     // 扁平 (v1 布局)
    writeSkill(root, "office/docx-report");             // 领域二级 (v2 布局)
    writeSkill(root, "knowledge/deep-research");
    // 技能内部素材: 命中 SKILL.md 后不再下钻, references/ 里的 SKILL.md 不算技能
    writeSkill(root, "office/docx-report/references/inner-skill");
    const l = new SkillLoader(root);
    const ids = l.list().map((s) => s.id).sort();
    assert.deepEqual(ids, ["brainstorm", "knowledge/deep-research", "office/docx-report"],
      `二级目录可发现且不下钻, 实际: ${ids.join(",")}`);
    assert.equal(l.domainOf("office/docx-report"), "office", "域由路径首段推断");
    assert.equal(l.domainOf("brainstorm"), "misc", "扁平技能归 misc");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("loader v2: frontmatter domain 优先于路径推断; name_zh 作显示名", () => {
  const root = tmp("fm");
  try {
    writeSkill(root, "office/x", { name: "x", extra: "domain: content\nname_zh: 中文显示名\n" });
    const l = new SkillLoader(root);
    assert.equal(l.domainOf("office/x"), "content", "frontmatter domain 覆盖路径推断");
    assert.equal(l.get("office/x").name, "中文显示名", "name_zh 优先作为显示名");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("loader v2: 多根装配 —— 同 id 先到的根胜出, 读取跟随、写入只落可写根", () => {
  const a = tmp("rootA");
  const b = tmp("rootB");
  try {
    writeSkill(a, "data/x", { desc: "来自 A (内置)" });
    writeSkill(b, "data/x", { desc: "来自 B (用户覆盖)" });
    writeSkill(b, "personal/only-here", { desc: "只在 B" });
    const l = new SkillLoader({ roots: [
      { id: "builtin", dir: a, kind: "builtin", writable: true },
      { id: "user", dir: b, kind: "user", writable: true },
    ] });
    assert.equal(l.get("data/x").description, "来自 A (内置)", "先到的根胜出");
    assert.equal(l.get("personal/only-here").description, "只在 B", "第二根独有的技能可见");
    assert.equal(l.get("data/x").source, "builtin");
    assert.equal(l.writeDir, path.resolve(a), "可写根 = 第一个 writable 根");
    // 缓存: 删除后必须消失
    fs.rmSync(path.join(b, "personal", "only-here"), { recursive: true, force: true });
    assert.equal(l.has("personal/only-here"), false);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("registry: 覆盖率分母是登记域, uncategorized 不冒充已覆盖", () => {
  const root = tmp("cov");
  try {
    writeSkill(root, "office/a");
    writeSkill(root, "office/b");
    writeSkill(root, "code/c");
    writeSkill(root, "legacy-flat");  // 未标 domain → misc → uncategorized
    writeSkill(root, "weird-domain/z", { extra: "domain: not-registered\n" });
    const reg = new SkillRegistry({ loader: new SkillLoader(root) });
    const cov = reg.coverage();
    assert.equal(cov.total, 5);
    assert.equal(cov.domainCount, 12, "分母是 12 个登记域");
    assert.equal(cov.coveredDomains, 2, "只有 office 与 code 被覆盖");
    assert.ok(Math.abs(cov.coverage - 2 / 12) < 1e-9);
    assert.deepEqual(cov.uncovered.sort(), SKILL_DOMAINS.map((d) => d.id).filter((i) => i !== "office" && i !== "code").sort());
    // misc 与未登记域都并进同一个 uncategorized 桶, 不污染 domains
    assert.equal(cov.unregistered.length, 1, "未登记域合并为一桶");
    assert.equal(cov.unregistered[0].id, "uncategorized");
    assert.deepEqual(cov.unregistered[0].skills.sort(), ["legacy-flat", "weird-domain/z"]);
    assert.equal(cov.domains.some((d) => d.id === "misc"), false);
    assert.equal(cov.domains.length, 12, "domains 恒为 12 个登记域");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("registry: 按域/来源/关键词过滤 list()", () => {
  const root = tmp("filter");
  try {
    writeSkill(root, "office/a", { desc: "报表产出" });
    writeSkill(root, "data/b", { desc: "指标分析" });
    const reg = new SkillRegistry({ loader: new SkillLoader(root) });
    assert.deepEqual(reg.list({ domain: "office" }).map((s) => s.id), ["office/a"]);
    assert.deepEqual(reg.list({ q: "指标" }).map((s) => s.id), ["data/b"]);
    assert.equal(reg.list({ source: "builtin" }).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("registry: 配置 → 技能根 (内置/用户/项目/附加, 去重, 兜底)", () => {
  const roots = skillRootsFromConfig({ skills: { builtin: true, user_dir: "~/.ppx/skills", project_dir: "/tmp/proj", extra_dirs: ["/tmp/extra"] } }, "/root");
  const kinds = roots.map((r) => r.kind);
  assert.deepEqual(kinds, ["builtin", "user", "project", "extra"]);
  assert.equal(roots[0].dir, path.join("/root", "skills"));
  assert.equal(roots[1].dir, path.join(os.homedir(), ".ppx", "skills"), "~ 被展开");
  // 全关 → 兜底仍留内置 (否则技能系统整体失效)
  const only = skillRootsFromConfig({ skills: { builtin: false, user_dir: "" } }, "/root");
  assert.equal(only.length, 1);
  assert.equal(only[0].kind, "builtin", "兜底内置");
  // 重复目录去重
  const dup = skillRootsFromConfig({ skills: { user_dir: "/root/skills" } }, "/root");
  assert.equal(dup.filter((r) => r.dir === path.join("/root", "skills")).length, 1);
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("/abs/path"), "/abs/path");
});

test("registry: createSkillRegistry 一步装配 (loader 与 roots 一致)", () => {
  const reg = createSkillRegistry({ skills: { user_dir: "" } }, process.cwd());
  assert.ok(reg.loader, "loader 就绪");
  assert.equal(reg.roots.length, reg.loader.roots.length, "roots 与 loader 同源");
  const cov = reg.coverage();
  assert.ok(cov.total > 0, "真实技能库非空");
});

test("lint v2: 领域二级目录可扫描, 第三方技能结构性缺失降级为告警", () => {
  const root = tmp("lint");
  try {
    writeSkill(root, "office/good");
    // 自研技能缺"验证"段 → 硬错误 (闸门护的是自己的技能库)
    const badDir = path.join(root, "data", "bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "SKILL.md"), "---\nname: bad\ndescription: 缺验证段\n---\n\n## 流程\n1. 做\n", "utf8");
    // 第三方技能 (带 source) 缺流程/验证 → 告警而非错误
    const upDir = path.join(root, "code", "upstream");
    fs.mkdirSync(upDir, { recursive: true });
    fs.writeFileSync(path.join(upDir, "SKILL.md"), "---\nname: upstream\ndescription: 上游技能\nsource: foo/bar\n---\n\n## Overview\nhello\n", "utf8");

    const ids = scanSkillIds(root);
    assert.deepEqual(ids, ["code/upstream", "data/bad", "office/good"], "二级目录可扫描");
    const r = lintSkillDir(root);
    const byName = Object.fromEntries(r.results.map((x) => [x.name, x]));
    assert.equal(byName["office/good"].ok, true);
    assert.equal(byName["data/bad"].ok, false, "自研缺验证段 → 不合格");
    assert.ok(byName["data/bad"].errors.some((e) => e.id === "no-verify"));
    assert.equal(byName["code/upstream"].ok, true, "第三方技能不因结构差异被拦");
    assert.ok(byName["code/upstream"].warnings.some((w) => w.id === "upstream-no-process"), "缺失以告警呈现");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
