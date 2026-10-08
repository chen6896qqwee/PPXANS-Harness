// test/longterm-tail-retention-2026-10-04.test.js — F9: 长期记忆热路径尾窗 + 保留期
// 钉住两条不变量:
//   F9a  pre-LLM 热路径 (MemoryTicker.context) 不得整文件读 longterm.md —— 追加型归档一律尾窗读
//        (同 src/audit/audit-chain.js 的 _tailEntry), 且尾窗结果必须与旧的"全量读"逐字一致。
//   F9b  longterm.md / memory/daily/*.md / logs/traces/*.jsonl 必须有保留期, 且挂在**已有的每日边界**
//        (_rollDay 的 lastRetentionDay 游标) 上, 不新增定时器; 只按天龄从最旧端裁, 近期上下文不丢。
// 全程离线确定性: 不测墙钟时间, 只测"读了多少字节 / 删了哪几段 / 留下了哪几段"。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactStore } from "../src/memory/fact-store.js";
import { MemoryTicker } from "../src/memory/memory-ticker.js";
import { logicalDay } from "../src/utils/store.js";

function tmp(name = "f9") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${name}-`));
}

// 相对今天往前 n 天的逻辑日 (与 logicalDay 同为本地时区 YYYY-MM-DD)
function dayAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 合成 longterm.md: 每天一段 (## 日期 + 40 行原文), 一直写到 targetBytes 为止
// day 上限取得很大 (4000): 循环靠 targetBytes 停, 天龄只决定段头日期; 尾窗只看文件最后几十 KB,
// 所以这里刻意造的是一个"历史很长、今天只在尾部"的归档, 与真实 longterm.md 同构。
function seedLongterm(file, targetBytes) {
  let out = "# 长期记忆\n";
  let day = 4000;
  while (Buffer.byteLength(out, "utf8") < targetBytes && day > 0) {
    out += `\n## ${dayAgo(day)}\n`;
    for (let i = 0; i < 40; i++) out += `- [${dayAgo(day)}T01:00:0${i % 10}.000Z] 用户: 第${day}天第${i}条对话原文 合成压力样本\n`;
    day--;
  }
  fs.writeFileSync(file, out, "utf8");
  return out;
}

// 旧实现 (2026-10-04 F9 之前) 的 longterm 取法, 逐字照抄用于对照断言:
// 全量 readText + 剔除今天段 + 取最后 3000 字符
function legacyLongtermExcerpt(text, today) {
  const excluded = (() => {
    const outLines = [];
    let inToday = false;
    for (const l of String(text || "").split("\n")) {
      const m = l.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
      if (m) { inToday = (m[1] === today); continue; }
      if (!inToday) outLines.push(l);
    }
    return outLines.join("\n").trim();
  })();
  return excluded.slice(-3000);
}

// 从 context() 输出里截出"# 长期记忆 (最近)"那一段。
// 不 trim: 旧实现按字符数切片, 切点可能落在行中, 前导空格也是"逐字一致"断言的一部分
function longtermSectionOf(ctxText) {
  const head = "# 长期记忆 (最近)\n";
  const start = ctxText.indexOf(head) + head.length;
  const end = ctxText.indexOf("\n\n# 关键事实", start);
  return ctxText.slice(start, end === -1 ? undefined : end);
}

function makeTicker(dir) {
  const facts = new FactStore(dir);
  return new MemoryTicker(dir, facts, null, null);
}

