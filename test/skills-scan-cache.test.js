// test/skills-scan-cache.test.js - OPT-1 技能目录扫描缓存 (目录 mtimeMs 签名) 回归守卫
//
// 背景: agent 每轮 chat 的 _context() → _skillsPrompt() 都会 skills.list(),
//   而旧 _scan() 每次全量 readdir 80 个目录 + stat 67 个文件 ≈ 5.7ms/轮 (占内核开销约 1/3)。
//   v3 缓存把"扫描时 readdir 过的每个目录的 mtimeMs"作为有效性签名, 命中时 readdir = 0。
//
// 钉住的不变量 (缓存不得放宽任何一条):
//   ① 新建技能目录 (扁平 / 领域二级) 后 list() 立即反映
//   ② 删除技能目录 / 删除 SKILL.md 后 list() 立即消失
//   ③ 改 SKILL.md 内容后 get()/read()/readSection() 立即反映 (_sigOf = 文件 mtime+size, 未放宽)
//   ④ 命中缓存时 readdir 次数显著下降 (全树扫描 → 0), 且仍做 stat 有效性校验
//   ⑤ invalidate() 显式失效后下一次 list() 重新扫描
//   ⑥ 多根 first-wins 优先级不变; 首根技能删除后回落第二根
//   ⑦ 异常路径 (根不存在/空根) 不抛错; hidden 与 node_modules 继续跳过; 命中 SKILL.md 不下钻
//   ⑧ 缓存态与"全新 loader 冷扫描"结果完全一致 (语义等价性总闸)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillLoader } from "../src/skills/loader.js";

const tmpRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-scancache-${tag}-`));

function writeSkill(root, rel, { name, desc = "占位说明", body = "## 流程\n1. 做\n\n## 验证\n通过\n" } = {}) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  const leaf = String(name || rel.split("/").pop());
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${leaf}\ndescription: ${desc}\n---\n# ${leaf}\n\n${body}`, "utf8");
}

const idsOf = (loader) => loader.list().map((s) => s.id).sort();

// fs 计数器: 只统计落在被测根目录内的调用, 避免测试框架/OS 其它读写污染计数。
// loader 通过 `import fs from "node:fs"` 的同一对象调用 readdir/stat, 运行时替换属性即可拦截。
function countFs(dir, fn) {
  const origReaddir = fs.readdirSync;
  const origStat = fs.statSync;
  const counter = { readdir: 0, stat: 0 };
  const inside = (p) => {
    try { return typeof p === "string" && path.resolve(p).toLowerCase().startsWith(dir.toLowerCase()); } catch { return false; }
  };
  fs.readdirSync = function (...a) { if (inside(a[0])) counter.readdir++; return origReaddir.apply(this, a); };
  fs.statSync = function (...a) { if (inside(a[0])) counter.stat++; return origStat.apply(this, a); };
  const t0 = performance.now();
  try {
    const result = fn();
    return { counter, result, ms: performance.now() - t0 };
  } finally {
    fs.readdirSync = origReaddir;
    fs.statSync = origStat;
  }
}

