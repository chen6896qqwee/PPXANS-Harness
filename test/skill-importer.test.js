// test/skill-importer.test.js - GitHub 技能导入器 (2026-10-07) 全离线部分
// 联网抓取不在单测里做 (CI 不该依赖外网与 GitHub 限流); 这里钉的是**纯函数与安全边界**:
//   ① 仓库引用解析 (owner/repo、#branch、GitHub URL、tree/blob 子路径)
//   ② 拒绝非 https / 非 GitHub 主机 (SSRF 面)
//   ③ 路径段白名单 (防 ../ 穿越)
//   ④ 领域推断: 已知技能名优先于关键词正则
//   ⑤ frontmatter 重写: 补 domain/source/imported_at, 保留上游正文与 name
import test from "node:test";
import assert from "node:assert";
import { parseRepoRef, inferDomain, rewriteFrontmatter, extractUpstreamMeta, isSafeSegment, SKIP_SKILL_NAMES, IMPORT_LIMITS } from "../src/skills/importer.js";

test("importer: 仓库引用解析 (简写 / 分支 / URL / 子路径)", () => {
  assert.deepEqual(parseRepoRef("anthropics/skills"), { owner: "anthropics", repo: "skills", branch: null, subPath: "" });
  assert.deepEqual(parseRepoRef("obra/superpowers#dev"), { owner: "obra", repo: "superpowers", branch: "dev", subPath: "" });
  assert.deepEqual(parseRepoRef("owner/repo/skills/foo"), { owner: "owner", repo: "repo", branch: null, subPath: "skills/foo" });
  assert.deepEqual(parseRepoRef("https://github.com/anthropics/skills"),
    { owner: "anthropics", repo: "skills", branch: null, subPath: "" });
  assert.deepEqual(parseRepoRef("https://github.com/obra/superpowers/tree/main/skills"),
    { owner: "obra", repo: "superpowers", branch: "main", subPath: "skills" });
  assert.equal(parseRepoRef("https://github.com/foo/bar.git").repo, "bar", "去掉 .git 后缀");
});

test("importer: 拒绝非 https 与非 GitHub 主机 (SSRF 面)", () => {
  assert.throws(() => parseRepoRef("http://github.com/a/b"), /只接受 https/);
  assert.throws(() => parseRepoRef("https://evil.example.com/a/b"), /不允许的主机/);
  assert.throws(() => parseRepoRef("https://127.0.0.1/a/b"), /不允许的主机/);
  assert.throws(() => parseRepoRef(""), /为空/);
  assert.throws(() => parseRepoRef("justname"), /无法解析/);
});

test("importer: 路径段白名单挡住穿越与隐藏目录", () => {
  assert.equal(isSafeSegment("docx"), true);
  assert.equal(isSafeSegment("code-review-loop"), true);
  assert.equal(isSafeSegment("a.b_c-d"), true);
  assert.equal(isSafeSegment(".."), false);
  assert.equal(isSafeSegment("../etc"), false);
  assert.equal(isSafeSegment(".hidden"), false);
  assert.equal(isSafeSegment(""), false);
  assert.equal(isSafeSegment(null), false);
  assert.equal(isSafeSegment("x/y"), false, "单段校验不放过斜线 (逐段校验由调用方做)");
  assert.ok(SKIP_SKILL_NAMES.has("template"), "脚手架目录默认跳过");
});

test("importer: 领域推断 —— 已知技能名优先于关键词正则", () => {
  // canvas-design 的正文里有 guide/document 字样, 旧正则曾把它误归 office
  assert.equal(inferDomain("skills/canvas-design some guide document text", "canvas-design"), "content");
  assert.equal(inferDomain("", "theme-factory"), "content");
  assert.equal(inferDomain("", "skill-creator"), "meta");
  assert.equal(inferDomain("", "mcp-builder"), "code");
  assert.equal(inferDomain("", "brand-guidelines"), "business");
  assert.equal(inferDomain("", "academy-guide"), "research");
  assert.equal(inferDomain("", "docx"), "office");
  // 未登记的技能名退回关键词
  assert.equal(inferDomain("my-awesome docx report tool", "my-awesome"), "office");
  assert.equal(inferDomain("nothing matches here at all", "zzz"), "meta", "兜底 meta");
});