// ---- F9a 尾窗 ----
test("F9a context(): 1.9MB 的 longterm.md 只读一个尾窗, 不再全量读盘", () => {
  const dir = tmp("tail");
  const ticker = makeTicker(dir);
  const raw = seedLongterm(ticker.longtermMd, 1.9 * 1024 * 1024);
  const fileBytes = fs.statSync(ticker.longtermMd).size;
  assert.ok(fileBytes >= 1.9 * 1024 * 1024, `样本至少 1.9MB, 实际 ${fileBytes}`);

  const ctx = ticker.context("随便问点什么");
  const readBytes = ticker._lastContextTailBytes;
  const windowBytes = MemoryTicker.LONGTERM_TAIL_WINDOW_BYTES;

  assert.equal(readBytes, windowBytes, `尾窗一次读到 ${windowBytes} 字节就该够用, 实际 ${readBytes}`);
  assert.ok(readBytes < fileBytes / 20, `读字节数应远小于文件 (${readBytes} vs ${fileBytes})`);
  // 旧实现的读取量 = 整个文件; 这里不测耗时, 只测读取量 (确定性)
  assert.equal(ctx.includes("# 长期记忆 (最近)"), true, "上下文结构不变");
  assert.ok(longtermSectionOf(ctx).length > 0, "尾窗仍能取到长期记忆");
  assert.ok(raw.length > 0);
});

test("F9a context(): 尾窗结果与旧的'全量读'逐字一致 (语义零漂移)", () => {
  const dir = tmp("tail2");
  const ticker = makeTicker(dir);
  seedLongterm(ticker.longtermMd, 1.9 * 1024 * 1024);
  const today = logicalDay();
  const expected = legacyLongtermExcerpt(fs.readFileSync(ticker.longtermMd, "utf8"), today);
  const got = longtermSectionOf(ticker.context("x"));
  assert.equal(got, expected, "尾窗取到的最后 3000 字符必须与全量读完全相同");
  assert.equal(expected.length, MemoryTicker.LONGTERM_CONTEXT_CHARS, "窗口扩张判据: 够 3000 字符即停");
});

test("F9a 尾窗对齐: 窗口起点落在'今天'段中间时, 今天的原文不得混进长期记忆", () => {
  const dir = tmp("tailalign");
  const ticker = makeTicker(dir);
  const today = logicalDay();
  // 构造: 历史段在前, 今天一段极大 (远超尾窗字节数) 且带唯一标记字符串在后面
  let out = "# 长期记忆\n";
  for (let d = 300; d >= 1; d--) {
    out += `\n## ${dayAgo(d)}\n`;
    for (let i = 0; i < 20; i++) out += `- [${dayAgo(d)}] 皮皮虾: 历史第${d}天第${i}条\n`;
  }
  out += `\n## ${today} (滚动)\n`;
  for (let i = 0; i < 4000; i++) out += `- [${today}] 用户: TODAYONLY 今天的原文第${i}条不该出现在长期记忆里\n`;
  fs.writeFileSync(ticker.longtermMd, out, "utf8");
  const size = fs.statSync(ticker.longtermMd).size;

  const got = longtermSectionOf(ticker.context("x"));
  assert.ok(!got.includes("TODAYONLY"), "今天的段必须被剔除 (哪怕段头落在窗口外)");
  assert.ok(ticker._lastContextTailBytes <= size, "窗口读数不超过文件大小");
  assert.equal(got, legacyLongtermExcerpt(fs.readFileSync(ticker.longtermMd, "utf8"), today));
});

test("F9a 小文件/空文件: 尾窗退化为整文件, 结果与旧实现一致 (兼容边界)", () => {
  const dir = tmp("tailsmall");
  const ticker = makeTicker(dir);
  const today = logicalDay();
  fs.writeFileSync(ticker.longtermMd, `# 长期记忆\n\n## ${dayAgo(3)}\n- 三天前的一件事\n\n## ${today}\n- 今天的事\n`, "utf8");
  const got = longtermSectionOf(ticker.context("x"));
  assert.equal(got, legacyLongtermExcerpt(fs.readFileSync(ticker.longtermMd, "utf8"), today));
  assert.ok(got.includes("三天前的一件事") && !got.includes("今天的事"));
  assert.equal(ticker._lastContextTailBytes, fs.statSync(ticker.longtermMd).size, "小文件窗口=整文件");

  const empty = makeTicker(tmp("tailempty"));
  assert.equal(longtermSectionOf(empty.context("x")), "(暂无)");
  assert.equal(empty._lastContextTailBytes, 0, "文件不存在: 一字节都不读");
});

