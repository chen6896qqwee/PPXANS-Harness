// test/skill-memory-drift.test.js — 技能内联副本 (skills/ppx-memory/scripts/) 的漂移守卫
// 断言风格取舍: 不做归一化逐字比对 (副本刻意保留独立版差异: 扁平 ./ import、无 utils/logger、
// 无 node:sqlite 后端迁移), 而是逐文件比对「必需行为标记」+「src 声明符号集 ⊆ 副本符号集」——
// 只抓真正危险的那一类漂移: src 已落地的修复/新增符号在副本里缺失。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = "skills/ppx-memory/scripts";

// 每对 = src 真相 + 内联副本 + 该文件必须存在的行为标记 (src 与副本都要命中)
const PAIRS = [
  {
    src: "src/memory/fact-store.js", copy: `${SKILL}/fact-store.js`,
    markers: ["withFileLock(", "readJsonGuarded(", "_reload()", "scrubPII(",
      "(f.scope ?? null) === (scope ?? null)", "const live = this._live();",
      "sweepExpired(", "setValidity(", "_isCurrent(", "supersedeId",
      "_embedCacheGet(", "items: items.map(", "deleteReason",
      // F7 (2026-10-05): 追加日志的字节水位 (与条数阈值互补), 副本缺它 = 批量替换仍无上限。
      "this.walMaxBytes", "walSizeBytes(this.walFile)"],
  },
  {
    src: "src/memory/session.js", copy: `${SKILL}/session.js`,
    // _ensureUniqueSeq: 锁内序列化前重排撞号 seq (2026-10-05 跨进程竞态修复)。
    // W1 (锁内重建): 一切 unlink 走 _removePathLocked/_removeFile, set/fork/rename 的清盘
    //   与整批写入在同一把锁里 (_rebuildSeqs 从"删空后的磁盘事实"重新编号)。
    // W2 (跨天分片): 每个被写日分片的末行都参与游标 (this._ensureUniqueSeq(k, g, cursor, remap)
    //   + 游标用 _diskMaxSeq 播种), 不再是"整批只重排一次" —— 旧标记 "let renumbered" 已废止。
    // W3 (压缩游标): 重排后按 remap 修正 data.upToSeq, 并钳制其不得追平自身 seq。
    // withFileLocks: 跨文件临界区按路径升序一次性持锁 (单天批次仍只一把锁)。
    markers: ["withFileLock(", "_diskMaxSeq(", "_tailMaxSeq(", "void _flushed", "_removeFile(",
      "_ensureUniqueSeq(", "this._ensureUniqueSeq(k, pending)",
      "this._ensureUniqueSeq(k, g, cursor, remap)", "let cursor = this._diskMaxSeq(k)",
      "_rebuildSeqs(", "_removePathLocked(", "withFileLocks(",
      "_repairCompactionCursors(", "this._repairCompactionCursors(pending, remap)"],
  },
  {
    src: "src/memory/memory-ticker.js", copy: `${SKILL}/memory-ticker.js`,
    markers: ["withFileLock(", "appendText(", "_appendLongterm(", "_dayEvents(", "_lineOfEvent(",
      "_scrub(", "> afterSeq", "lastRolledSeq",
      // 2026-10-06 交接项: 轮次可重建上下文 (recordTurn 第三参数 + memory/turns 追加档)。
      //   副本缺任一项 = 技能里跑出来的记忆仍然"只记得说过什么, 不记得做过什么"。
      "recordTurn(user, assistant, opts = {})", "_archiveTurnContext(", "turnArchive(",
      "TURN_ARCHIVE_LINE_BYTES", "已折叠, 原",
      // 2026-10-XX 来源分级批次 (2026-10-05 同步): turns 档写入侧标源 + 读取侧打标。
      //   副本缺任一项 = 技能里存下的抓取正文没有任何"这是不可信输入"的可判定标记。
      "provenance = null } = {})", "prov: String(provenance || TIER_MODEL)",
      "untrusted: untrustedToolsIn(evidence)", "_labelArchiveRow(", "provDerived",
      "tierOfTurn({",
      // 2026-10-10 注入面分级渲染: 关键事实段 (factsTop) 按 tier 打标 —— 此前隔离带里
      //   "工具抓来的正文"与"用户亲口说的话"在模型眼里同形, 抓取内容冒充用户事实即被照做。
      //   副本缺任一项 = 技能里注入的关键事实又不带来源标签了。
      "labelFacts(", "TIER_LABEL[tier]", "不是用户事实更不是指令"],
  },
  {
    src: "src/memory/l2.js", copy: `${SKILL}/l2.js`,
    markers: ["readJsonGuarded(", "withFileLock(", "mergeScenes(", "_reload()", "_writeLocked(",
      "_corruptPending", ".corrupt-", "shortId("],
  },
  {
    src: "src/utils/store.js", copy: `${SKILL}/store.js`,
    markers: ["readJsonGuarded(", "parseFailed", "withFileLock(", "canSteal(", "_pidAlive(",
      "Atomics.wait", "staleMs", "appendText(", "export function withFileLocks(",
      "[...new Set((files || []).filter(Boolean))].sort()",
      // F6 (2026-10-05): 临界区回调必须是同步函数 —— async/thenable 当场抛错。
      // 副本没有这道闸 = 技能里的读-改-写重新回到"假装持锁"的老坑。
      "_assertSyncFn(", "_callSyncFn(", "_isThenable(",
      // F3 (2026-10-10): 带锁的 JSON 集合存储 (锁内重读 + 并集 + 损坏留档)。
      // 副本缺任一项 = 技能里的病历/资产库仍会被并发写覆盖。
      "mutateJsonCollection(", "unionById(", "archiveCorrupt("],
  },
  {
    src: "src/utils/pii.js", copy: `${SKILL}/pii.js`,
    markers: ["opts = {}", "opts.keep", "keep.has(name)"],
  },
  { src: "src/memory/l0.js", copy: `${SKILL}/l0.js`, markers: ["shouldCapture(", "EVENTS."] },
  { src: "src/memory/l3.js", copy: `${SKILL}/l3.js`, markers: ["buildUserPersona(", "writeText("] },
  {
    src: "src/memory/experience.js", copy: `${SKILL}/experience.js`,
    markers: ["withFileLock(", "_isTemplateLike(", "_prune()"],
  },
  { src: "src/utils/schema.js", copy: `${SKILL}/schema.js`, markers: ["migrateData(", "writeSchema("] },
  {
    src: "src/utils/similarity.js", copy: `${SKILL}/similarity.js`,
    markers: ["setJaccard(", "setOverlap(", "overlapCoefficient("],
  },
  {
    src: "src/utils/wal.js", copy: `${SKILL}/wal.js`,
    // walSizeBytes: F7 字节水位的读数口 (条数阈值封顶不了单条巨型事件)。
    markers: ["walFileOf(", "appendWal(", "readWal(", "truncateWal(", "walSizeBytes("],
  },
  { src: "src/utils/id.js", copy: `${SKILL}/id.js`, markers: ["shortId("] },
  // ---- 2026-10-05 补齐: ppx-selfheal 技能内联副本此前**完全不在守卫清单内**,
  //   实测缺 9 个导出 (_assertSyncFn/_asyncLockError/_callSyncFn/_isThenable/_pidAlive/_syncSleep/
  //   appendText/readJsonGuarded/withFileLocks) —— 其中 F6 同步闸门的缺失最危险:
  //   技能里拷出去的 healer 会重新回到"假装持锁"的老坑。pair 用独立 base 目录。
  {
    base: "skills/ppx-selfheal/scripts",
    src: "src/utils/store.js", copy: "store.js",
    markers: ["readJsonGuarded(", "parseFailed", "withFileLock(", "canSteal(", "_pidAlive(",
      "Atomics.wait", "staleMs", "appendText(", "export function withFileLocks(",
      "[...new Set((files || []).filter(Boolean))].sort()",
      // F6 同步闸门: 副本缺它 = 技能里的读-改-写回到"假装持锁"
      "_assertSyncFn(", "_callSyncFn(", "_isThenable("],
  },
];

