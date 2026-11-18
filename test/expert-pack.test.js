// test/expert-pack.test.js - 专家包 + 人格模板 (2026-10-07 吸收自 TencentCloud/Octop)
// 钉住的不变量:
//   ① 人格是**数据**: 17 档 (16 型 + default), 四轴 + 六项行为齐全
//   ② 渲染契约: persona 是骨架, custom 是**追加** —— 不允许覆盖骨架
//   ③ 未知名回落 default, 不抛错 (人格是增强不是依赖)
//   ④ 专家包 manifest 校验: id/domain/category/persona 全部有闸门, 错了进 problems 不静默
//   ⑤ 多源扫描 first-wins; 缺 SKILL.md 类的目录 (没 manifest) 不是包
//   ⑥ 导入安全: 文本扩展名白名单 / 体积上限 / id 白名单 / 路径留在目标根内
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MBTI_PROFILES, PERSONA_CODES, BEHAVIOR_KEYS, PERSONA_DIMENSIONS,
  getProfile, hasProfile, listProfiles, dimensionsOf, renderPersona,
} from "../src/orchestrator/personas.js";
import {
  ExpertPackCatalog, normalizeManifest, installPack, packRootsFromConfig,
  PACK_CATEGORIES, PACK_LIMITS, KNOWN_DOMAINS, pickLabel,
} from "../src/orchestrator/expert-pack.js";

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-pack-${tag}-`));

function writePack(root, id, { manifest = {}, soul = "# SOUL\n\n正文\n", agents = null } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const base = { id, label: { zh: id }, description: { zh: `${id} 的描述` }, domain: "meta", category: "assistant" };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...base, ...manifest }), "utf8");
  if (soul !== null) fs.writeFileSync(path.join(dir, "SOUL.md"), soul, "utf8");
  if (agents) fs.writeFileSync(path.join(dir, "AGENTS.md"), agents, "utf8");
  return dir;
}

// ---- 人格 ----
test("personas: 17 档 (16 型 + default), 每型字段齐全", () => {
  assert.equal(PERSONA_CODES.length, 17, "16 型 + default");
  assert.ok(PERSONA_CODES.includes("_default"));
  for (const [code, p] of Object.entries(MBTI_PROFILES)) {
    assert.ok(p.name_zh && p.name_en, `${code} 缺中英名`);
    assert.ok(p.summary_zh && p.summary_zh.length > 5, `${code} 缺一句话简介`);
    for (const k of BEHAVIOR_KEYS) assert.ok(p.behavior?.[k], `${code} 缺行为映射 ${k}`);
    assert.match(p.color, /^#[0-9A-Fa-f]{6}$/, `${code} 颜色非法`);
    if (code !== "_default") {
      for (const d of PERSONA_DIMENSIONS) {
        assert.ok(Array.isArray(p.dimensions[d]), `${code} 缺 ${d} 轴`);
        assert.equal(p.dimensions[d].length, 2);
        assert.ok(p.dimensions[d][1] > 0 && p.dimensions[d][1] <= 100, `${code}.${d} 强度越界`);
      }
    }
  }
});

test("personas: 未知码回落 default 且不抛错", () => {
  assert.equal(getProfile("ZZZZ").code, "_default");
  assert.equal(getProfile("").code, "_default");
  assert.equal(getProfile(null).code, "_default");
  assert.equal(hasProfile("intj"), true, "大小写不敏感");
  assert.equal(hasProfile("ZZZZ"), false);
  assert.equal(listProfiles().length, 16);
  assert.equal(listProfiles({ includeDefault: true }).length, 17);
});

test("personas: 四轴摘要带标签与极性", () => {
  const dims = dimensionsOf("INTJ");
  assert.equal(dims.length, 4);
  assert.deepEqual(dims.map((d) => d.pole), ["I", "N", "T", "J"]);
  assert.equal(dims[0].label, "能量方向");
  assert.equal(dims[0].poleLabel, "内向");
  assert.deepEqual(dimensionsOf("_default"), [], "default 无四轴");
});

test("personas: 渲染契约 —— 骨架 + custom 追加, 不覆盖", () => {
  const out = renderPersona("INTJ", { agentName: "皮皮虾", userDisplay: "老板", custom: "回答尽量短" });
  assert.ok(out.includes("皮皮虾") && out.includes("老板"), "模板变量被替换");
  assert.ok(out.includes("建筑师"), "含人格名 (骨架)");
  assert.ok(out.includes("## 四轴倾向"), "含四轴");
  assert.ok(out.includes("## 行为约定"), "含行为约定");
  assert.ok(out.includes("回答尽量短"), "custom 被追加");
  // custom 出现在骨架**之后** (否则等于允许覆盖人格)
  assert.ok(out.indexOf("## 行为约定") < out.indexOf("回答尽量短"), "custom 在骨架之后");
  // 无 custom 时不产生空段
  const bare = renderPersona("INTJ", {});
  assert.ok(!bare.includes("用户补充"));
});

// ---- manifest 校验 ----
test("expert-pack: manifest 校验拦住各类错", () => {
  const ok = normalizeManifest({ id: "x1", label: { zh: "甲" }, description: { zh: "描述" }, domain: "meta", category: "assistant" }, { dirId: "x1" });
  assert.equal(ok.ok, true);
  assert.equal(ok.pack.label, "甲");
  assert.equal(ok.pack.category, "assistant");

  const cases = [
    [{}, /缺 id/],
    [{ id: "Bad_ID" }, /id 非法/],
    [{ id: "x", description: "", domain: "meta" }, /缺 description/],
    [{ id: "x", description: "d", domain: "不存在域" }, /domain 未登记/],
    [{ id: "x", description: "d", domain: "meta", category: "不存在" }, /category 未登记/],
    [{ id: "x", description: "d", domain: "meta", persona_mbti: "ZZZZ" }, /persona_mbti 未知/],
  ];
  for (const [raw, re] of cases) {
    const r = normalizeManifest(raw, { dirId: null });
    assert.equal(r.ok, false, `应被拦: ${JSON.stringify(raw)}`);
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(raw)} → ${r.errors.join("; ")}`);
  }
  // 目录名与 id 不一致 (id 本身合法, 只有不一致这一个问题)
  const mismatch = normalizeManifest({ id: "aaa", description: "d", domain: "meta" }, { dirId: "bbb" });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.some((e) => /不一致/.test(e)), mismatch.errors.join(";"));
  // 默认值补齐
  const d = normalizeManifest({ id: "xx", description: "d", domain: "meta" }, {}).pack;
  assert.equal(d.category, "assistant");
  assert.equal(d.personaMbti, "");
  assert.equal(d.readonly, false);
  assert.match(d.color, /^#[0-9A-Fa-f]{6}$/);
  assert.deepEqual(d.skills, []);
});

