// test/prefix-cache-static-region.test.js - 前缀缓存静态区的两条存储/组装契约 (2026-10-05)
// 背景: system prompt 按"静态区在前 / 检索尾 (memory.context+scene 随 userMsg 变) 在后"组装,
// provider 缓存只匹配最长公共前缀。cache-audit 抓到两条回归:
//   1) habits = experience.context() + _l3Context() 坐在静态区, 新增一条长期记忆 + 同天重启
//      就会让 L3 画像重建 → 静态区字节变 → 整个前缀作废 (学习→重启 因果探针 @+1081 ## 关注主题);
//   2) L3 persona markdown 正文烘死 logicalDay() → 每天白白分叉一次。
// 本测试钉住修复后的四条契约 (全离线, 零 LLM 调用):
//   A. L3 画像正文不含任何日期形态; 更新日只落 meta.json;
//   B. 旧文件 (已烘日期) 首次读取即惰性迁移: 正文变干净 + 日期进 meta + 磁盘重写, 信息不丢;
//   C. 刷新档跨进程持久: 同一天"学习→重启"不再重建画像, _context 静态区逐字节不变;
//   D. 组装次序: ANS 价值块仍居首; 经验(learning)块位于静态区末位、动态检索段之前;
//      画像块保留在身份区 (原 habits 槽位), 未被挪出 system 消息 (不降级为可忽略尾注)。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersonaStore } from "../src/memory/l3.js";
import { PPXAgent } from "../src/agent/index.js";
import { ToolCatalog } from "../src/tools/catalog.js";
import { setLevel } from "../src/utils/logger.js";

setLevel("error"); // 测试输出降噪 (与 cache-audit-core 同一手法)

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-pcache-${tag}-`));
const DATE_RE = /\d{4}-\d{2}-\d{2}/;

// 旧版 buildUserPersona 的落盘形态 (正文烘日期 + 生成时间行) —— 迁移用例的输入
const LEGACY_USER_MD = `# 兄弟 的用户画像

> 由皮皮虾 L3 画像引擎生成 | 更新: 2026-09-20

## 关注主题
- 量化交易 (出现3次)

## 记忆概要
- 兄弟喜欢做A股量化交易

## 画像版本
- 生成时间: 2026-09-20
- 数据来源: 对话记忆 + 用户主动分享
`;
const LEGACY_AGENT_MD = `# 皮皮虾 自我画像

> 从经验库自动学习 | 更新: 2026-09-20

## 学到的经验
- 先读后改