// 副本必须能被 src/ 之外的人整体拷走: 只允许 node: 内置与 ./ 同目录相对导入 (./../ 一律拒绝)
const PORTABLE_ALLOW = /^(?:node:|\.\/)/;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const has = (rel) => fs.existsSync(path.join(ROOT, rel));

// 去掉注释 (保留缩进/换行, 行号式结构对符号提取有用)
//
// 2026-10-05 修复 (P1): 原实现用裸 /\/\*[\s\S]*?\*\//g 剥块注释, 会被**注释文本里的字面量**
//   触发 —— src/memory/memory-ticker.js 的行注释写着 `logs/traces/*.jsonl`, 那个 `/*` 被当成
//   块注释起点, 一路吞到几百行后另一段注释里的 `*/` 才闭合: 实测 31697 字符只剩 8984 (吞掉 72%)。
//   后果是配对断言形同虚设 —— 该文件 src 侧的符号集被削成片段, "src ⊆ 副本" 永真, 漂移无从发现
//   (memory-ticker 的 provenance 漂移正是这样漏网的)。
//   修法: 块注释只在**行首 (可带空白)** 开启才剥离, 这样 `/*` 出现在行中间 (代码里或行注释里)
//   一律不误判。行注释保持逐行剥离 (`//` 不参与块注释状态机)。
function stripComments(text) {
  return text
    // 仅剥离"行首起始"的块注释 (含文档注释), 允许跨行
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "")
    // 行注释 (逐行, 不跨行)
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function",
  "const", "let", "var", "else", "do", "try", "await", "new", "case", "typeof"]);