// ---- F9b 保留期 ----
test("F9b 保留期: 过期 longterm 段被裁, 近期段与今天的段全留 (挂在每日边界上)", () => {
  const dir = tmp("retain");
  const ticker = makeTicker(dir);
  const today = logicalDay();
  fs.writeFileSync(ticker.longtermMd, [
    "# 长期记忆 (前言, 无日期归属)",
    `## ${dayAgo(400)}`,
    "- 很久很久以前的原文 (超过 180 天保留期)",
    `## ${dayAgo(100)}`,
    "- 一百天前的事 (在保留期内)",
    `## ${today}`,
    "- 今天的事",
    "",
  ].join("\n"), "utf8");
  // 手工插的无日期段头不参与年龄裁剪
  fs.appendFileSync(ticker.longtermMd, "## 某个不带日期的段落\n- 不该被裁\n", "utf8");

  ticker.state.lastRetentionDay = null; // 模拟"新的一天第一次调用"
  ticker._rollDay();

  const after = fs.readFileSync(ticker.longtermMd, "utf8");
  assert.ok(!after.includes("很久很久以前"), "超过保留期的段应被裁掉");
  assert.ok(after.includes("一百天前的事"), "保留期内的段必须留下");
  assert.ok(after.includes("今天的事"), "今天的段绝不裁 (近期上下文不丢)");
  assert.ok(after.includes("前言, 无日期归属"), "无日期归属的前言永久保留");
  assert.ok(after.includes("不带日期的段落"), "无日期段头的段不参与年龄裁剪");
  assert.equal(ticker.state.lastRetentionDay, today, "游标推进: 一天只跑一次");
  assert.equal(ticker.state.retention.longterm_sections_dropped, 1);
  // 治理仍可检索 (清理没有把 retrieval 需要的内容带走)
  assert.ok(longtermSectionOf(ticker.context("x")).includes("一百天前的事"), "近期长期记忆仍注入 context");
});

test("F9b 保留期: daily/*.md 与 logs/traces/*.jsonl 按文件名日期清理, 非按日命名的文件不碰", () => {
  const dir = tmp("retainfiles");
  const ticker = makeTicker(dir);
  const daily = path.join(ticker.dir, "daily");
  const traces = path.join(dir, "logs", "traces");
  fs.mkdirSync(traces, { recursive: true });
  const mk = (p) => fs.writeFileSync(p, "x", "utf8");
  mk(path.join(daily, `${dayAgo(400)}.md`));
  mk(path.join(daily, `${dayAgo(100)}.md`));
  mk(path.join(daily, `${logicalDay()}.md`));
  mk(path.join(daily, "手工备份.md"));
  mk(path.join(traces, `${dayAgo(200)}.jsonl`));      // 超过 90 天
  mk(path.join(traces, `events-${dayAgo(200)}.jsonl`)); // 超过 90 天
  mk(path.join(traces, `events-${dayAgo(5)}.jsonl`));   // 保留
  mk(path.join(traces, "manual-snapshot.jsonl"));       // 不按日命名 → 不碰

  ticker.state.lastRetentionDay = null;
  ticker._rollDay();

  assert.ok(!fs.existsSync(path.join(daily, `${dayAgo(400)}.md`)), "过期 daily 归档应被回收");
  assert.ok(fs.existsSync(path.join(daily, `${dayAgo(100)}.md`)), "保留期内 daily 不动");
  assert.ok(fs.existsSync(path.join(daily, `${logicalDay()}.md`)), "今天的 daily 绝不删");
  assert.ok(fs.existsSync(path.join(daily, "手工备份.md")), "非按日命名的文件一律不碰");
  assert.ok(!fs.existsSync(path.join(traces, `${dayAgo(200)}.jsonl`)), "工具轨迹按日文件过期即回收");
  assert.ok(!fs.existsSync(path.join(traces, `events-${dayAgo(200)}.jsonl`)), "事件流按日文件同样回收");
  assert.ok(fs.existsSync(path.join(traces, `events-${dayAgo(5)}.jsonl`)), "近期轨迹保留");
  assert.ok(fs.existsSync(path.join(traces, "manual-snapshot.jsonl")));
  assert.equal(ticker.state.retention.daily_files_removed, 1);
  assert.equal(ticker.state.retention.trace_files_removed, 2);
});