// ---- ① 新建技能目录后 list() 立即反映 ----
test("扫描缓存: 新建技能目录后 list() 立即反映 (扁平 + 领域二级)", () => {
  const root = tmpRoot("add");
  try {
    writeSkill(root, "alpha", { desc: "技能 A" });
    const loader = new SkillLoader(root);
    assert.deepEqual(idsOf(loader), ["alpha"]);
    // 扁平新技能
    writeSkill(root, "beta", { desc: "技能 B" });
    assert.deepEqual(idsOf(loader), ["alpha", "beta"], "新建扁平技能目录必须被下一次 list() 发现");
    // 领域二级新技能 (父目录 mtime 变化也必须被发现)
    writeSkill(root, "office/gamma", { desc: "技能 G" });
    assert.deepEqual(idsOf(loader), ["alpha", "beta", "office/gamma"]);
    // 新 domain 目录下的技能
    writeSkill(root, "data/delta", { desc: "技能 D" });
    assert.deepEqual(idsOf(loader), ["alpha", "beta", "data/delta", "office/gamma"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- ② 删除后立即消失 ----
test("扫描缓存: 删除技能目录 / 删除 SKILL.md 后 list() 立即消失", () => {
  const root = tmpRoot("del");
  try {
    writeSkill(root, "alpha");
    writeSkill(root, "office/beta");
    const loader = new SkillLoader(root);
    assert.deepEqual(idsOf(loader), ["alpha", "office/beta"]);
    // 删整个技能目录 → 父目录 mtime 变化 → 重扫
    fs.rmSync(path.join(root, "alpha"), { recursive: true, force: true });
    assert.deepEqual(idsOf(loader), ["office/beta"], "删除扁平技能目录必须立即消失");
    assert.equal(loader.has("alpha"), false);
    // 删 SKILL.md (目录还在) → 目录 mtime 变化 → 重扫
    fs.rmSync(path.join(root, "office", "beta", "SKILL.md"), { force: true });
    assert.deepEqual(idsOf(loader), [], "删除 SKILL.md 后必须不再算技能");
    assert.equal(loader.get("office/beta"), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- ③ 内容修改用 _sigOf (mtime+size) 检测, 未被放宽 ----
test("扫描缓存: 改 SKILL.md 内容后 get()/read()/readSection() 立即反映", () => {
  const root = tmpRoot("content");
  try {
    writeSkill(root, "alpha", { desc: "旧描述", body: "## 流程\n1. 旧步骤\n\n## 验证\n旧验证\n" });
    const loader = new SkillLoader(root);
    assert.equal(loader.get("alpha").description, "旧描述");
    assert.match(loader.read("alpha"), /旧步骤/);
    assert.equal(loader.readSection("alpha", "验证"), "旧验证");
    // 只改文件内容 (目录条目没变 → 目录 mtime 不变, 必须靠文件签名检测)
    writeSkill(root, "alpha", { desc: "新描述", body: "## 流程\n1. 新步骤\n\n## 验证\n新验证通过\n" });
    assert.equal(loader.get("alpha").description, "新描述", "内容修改必须绕过扫描缓存被 _sigOf 发现");
    assert.match(loader.read("alpha"), /新步骤/);
    assert.equal(loader.readSection("alpha", "验证"), "新验证通过");
    // 同长度但内容不同 (mtime 必须变) —— 文件 mtime 签名兜底
    fs.writeFileSync(path.join(root, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 同长描述\n---\n# alpha\n", "utf8");
    assert.equal(loader.get("alpha").description, "同长描述");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- ④ 命中缓存时 readdir 次数显著下降 ----
test("扫描缓存: 稳态 readdir 从 80/次 降到 0, 仍做 stat 校验", async () => {
  const root = tmpRoot("hit");
  try {
    for (let i = 0; i < 6; i++) writeSkill(root, `office/skill-${i}`, { desc: `技能 ${i}` });
    writeSkill(root, "flat");
    const loader = new SkillLoader(root);
    // 刚写完目录就扫描: NTFS 目录时间戳还在合并窗口内, 本次扫描结果标记 provisional,
    // 连续调用必须重扫 (不允许投机复用可能漏掉窗口内变更的缓存)。
    const unstable = countFs(root, () => { loader.list(); loader.list(); });
    assert.ok(unstable.counter.readdir >= 8, `合并窗口内连续调用必须重扫, 实际 readdir ${unstable.counter.readdir}`);
    // 冷态由 invalidate() 显式进入, 不靠 sleep 猜"是否已过合并窗口":
    //   上面的写入循环在高负载机器上本身可能耗时 > 100ms, 于是第一次 list() 时
    //   目录 mtime 早已过窗口、缓存合法建立 —— 旧写法"sleep 250ms 后必须重扫"会随机红
    //   (2026-10-30 全量回归实测偶发)。这里断言的是"冷扫描覆盖全树", 与窗口时序无关。
    await new Promise((r) => setTimeout(r, 250));
    loader.invalidate();
    const cold = countFs(root, () => loader.list());
    assert.ok(cold.counter.readdir >= 8, `invalidate 后的冷扫描应覆盖全树, 实际 ${cold.counter.readdir}`);
    // 稳态: 目录未变 + 签名已过合并窗口 → 全部命中, readdir 必须为 0
    const warm = countFs(root, () => loader.list());
    assert.equal(warm.counter.readdir, 0, `缓存命中时 readdir 必须为 0, 实际 ${warm.counter.readdir}`);
    // 命中路径仍要 stat (目录 mtime 校验 + 每个 SKILL.md 的 mtime+size 校验), 不是"永不过期"
    assert.ok(warm.counter.stat > 0, "命中路径必须仍做 stat 有效性校验");
    assert.ok(warm.counter.stat >= 8, `目录 mtime 校验 + 文件签名都应有 stat, 实际 ${warm.counter.stat}`);
    // 多次调用都不应回退到全量扫描
    const warm2 = countFs(root, () => { loader.list(); loader.list(); loader.list(); });
    assert.equal(warm2.counter.readdir, 0, "连续多次 list() 都要命中");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- ⑤ invalidate() 显式失效 ----
test("扫描缓存: invalidate() 后下一次 list() 重新扫描目录", async () => {
  const root = tmpRoot("inv");
  try {
    writeSkill(root, "alpha");
    const loader = new SkillLoader(root);
    loader.list();
    // 等目录时间戳合并窗口过去, 让缓存进入可复用状态
    await new Promise((r) => setTimeout(r, 250));
    loader.list();
    assert.equal(countFs(root, () => loader.list()).counter.readdir, 0, "先确认已命中");
    loader.invalidate();
    const after = countFs(root, () => loader.list());
    assert.ok(after.counter.readdir > 0, "invalidate() 之后必须重扫目录");
    assert.deepEqual(after.result.map((s) => s.id), ["alpha"], "重扫结果不变");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- ⑥ 多根 first-wins ----
test("扫描缓存: 多根 first-wins 优先级不变, 首根删除后回落第二根", () => {
  const a = tmpRoot("rootA");
  const b = tmpRoot("rootB");
  try {
    writeSkill(a, "data/x", { desc: "来自 A (内置)" });
    writeSkill(b, "data/x", { desc: "来自 B (用户覆盖)" });
    writeSkill(b, "personal/only-b", { desc: "只在 B" });
    const loader = new SkillLoader({ roots: [
      { id: "builtin", dir: a, kind: "builtin", writable: true },
      { id: "user", dir: b, kind: "user", writable: true },
    ] });
    assert.equal(loader.get("data/x").description, "来自 A (内置)", "先到的根胜出 (缓存前)");
    assert.equal(loader.get("data/x").source, "builtin");
    // 再读一次 (命中缓存路径) 仍需保持 first-wins
    assert.deepEqual(idsOf(loader), ["data/x", "personal/only-b"]);
    assert.equal(loader.get("data/x").description, "来自 A (内置)", "命中缓存后 first-wins 不变");
    // 首根技能消失 → 必须重扫并回落到第二根的同 id 技能
    fs.rmSync(path.join(a, "data", "x"), { recursive: true, force: true });
    assert.equal(loader.get("data/x").description, "来自 B (用户覆盖)", "首根删除后应回落第二根");
    assert.equal(loader.get("data/x").source, "user");
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

// ---- ⑦ 异常路径 / 遍历规则不变 ----
test("扫描缓存: 根不存在与空根不抛错, hidden/node_modules 跳过, 命中 SKILL.md 不下钻", async () => {
  const root = tmpRoot("edge");
  const missing = path.join(root, "does-not-exist");
  try {
    const loader = new SkillLoader({ roots: [
      { id: "missing", dir: missing, kind: "builtin", writable: true },
      { id: "empty", dir: root, kind: "user", writable: true },
    ] });
    assert.deepEqual(loader.list(), [], "不存在的根 + 空根 → 空列表且不抛错");
    assert.deepEqual(loader.list(), [], "第二次 (缓存路径) 同样不抛错");
    // hidden / node_modules 即使缓存命中后新增也不该被发现 (但父目录 mtime 变化会重扫 —— 重扫后仍应跳过)
    writeSkill(root, ".hidden/skill", {});
    writeSkill(root, "node_modules/skill", {});
    writeSkill(root, "office/real", { desc: "真技能" });
    assert.deepEqual(idsOf(loader), ["office/real"], "hidden 与 node_modules 必须继续跳过");
    // 技能内 references/ 里的 SKILL.md 不算独立技能 (命中 SKILL.md 的目录不再下钻)
    writeSkill(root, "office/real/references/inner", {});
    assert.deepEqual(idsOf(loader), ["office/real"], "技能目录不再下钻");
    // maxDepth 限制: 三级目录 (depth=3 > maxDepth=2) 不是技能
    writeSkill(root, "office/real/too-deep", {});
    assert.deepEqual(idsOf(loader), ["office/real"]);
    // 缓存命中路径下同样如此
    assert.deepEqual(idsOf(loader), ["office/real"]);
    // 不存在的根不得让扫描缓存永久失效 (否则每轮 list() 都退回全量扫描)
    await new Promise((r) => setTimeout(r, 250));
    loader.list(); // 窗口过去后稳定化一次
    const hit = countFs(root, () => loader.list());
    assert.equal(hit.counter.readdir, 0, `不存在的根不得让缓存失效, 实际 readdir ${hit.counter.readdir}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- ⑧ 读目录失败不抛错, 且不能被缓存成"已确认的空目录" (权限恢复后必须重新看到) ----
test("扫描缓存: readdir 失败不抛错, 恢复后技能必须重新可见", () => {
  const root = tmpRoot("denied");
  const office = path.join(root, "office");
  try {
    writeSkill(root, "office/a", { desc: "技能 A" });
    const loader = new SkillLoader(root);
    assert.deepEqual(idsOf(loader), ["office/a"]);
    // 模拟权限失败: office 目录 readdir 抛 EACCES (stat 仍可成功)
    const origReaddir = fs.readdirSync;
    fs.readdirSync = function (p, ...a) {
      if (typeof p === "string" && path.resolve(p).toLowerCase() === path.resolve(office).toLowerCase()) {
        const e = new Error("EACCES: simulated"); e.code = "EACCES"; throw e;
      }
      return origReaddir.call(this, p, ...a);
    };
    try {
      assert.deepEqual(idsOf(loader), [], "读目录失败时该目录下的技能不可见, 但不抛错");
    } finally {
      fs.readdirSync = origReaddir;
    }
    assert.deepEqual(idsOf(loader), ["office/a"], "读目录恢复后技能必须重新可见 (失败结果不得被缓存)");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- ⑨ 缓存态与冷扫描等价 (总闸) ----
test("扫描缓存: 缓存态 list() 与全新 loader 冷扫描结果完全一致", () => {
  const root = tmpRoot("equiv");
  try {
    writeSkill(root, "alpha", { desc: "A" });
    writeSkill(root, "office/beta", { desc: "B" });
    const loader = new SkillLoader(root);
    loader.list(); // 建立缓存
    // 一串混合变更: 新增 / 改内容 / 删除
    writeSkill(root, "knowledge/gamma", { desc: "G" });
    writeSkill(root, "alpha", { desc: "A2" });
    fs.rmSync(path.join(root, "office", "beta"), { recursive: true, force: true });
    loader.list();
    const fresh = new SkillLoader(root);
    assert.deepEqual(
      loader.list(),
      fresh.list(),
      "缓存态与冷扫描的完整输出 (含 description/source/domain) 必须逐字段相等",
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