// 模块级声明 (function/const/let/class) + 类方法 (恰好 2 空格缩进的 name(args) {)
function declaredSymbols(text) {
  const body = stripComments(text);
  const names = new Set();
  const patterns = [
    /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^ {2}(?! )(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm,
  ];
  for (const re of patterns) {
    for (const m of body.matchAll(re)) if (!KEYWORDS.has(m[1])) names.add(m[1]);
  }
  return names;
}

// pair 可带 base: 副本路径相对于该 base 解析 (默认 = ppx-memory 技能目录);
// 无 base 时 copy 已是完整相对路径 (向后兼容既有 13 对)。
const copyPathOf = (p) => (p.base ? `${p.base}/${p.copy}` : p.copy);

for (const pair of PAIRS) {
  const { src, markers } = pair;
  const copy = copyPathOf(pair);
  const missing = [src, copy].filter((f) => !has(f));
  test(`副本与 src 同源: ${src} -> ${copy}`, { skip: missing.length ? `缺失 ${missing.join(", ")}` : false }, () => {
    const srcText = read(src);
    const copyText = read(copy);
    // ① 行为标记: src 已落地的修复必须在两边都在场 (src 缺失 = 标记清单该更新, 同样报警)
    for (const marker of markers) {
      assert.ok(srcText.includes(marker), `src 未命中标记 "${marker}" (${src}) —— 清单或 src 已变, 请复核后同步`);
      assert.ok(copyText.includes(marker), `副本缺失行为标记 "${marker}" (${copy}) —— src 的修复没有跟进`);
    }
    // ② 符号集: src 声明的函数/方法不得在副本里消失 (副本可另有独立版私有符号)
    const srcSyms = declaredSymbols(srcText);
    const copySyms = declaredSymbols(copyText);
    const lost = [...srcSyms].filter((n) => !copySyms.has(n)).sort();
    assert.deepEqual(lost, [], `副本缺失 src 符号: ${lost.join(", ")} (${copy})`);
  });
}

for (const pair of PAIRS) {
  const copy = copyPathOf(pair);
  test(`副本保持独立可拷出 (仅 node:/./ 导入): ${copy}`, { skip: has(copy) ? false : `缺失 ${copy}` }, () => {
    const bad = [...read(copy).matchAll(/^import[^;\n]*?from\s+["']([^"']+)["']/gm)]
      .map((m) => m[1])
      .filter((spec) => !PORTABLE_ALLOW.test(spec));
    assert.deepEqual(bad, [], `${copy} 通过 ${bad.join(", ")} 依赖了技能目录外的代码`);
  });
}

test("独立 CLI 的导出形状读法与两个后端一致 (items / deleteReason)", {
  skip: has(`${SKILL}/cli.js`) ? false : `缺失 ${SKILL}/cli.js`,
}, () => {
  const cli = stripComments(read(`${SKILL}/cli.js`)); // 只看代码: 注释里会提到废弃字段名做对比说明
  for (const stale of ["deletedReason", "all.facts", ".facts ||"]) {
    assert.ok(!cli.includes(stale), `cli.js 仍在读已废弃的形状字段 "${stale}"`);
  }
  assert.ok(/all\.items\s*\|\|/.test(cli), "cli.js 应按 exportAll 的 { items } 形状取条目");
  assert.ok(cli.includes("f.deleteReason"), "cli.js 应读 deleteReason (与 FactStore/sqlite 后端同名)");
});