test("importer: frontmatter 重写补 domain/source/imported_at 且保留上游正文", () => {
  const upstream = `---\nname: canvas-design\ndescription: Design beautiful visual art\n---\n\n# Canvas Design\n\n## Overview\nbody text\n`;
  const out = rewriteFrontmatter(upstream, { id: "canvas-design", domain: "content", source: "anthropics/skills", tags: ["imported"] });
  assert.ok(out.startsWith("---\n"), "仍以 frontmatter 开头");
  assert.ok(out.includes("name: canvas-design"), "保留上游 name");
  assert.ok(out.includes("domain: content"));
  assert.ok(out.includes("source: anthropics/skills"));
  assert.match(out, /imported_at: \d{4}-\d{2}-\d{2}/);
  assert.ok(out.includes("# Canvas Design") && out.includes("body text"), "正文一字不动");
  // 上游没有 description 时不应写出空的 description 行造成歧义
  const bare = rewriteFrontmatter("# Title\n\nsome body", { id: "x", domain: "meta", source: "a/b" });
  assert.ok(bare.includes("description: "), "description 兜底取正文首行");
  assert.ok(bare.includes("some body"));
});

test("importer: 上游元数据提取 (frontmatter / 正文首段兜底)", () => {
  const withFm = extractUpstreamMeta(`---\nname: foo\ndescription: 上游描述\n---\n\n# F\n\nbody`);
  assert.equal(withFm.name, "foo");
  assert.equal(withFm.description, "上游描述");
  assert.ok(withFm.body.trim().startsWith("# F"), "正文剥离 frontmatter");
  const noFm = extractUpstreamMeta("# Title\n\nFirst real line here\n\nmore");
  assert.equal(noFm.description, "First real line here", "无 frontmatter 时取首个非标题行");
});

test("importer: 导入上限常量存在且合理", () => {
  assert.ok(IMPORT_LIMITS.maxFiles > 0 && IMPORT_LIMITS.maxFiles <= 200);
  assert.ok(IMPORT_LIMITS.maxFileBytes > 0 && IMPORT_LIMITS.maxFileBytes <= 8 * 1024 * 1024);
  assert.ok(IMPORT_LIMITS.timeoutMs > 0, "请求必须有超时 (否则网络半开时整个导入静默卡死)");
});

// ---- 上游源白名单 (2026-10-07 评估报告 P1-3) ----
// 装技能原本必须手工给 GitHub repo ref —— "能装"和"好用"之间差一个可发现性。
// 这里补的是离线白名单解析: 说个源 id 或技能名就能装, 且**绝不做在线搜索**
// (在线搜索 = 一句话把任意第三方代码拉进本地, 与不可信输入约束冲突)。
test("上游源清单: 可读、源 id 可解析、已知技能名可解析", async () => {
  const { upstreamSources, resolveUpstream } = await import("../src/skills/importer.js");
  const { sources, known_skills } = upstreamSources();
  assert.ok(sources.length >= 1, "内置白名单至少要有一个源");
  for (const s of sources) {
    assert.ok(s.id && s.repo, `源缺 id/repo: ${JSON.stringify(s)}`);
    assert.match(s.repo, /^[^/]+\/[^/]+$/, `repo 必须是 owner/repo: ${s.repo}`);
  }
  const first = sources[0].id;
  const byId = resolveUpstream(first);
  assert.ok(byId, `源 id "${first}" 应能解析`);
  assert.equal(byId.repo, sources[0].repo);
  // 大小写与空格不敏感
  assert.ok(resolveUpstream(`  ${first.toUpperCase()} `), "解析应忽略大小写与首尾空格");
  // 已知技能名 → 解析出所属仓库 + 只装这一个
  const name = Object.keys(known_skills)[0];
  if (name) {
    const hit = resolveUpstream(name);
    assert.ok(hit, `已知技能名 "${name}" 应能解析`);
    assert.deepEqual(hit.skills, [name], "按技能名解析时应只导入这一个");
  }
  assert.equal(resolveUpstream("这个源肯定不存在"), null, "未知名字必须返回 null (由调用方明确报错, 不猜仓库)");
  assert.equal(resolveUpstream(""), null);
});