## 能力画像
- 工具: 文件操作 / 命令执行 / 搜索 / HTTP / 定时任务
`;

test("A: 新建画像正文零日期, 更新日只进 meta.json", () => {
  const dir = tmp("build");
  try {
    const ps = new PersonaStore(dir);
    const facts = [{ content: "兄弟喜欢做A股量化交易", source: "conversation" }];
    const md = ps.buildUserPersona(facts, { force: true });
    ps.buildAgentPersona([{ lesson: "先读后改" }], { force: true });
    assert.ok(!DATE_RE.test(md), "user 画像正文不应含日期, 实得: " + md);
    assert.ok(!DATE_RE.test(fs.readFileSync(ps.agentFile, "utf8")), "agent 画像正文不应含日期");
    const days = ps.personaDays();
    assert.ok(days.user && days.agent, "meta.json 应记录两份画像的生成日");
    assert.match(days.user, /^\d{4}-\d{2}-\d{2}$/, "meta.userPersonaDay 是逻辑日");
    assert.equal(ps.stats().user_updated, days.user, "stats 优先报 meta 日期档 (mtime 会被迁移/重写污染)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("B: 已烘日期的旧画像文件惰性迁移 —— 正文剥净, 日期迁进 meta, 磁盘重写", () => {
  const dir = tmp("migrate");
  try {
    fs.mkdirSync(path.join(dir, "memory", "l3"), { recursive: true });
    fs.writeFileSync(path.join(dir, "memory", "l3", "user.persona.md"), LEGACY_USER_MD, "utf8");
    fs.writeFileSync(path.join(dir, "memory", "l3", "agent.persona.md"), LEGACY_AGENT_MD, "utf8");
    const ps = new PersonaStore(dir);
    const u = ps.userPersona();
    assert.ok(!DATE_RE.test(u), "迁移后正文不应再有烘死日期: " + u);
    assert.ok(u.includes("# 兄弟 的用户画像") && u.includes("量化交易"), "迁移不丢画像内容");
    assert.ok(!DATE_RE.test(fs.readFileSync(ps.userFile, "utf8")), "磁盘文件被重写为无日期形态");
    assert.equal(ps.personaDays().user, "2026-09-20", "旧烘日期迁进 meta, 信息不静默丢失");
    // 幂等: 第二次读不再触碰磁盘
    const before = fs.statSync(ps.userFile).mtimeMs;
    ps.userPersona(); ps.userPersona();
    assert.equal(fs.statSync(ps.userFile).mtimeMs, before, "迁移幂等 (每实例一次), 不反复重写");
    // 只剥"生成模板"的两行, 不碰事实内容里的日期
    const ps2dir = tmp("migrate-content");
    try {
      const ps2 = new PersonaStore(ps2dir);
      const withDateFact = [{ content: "约定 2027-01-05 复盘", source: "manual" }];
      const md = ps2.buildUserPersona(withDateFact, { force: true });
      assert.ok(md.includes("2027-01-05"), "用户事实自带的日期不是'烘进模板的日期', 不该被动迁移");
      assert.ok(!md.includes("更新:"), "模板行仍不应烘日期");
    } finally { fs.rmSync(ps2dir, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("C: 学习→同天重启 不重建画像, system 静态区逐字节不变 (cache-audit 探针的同源单元证)", () => {
  const dir = tmp("relaunch");
  try {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "ppx.json"), JSON.stringify({ providers: [] }), "utf8");
    const mkSvc = (agent) => agent.memorySvc;
    let static1 = null;
    const a1 = new PPXAgent({ root: process.cwd(), configFile: null, dataDir: dir, globalDataDir: dir });
    try {
      static1 = a1._context("审计问题一").split("\n# 今日对话")[0];
      a1.facts.add("学习→重启探针写入的长期记忆样本", { source: "manual", dedupe: false });
      // afterTurn 同日触发 refreshPersona: 内存档已置, 不该写盘
      mkSvc(a1).refreshPersona();
      const static1b = a1._context("审计问题一").split("\n# 今日对话")[0];
      assert.equal(static1b, static1, "同一天内新增记忆后重建 _context, 静态区字节不变");
    } finally { a1.shutdown(); }
    const a2 = new PPXAgent({ root: process.cwd(), configFile: null, dataDir: dir, globalDataDir: dir });
    try {
      const static2 = a2._context("换了另一个问题").split("\n# 今日对话")[0];
      assert.equal(static2, static1, "同天重启 (旧进程已写入学习) 后静态区仍逐字节一致 —— 学习不作废前缀");
      assert.ok(!DATE_RE.test(static2), "静态区不含日期形态 (cache-audit volatile 扫描的同一判据)");
    } finally { a2.shutdown(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("D: 组装次序契约 —— 价值居首 / 画像在身份区 / 经验在静态区末位且严格早于检索尾", () => {
  const dir = tmp("order");
  try {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "ppx.json"), JSON.stringify({ providers: [] }), "utf8");
    const a = new PPXAgent({ root: process.cwd(), configFile: null, dataDir: dir, globalDataDir: dir });
    try {
      a.experience.learn({ task: "t", lesson: "次序契约探针经验", tags: ["test"] });
      const ctx = a._context("随便问个问题");
      const iValues = ctx.indexOf("【核心价值");
      const iPersona = ctx.indexOf(String(a.persona.systemPrompt(a.userName)).slice(0, 24));
      const iProfile = ctx.indexOf("# 兄弟 的用户画像") >= 0 ? ctx.indexOf("# 兄弟 的用户画像") : ctx.indexOf("自我画像");
      const iLessons = ctx.indexOf("次序契约探针经验");
      const iMemoryTail = ctx.indexOf("# 今日对话");
      assert.ok(iPersona >= 0, "人格卡片必须注入");
      assert.ok(iValues === -1 || iPersona > iValues, "ANS 价值块若存在必须仍是第一块");
      assert.ok(iProfile > iPersona && iProfile < iMemoryTail, "L3 画像仍在 system 消息身份区 (未降级为尾注/移出)");
      assert.ok(iLessons > 0 && iLessons < iMemoryTail, "经验块在动态检索段之前 (仍在 system 内)");
      const iSkills = ctx.indexOf("【可用技能】");
      assert.ok(iLessons > iSkills, "经验块被后移到静态区末位 (技能清单之后), 学习事件分叉代价最小");
      const staticEnd = ctx.slice(0, iMemoryTail);
      assert.ok(!DATE_RE.test(staticEnd), "画像/经验文本在静态区也不引入日期");
    } finally {
      a.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally { /* dir 已在上方清理 */ }
});

test("E: 工具数组与按需工具名单按名称规范序 (注册时序抖动不再作废前缀)", () => {
  const names = ["zebra_tool", "alpha_tool", "mid_tool"];
  const reg = (c, list) => {
    for (const n of list) c.register({ name: n, description: n, parameters: {}, execute: async () => "" });
  };
  const c1 = new ToolCatalog(); reg(c1, names);
  const c2 = new ToolCatalog(); reg(c2, [...names].reverse());
  assert.deepEqual(c1.toOpenAI().map((t) => t.function.name), c2.toOpenAI().map((t) => t.function.name),
    "toOpenAI 与注册顺序无关 (纯排序)");
  assert.deepEqual(c1.toOpenAI().map((t) => t.function.name), [...names].sort(), "输出=名称字节升序");
  c1.setExposure(["alpha_tool"]);
  assert.deepEqual(c1.hiddenFromLLM(), ["mid_tool", "zebra_tool"], "hiddenFromLLM (静态区【按需工具】名单) 同样规范序");
});