test("F9b 保留期一天只跑一次 (第二次调用是空操作), 不新增定时器", () => {
  const dir = tmp("onceperday");
  const ticker = makeTicker(dir);
  assert.equal(ticker.state.lastRetentionDay, logicalDay(), "构造时已跑过今天这一次");
  const daily = path.join(ticker.dir, "daily");
  fs.writeFileSync(path.join(daily, `${dayAgo(400)}.md`), "x", "utf8");
  ticker._rollDay(); // 同一天再调: 游标已置, 不得再动盘
  assert.ok(fs.existsSync(path.join(daily, `${dayAgo(400)}.md`)), "同一天重复调用不重复清理");
  ticker.state.lastRetentionDay = null;
  ticker._rollDay();
  assert.ok(!fs.existsSync(path.join(daily, `${dayAgo(400)}.md`)), "跨天边界才清 (由 _rollDay 触发)");
});

test("F9b 体积上限: 超 LONGTERM_MAX_BYTES 时从最旧段续裁, 最近 KEEP_SECTIONS 段无条件保留", () => {
  const dir = tmp("capbytes");
  const ticker = makeTicker(dir);
  // 全部段都在保留期内 (天龄 1~120 天), 只能靠体积上限裁
  let out = "# 长期记忆\n";
  for (let d = 120; d >= 1; d--) {
    out += `\n## ${dayAgo(d)}\n`;
    const filler = "填充内容一二三四五六七八九零".repeat(30);
    for (let i = 0; i < 20; i++) out += `- [${dayAgo(d)}] 用户: ${filler}\n`;
  }
  fs.writeFileSync(ticker.longtermMd, out, "utf8");
  const before = fs.statSync(ticker.longtermMd).size;
  assert.ok(before > MemoryTicker.LONGTERM_MAX_BYTES, `样本需超过体积上限, 实际 ${before}`);

  ticker.state.lastRetentionDay = null;
  ticker._rollDay();
  const after = fs.readFileSync(ticker.longtermMd, "utf8");
  const bytes = fs.statSync(ticker.longtermMd).size;
  assert.ok(bytes < before, "体积超限必须被压下来");
  const kept = [...after.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
  assert.ok(kept.length >= MemoryTicker.LONGTERM_KEEP_SECTIONS, `至少留最近 ${MemoryTicker.LONGTERM_KEEP_SECTIONS} 段, 实际 ${kept.length}`);
  assert.ok(after.includes(`## ${dayAgo(1)}`), "最近一段必须在 (裁的是最旧端)");
  assert.ok(after.includes(`## ${dayAgo(kept.length - 1)}`), "保留的应是连续的最近段");
  assert.ok(ticker.state.retention.longterm_sections_dropped > 0);
});

test("F9b 保留期可观测: stats() 报出尾窗读数与上次清理结果", () => {
  const dir = tmp("stats");
  const ticker = makeTicker(dir);
  seedLongterm(ticker.longtermMd, 300 * 1024);
  ticker.context("x");
  const s = ticker.stats();
  assert.equal(s.longterm_tail_bytes, MemoryTicker.LONGTERM_TAIL_WINDOW_BYTES);
  assert.ok(s.longterm_context_read_bytes <= s.longterm_bytes, "本轮读取量 ≤ 文件大小");
  assert.ok(s.longterm_context_read_bytes < s.longterm_bytes, "大文件上读取量必须明显小于文件");
  assert.equal(s.retention_day, logicalDay());
  assert.ok(s.retention && typeof s.retention.longterm_sections_dropped === "number");
});