test("expert-pack: KNOWN_DOMAINS = 技能域 ∪ 高风险域", () => {
  assert.ok(KNOWN_DOMAINS.has("code"));
  assert.ok(KNOWN_DOMAINS.has("meta"));
  assert.ok(KNOWN_DOMAINS.has("medical"), "高风险域可用");
  assert.ok(KNOWN_DOMAINS.has("legal"));
  assert.equal(KNOWN_DOMAINS.has("nope"), false);
});

// ---- 目录册 ----
test("expert-pack: 多源扫描 first-wins + 无 manifest 的目录不是包", () => {
  const a = tmp("rootA");
  const b = tmp("rootB");
  try {
    writePack(a, "want", { manifest: { label: { zh: "来自内置" } } });
    writePack(b, "want", { manifest: { label: { zh: "来自用户" } } });
    writePack(b, "only-user", {});
    fs.mkdirSync(path.join(a, "not-a-pack"), { recursive: true });     // 无 manifest
    fs.writeFileSync(path.join(a, "not-a-pack", "SOUL.md"), "x", "utf8");
    const cat = new ExpertPackCatalog({ roots: [
      { id: "builtin", dir: a, kind: "builtin", writable: true },
      { id: "user", dir: b, kind: "user", writable: true },
    ] });
    assert.equal(cat.get("want").label, "来自内置", "先到的根胜出");
    assert.equal(cat.get("want").source, "builtin");
    assert.equal(cat.get("only-user").source, "user");
    assert.equal(cat.has("not-a-pack"), false, "没有 manifest 的目录不是专家包");
    assert.equal(cat.list().length, 2);
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});

test("expert-pack: 坏 manifest 进 problems 而不是静默丢弃", () => {
  const root = tmp("bad");
  try {
    const dir = path.join(root, "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), "{ not json", "utf8");
    writePack(root, "no-domain", { manifest: { domain: "" } });
    const cat = new ExpertPackCatalog({ roots: [{ id: "builtin", dir: root, kind: "builtin", writable: true }] });
    assert.equal(cat.list().length, 0);
    assert.equal(cat.problems().length, 2, "两个坏包都被记录");
    assert.ok(cat.problems().some((p) => /解析失败/.test(p.reason)));
    assert.ok(cat.problems().some((p) => /domain/.test(p.reason)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("expert-pack: 市场视图分类计数 + 中英文名模糊解析", () => {
  const root = tmp("market");
  try {
    writePack(root, "pack-a", { manifest: { category: "engineering", label: { zh: "甲工程师" } } });
    writePack(root, "pack-b", { manifest: { category: "engineering", label: { zh: "乙工程师" } } });
    writePack(root, "pack-c", { manifest: { category: "risk", requires_human: true, readonly: true } });
    const cat = new ExpertPackCatalog({ roots: [{ id: "builtin", dir: root, kind: "builtin", writable: true }] });
    const m = cat.market();
    assert.equal(m.total, 3);
    assert.equal(m.categories.find((c) => c.id === "engineering").count, 2);
    assert.equal(m.categories.find((c) => c.id === "office").count, 0);
    assert.equal(m.categories.length, PACK_CATEGORIES.length, "分类目录固定");
    assert.equal(cat.resolve("pack-a").id, "pack-a");
    assert.equal(cat.resolve("PACK-A").id, "pack-a", "大小写不敏感");
    assert.equal(cat.resolve("乙工程师").id, "pack-b", "中文名直查");
    assert.equal(cat.resolve("甲工程").id, "pack-a", "中文名模糊");
    assert.equal(cat.resolve("不存在"), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("expert-pack: personaOf 拼装 (MBTI 骨架 + SOUL 职责 + AGENTS 准则)", () => {
  const root = tmp("persona");
  try {
    writePack(root, "with-mbti", { manifest: { persona_mbti: "INTJ" }, soul: "# 职责\n\n只做条款梳理。", agents: "# 准则\n\n不臆测。" });
    writePack(root, "no-mbti", { soul: "# 职责\n\n就干活。" });
    const cat = new ExpertPackCatalog({ roots: [{ id: "builtin", dir: root, kind: "builtin", writable: true }] });
    const m = cat.personaOf("with-mbti", { agentName: "皮皮虾", userDisplay: "老板" });
    assert.ok(m.includes("建筑师"), "含 MBTI 骨架");
    assert.ok(m.includes("只做条款梳理"), "含 SOUL 职责");
    assert.ok(cat.personaOf("with-mbti", { withAgents: true }).includes("不臆测"), "含 AGENTS 准则");
    assert.ok(!cat.personaOf("with-mbti", { withAgents: false }).includes("不臆测"));
    const n = cat.personaOf("no-mbti", { custom: "简短点" });
    assert.ok(!n.includes("人格骨架"), "无人格码时不注入 MBTI");
    assert.ok(n.includes("就干活") && n.includes("简短点"));
    assert.equal(cat.personaOf("不存在"), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("expert-pack: toExpertEntry 保持 spawn_agent 兼容形状", () => {
  const root = tmp("entry");
  try {
    writePack(root, "ro-pack", { manifest: { readonly: true, requires_human: true, domain: "legal", skills: ["meta/boundary-selfcheck"], category: "risk" } });
    const cat = new ExpertPackCatalog({ roots: [{ id: "builtin", dir: root, kind: "builtin", writable: true }] });
    const e = cat.toExpertEntry("ro-pack");
    assert.equal(e.readonly, true);
    assert.equal(e.requiresHuman, true);
    assert.equal(e.domain, "legal");
    assert.deepEqual(e.skills, ["meta/boundary-selfcheck"]);
    assert.equal(e.packId, "ro-pack");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- 导入安全 ----
test("expert-pack: installPack 拒绝非法扩展名 / 超限 / id 穿越", () => {
  const src = tmp("src");
  const dest = tmp("dest");
  try {
    writePack(src, "good-pack", {});
    const r1 = installPack(path.join(src, "good-pack"), { destRoot: dest });
    assert.equal(r1.ok, true, r1.reason);
    assert.ok(fs.existsSync(path.join(dest, "good-pack", "manifest.json")));
    // 二次安装需要 force
    const r2 = installPack(path.join(src, "good-pack"), { destRoot: dest });
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /已存在/);
    assert.equal(installPack(path.join(src, "good-pack"), { destRoot: dest, force: true }).ok, true);

    // 可执行文件被拒
    const bad = writePack(src, "evil-pack", {});
    fs.writeFileSync(path.join(bad, "run.sh"), "echo hi", "utf8");
    const r3 = installPack(bad, { destRoot: dest });
    assert.equal(r3.ok, false);
    assert.match(r3.reason, /不允许的文件类型/);

    // 超限文件被拒
    const big = writePack(src, "big-pack", {});
    fs.writeFileSync(path.join(big, "huge.md"), "x".repeat(PACK_LIMITS.maxFileBytes + 1), "utf8");
    const r4 = installPack(big, { destRoot: dest });
    assert.equal(r4.ok, false);
    assert.match(r4.reason, /超限/);

    // 缺 manifest
    const empty = path.join(src, "empty");
    fs.mkdirSync(empty, { recursive: true });
    const r5 = installPack(empty, { destRoot: dest });
    assert.equal(r5.ok, false);
    assert.match(r5.reason, /manifest/);

    // 非法 id (目录名)
    const badId = path.join(src, "..evil");
    fs.mkdirSync(badId, { recursive: true });
    fs.writeFileSync(path.join(badId, "manifest.json"), JSON.stringify({ id: "..evil", description: "d", domain: "meta" }), "utf8");
    const r6 = installPack(badId, { destRoot: dest });
    assert.equal(r6.ok, false);

    // 不存在的源
    assert.equal(installPack(path.join(src, "nope"), { destRoot: dest }).ok, false);
    assert.equal(installPack(path.join(src, "good-pack"), {}).ok, false, "缺 destRoot");
  } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); }
});

test("expert-pack: 配置 → 包根 (内置/用户/项目/附加, 去重, 兜底)", () => {
  const roots = packRootsFromConfig({ experts: { builtin: true, user_dir: "~/.ppx/experts", project_dir: "/tmp/proj", extra_dirs: ["/tmp/extra"] } }, "/root");
  assert.deepEqual(roots.map((r) => r.kind), ["builtin", "user", "project", "extra"]);
  assert.equal(roots[0].dir, path.join("/root", "experts"));
  assert.equal(roots[1].dir, path.join(os.homedir(), ".ppx", "experts"), "~ 展开");
  const only = packRootsFromConfig({ experts: { builtin: false, user_dir: "" } }, "/root");
  assert.equal(only.length, 1);
  assert.equal(only[0].kind, "builtin", "兜底内置");
  const dup = packRootsFromConfig({ experts: { user_dir: "/root/experts" } }, "/root");
  assert.equal(dup.filter((r) => r.dir === path.join("/root", "experts")).length, 1, "去重");
});

test("expert-pack: pickLabel 本地化回落", () => {
  assert.equal(pickLabel({ zh: "中文", en: "English" }), "中文");
  assert.equal(pickLabel({ zh: "中文", en: "English" }, "en"), "English");
  assert.equal(pickLabel({ en: "Only" }), "Only", "缺 zh 时回落 en");
  assert.equal(pickLabel("裸字符串"), "裸字符串");
  assert.equal(pickLabel(null), "");
});

test("expert-pack: 真实内置专家库可扫描且全部通过校验", () => {
  const cat = new ExpertPackCatalog({ roots: [{ id: "builtin", dir: path.resolve("experts"), kind: "builtin", writable: true }] });
  const list = cat.list();
  assert.ok(list.length >= 10, `内置专家包应 >= 10, 实测 ${list.length}`);
  assert.deepEqual(cat.problems(), [], "内置包必须零校验问题");
  for (const p of list) {
    assert.ok(p.hasSoul, `${p.id} 缺 SOUL.md`);
    assert.ok(p.description.length > 10, `${p.id} 描述过短`);
    assert.ok(p.quickPrompts.length >= 1, `${p.id} 缺快速提示词`);
  }
  // 高风险域包必须只读 + 需人工 (安全属性不能靠提示词自觉)
  for (const p of list.filter((x) => x.category === "risk")) {
    assert.equal(p.requiresHuman, true, `${p.id} 高风险包必须 requires_human`);
  }
});
