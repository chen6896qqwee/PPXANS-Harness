// src/memory/memory-ticker.js - 记忆水位线 (参考 openhanako v4)
// 架构: 会话事件日志 (SessionStore) 为唯一事实源; 今日视图由它派生
// 不再独立维护 today.md 对话原文 (原 l0/session/today 三处重复, 已收敛到 session)
// 今日视图 -> 滚动压缩 -> longterm.md (长期记忆)
// 2026-10-06 交接项新增 memory/turns/YYYY-MM-DD.jsonl: 它**不是**第四处对话原文, 也不是事实源,
//   而是记忆层的"每轮做过什么"派生档 (工具调用/回执摘要 + 轮内中间草稿)。三条边界写死在这里:
//     ① 蒸馏 (extractor/addMemory) 永远只看 user + 最终回复 —— turns 档的正文绝不进事实库;
//     ② context()/longterm.md 的派生链从不读它 (那条链只认 session 的 user/assistant 事件),
//        所以普通轮次的 prompt 固定开销零增长;
//     ③ 只追加, 不改写已写过的行; 体积有单条折叠 + 每类条数 + 单行字节三重封顶, 天龄有保留期。
import fs from "node:fs";
import path from "node:path";
import { ensureDir, appendText, readText, writeText, readJson, writeJson, logicalDay, withFileLock } from "../utils/store.js";
import { debug, info, warn } from "../utils/logger.js";
import { scrubPII } from "../utils/pii.js";
// v2026-10-XX (来源分级): 本轮 tier 与"关键事实"渲染都走 provenance.js (零依赖, 与技能副本同源)
import {
  tierOfTurn, tierFromEvidence, untrustedToolsIn, isQuarantined, tierOfRecord, factLine,
  normalizeTier, TIER_MODEL,
} from "./provenance.js";

const TURNS_PER_SUMMARY = 10;
const COMPACT_THRESHOLD = 50;   // 今日事件超此条数触发滚动压缩
const COMPACT_KEEP = 20;        // 压缩后保留的近期条数
const COMPACT_MIN_INTERVAL_MS = 60000; // 压缩节流: 压缩后 60s 内不重复 (防每轮对话重复付 LLM 压缩成本, v1.0.7)

// 派生今日视图行: 从 session 事件渲染 (role -> 中文说话人)
function _renderLines(sessionStore, day) {
  if (!sessionStore) return [];
  return sessionStore.eventsByDay(day).map((r) => {
    const who = r.role === "user" ? "用户" : "皮皮虾";
    return `- [${new Date(r.timestamp).toISOString()}] ${who}: ${String(r.content).slice(0, 200)}`;
  });
}

// 归档写入专用: 带 seq 的当天事件 (eventsByDay 的投影没有 seq, 无法做游标)
// 三处 longterm 写入 (日终归档 / 滚动 / rollup 压缩) 共用同一个 seq 游标,
// 否则同一段对话会被写第二遍 —— 旧实现 _compileDaily 无视滚动游标, 每次跨天把
// 上一日**全文**再追加一遍, longterm.md 因此成倍膨胀并把重复内容回灌进每轮 context。
function _dayEvents(sessionStore, day) {
  if (!sessionStore || typeof sessionStore.replayDay !== "function") return [];
  try { return sessionStore.replayDay(day) || []; } catch { return []; }
}

function _lineOfEvent(e) {
  const who = e.type === "user/message" ? "用户" : "皮皮虾";
  return `- [${new Date(e.ts).toISOString()}] ${who}: ${String(e.data?.content || "").slice(0, 200)}`;
}

export class MemoryTicker {
  // ==== 长期记忆热窗口 + 保留期 (2026-10-04 F9) ====
  // 尾窗字节数: context() 每轮 LLM 请求前都要读 longterm.md, 而它是只增不减的追加型归档。
  //   旧实现 readText 全量读: 实测 1.9MB 文件读 1,128,890 字符只为留最后 3000 字符,
  //   5.2ms/轮 **同步**阻塞 HTTP 与所有 SSE 客户端, 且成本随文件线性上涨。
  //   与 audit-chain.js 的 _tailEntry (只读末 16KB) 同一口径: 追加型日志一律尾窗读。
  static LONGTERM_TAIL_WINDOW_BYTES = 32768;
  static LONGTERM_TAIL_GROWTH = 4;        // 窗口不够用时按 4x 扩张 (最多读到整文件)
  static LONGTERM_CONTEXT_CHARS = 3000;   // 注入上下文的字符上限 (与旧实现 slice(-3000) 一致)
  // 保留期 (天): 只按"天龄"从最旧端裁, 近期上下文一律留全 —— 增长被年龄/体积双上限封顶
  static LONGTERM_RETAIN_DAYS = 180;      // longterm.md 段落保留期; 0 = 不按年龄裁
  static LONGTERM_MAX_BYTES = 524288;     // 体积上限: 超出继续从最旧段裁, 但绝不裁到最近 N 段
  static LONGTERM_KEEP_SECTIONS = 14;     // 体积裁剪时无条件保留的最近段数 (今天的段永远保留)
  static DAILY_RETAIN_DAYS = 180;         // memory/daily/YYYY-MM-DD.md 保留期 (session 事件日志才是事实源)
  static TRACE_RETAIN_DAYS = 90;          // logs/traces/*.jsonl 保留期 (此前零保留, 只增)

  // ==== 每轮"做过什么"的可重建上下文档 (2026-10-06 交接项) ====
  // 病根: recordTurn(user, assistant) 是个两参数签名 —— 长期记忆层只记得 agent **说过什么**,
  //   不记得它**做过什么** (跑了哪些工具、结果如何), 也不记得轮内的中间草稿 (包括被后置校验
  //   丢弃的那条错答)。Manus 公开过的 harness 教训恰恰是"错的那一轮要留在现场": 抹掉它就抹掉了
  //   "别再这么干"的唯一证据。此前这类信息在记忆层是**从未落盘** (= 每次都被抹掉)。
  // 分工 (有意为之, 与 fact-store 的写入来源分级互不重叠):
  //   · 蒸馏 (extractor / addMemory) 始终只看 user + 最终回复 —— 证据与草稿**绝不进**事实库,
  //     否则一条 tool/result 里的云端网页原文会被当成"用户记忆"回灌进后续 system prompt。
  //   · 本档只存"可重建上下文" (哪一轮 / 哪个会话 / 调了哪些工具 / 折叠后的回执 / 轮内草稿),
  //     永不参与 longterm.md 与 context() 的派生 (那两条链只认 session 的 user/assistant 事件)。
  //   · 体积: 沿用 agent/context.js 的折叠口径 (头 70% + 尾 30% + 可见占位), 单行硬封顶。
  static TURN_ARCHIVE_RETAIN_DAYS = 30;   // memory/turns/*.jsonl 保留期 (session 日志才是事实源)
  static TURN_ARCHIVE_ITEMS = 12;         // 每类条目最多存条数 (超出的只数不数内容)
  static TURN_ARCHIVE_ITEM_CHARS = 600;   // 单条折叠上限 (入参/回执/草稿同口径)
  static TURN_ARCHIVE_LINE_BYTES = 8192;  // 单轮 JSON 行硬上限 (装不下就从最旧条目裁, 记 dropped)

  constructor(dataDir, factStore, summarizer = null, sessionStore = null) {
    this.summarizer = summarizer;
    this.extractor = null; // P1#9: LLM 结构化提炼器 (agent 注入), 提取关键事实/偏好/待办
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, "memory");
    ensureDir(this.dir);
    ensureDir(path.join(this.dir, "daily"));
    this.factStore = factStore;
    this.sessionStore = sessionStore;   // 唯一事实源 (今日视图由它派生)
    this.todayView = path.join(this.dir, "today.md"); // 兼容路径 (不再作为写入真相)
    this.longtermMd = path.join(this.dir, "longterm.md");
    this.stateFile = path.join(this.dir, "daily-state.json");
    this.state = { day: null, turnCount: 0 };
    this._lastCompactAt = 0; // 压缩节流时间戳 (v1.0.7)
    this._loadState();
    this._rollDay();
  }

  _loadState() {
    this.state = readJson(this.stateFile, { day: null, turnCount: 0 });
  }

  _saveState() {
    // 游标与归档必须同锁序: 状态文件写坏 (半截 JSON) 会让下次 _loadState 回落默认值,
    // 游标归零 → 整日原文再追加一遍, 所以这里也走文件锁 (writeJson 本身是原子写, 锁防读-改-写竞态)
    withFileLock(this.stateFile, () => writeJson(this.stateFile, this.state));
  }

  _rollDay() {
    const today = logicalDay();
    if (this.state.day !== today) {
      if (this.state.day) this._compileDaily();
      this.state.day = today;
      this._saveState();
    }
    // F9b: 长期记忆保留期清理。挂在**已有的按天边界**上 (recordTurn 每轮调本方法, 游标
    //   lastRetentionDay 保证一天最多真跑一次), 不新增定时器 —— FactStore 侧的时效治理走
    //   eviction-daily 每日扫描, 本层的时间边界本来就是"日", 复用同一条治理思路。
    //   longterm.md / daily/*.md / logs/traces/*.jsonl 此前零保留 (只增不减)。
    //   写成下面的局部闭包而不是新类方法: 本文件的模块级/类方法符号集要与技能内联副本
    //   (skills/ppx-memory/scripts/memory-ticker.js) 同源, 新增符号得等副本跟进。
    if (this.state.lastRetentionDay === today) return;
    const DAY_MS = 86400000;
    // 天龄 (按文件名/段头里的日期, 不看 mtime —— 复制/备份文件不应被"刚写过"骗过)
    const dayAge = (d) => {
      const t = Date.parse(`${d}T00:00:00`);
      return Number.isFinite(t) ? Math.floor((Date.now() - t) / DAY_MS) : -1;
    };
    // 1) longterm.md: 先按天龄裁段, 再按体积上限从最旧段续裁 (但绝不动最近 N 段与今天的段)
    const trimLongterm = () => {
      const retainDays = MemoryTicker.LONGTERM_RETAIN_DAYS;
      const capBytes = MemoryTicker.LONGTERM_MAX_BYTES;
      if (retainDays <= 0 && capBytes <= 0) return 0;
      let size = 0;
      try { size = fs.statSync(this.longtermMd).size; } catch { return 0; }
      if (!size) return 0;
      return withFileLock(this.longtermMd, () => {   // 与 _appendLongterm 同一把锁, 临界区全同步
        const raw = readText(this.longtermMd);
        const lines = String(raw || "").split("\n");
        const preamble = [];   // 第一个段头之前的内容 (无日期归属, 永久保留)
        const sections = [];   // { day, lines[] }
        let cur = null;
        for (const l of lines) {
          const m = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(l);
          if (m) { cur = { day: m[1], lines: [l] }; sections.push(cur); continue; }
          if (cur) cur.lines.push(l);
          else preamble.push(l);
        }
        // 带日期的段才参与裁剪; 无日期的段头 (手工插的) 与前言一样不动
        const dated = sections.filter((s) => s.day && s.day !== today);
        const dropped = new Set();
        if (retainDays > 0) for (const s of dated) if (dayAge(s.day) >= retainDays) dropped.add(s);
        if (capBytes > 0) {
          const keptBytes = () => preamble.join("\n").length
            + sections.filter((s) => !dropped.has(s)).reduce((n, s) => n + s.lines.join("\n").length + 3, 0);
          for (const s of dated) {
            if (keptBytes() <= capBytes) break;
            if (dated.filter((x) => !dropped.has(x)).length <= MemoryTicker.LONGTERM_KEEP_SECTIONS) break;
            dropped.add(s);
          }
        }
        if (!dropped.size) return 0;
        const out = [...preamble, ...sections.filter((s) => !dropped.has(s)).flatMap((s) => s.lines)].join("\n");
        writeText(this.longtermMd, out.endsWith("\n") ? out : out + "\n");
        return dropped.size;
      });
    };
    // 2/3) 按文件名日期清理过期归档文件 (daily/*.md 与 logs/traces/*.jsonl 共用一套判据)
    const sweepFiles = (dir, re, retainDays, keepToday) => {
      if (retainDays <= 0) return 0;
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return 0; }
      let n = 0;
      for (const name of names) {
        const m = re.exec(name);
        if (!m) continue;                       // 非按日命名的文件 (备份/临时) 一律不碰
        if (keepToday && m[1] === today) continue;
        if (dayAge(m[1]) < retainDays) continue;
        try { fs.rmSync(path.join(dir, name), { force: true }); n++; }
        catch (e) { warn(`[memory/memory-ticker] 保留期清理跳过 ${name}: ${e && e.message ? e.message : e}`); }
      }
      return n;
    };
    let trimmed = 0, dailyRemoved = 0, traceRemoved = 0, turnsRemoved = 0;
    try { trimmed = trimLongterm(); }
    catch (e) { warn(`[memory/memory-ticker] longterm 保留期清理失败: ${e && e.message ? e.message : e}`); }
    try { dailyRemoved = sweepFiles(path.join(this.dir, "daily"), /^(\d{4}-\d{2}-\d{2})\.md$/, MemoryTicker.DAILY_RETAIN_DAYS, true); }
    catch (e) { warn(`[memory/memory-ticker] daily 保留期清理失败: ${e && e.message ? e.message : e}`); }
    try { traceRemoved = sweepFiles(path.join(this.dataDir, "logs", "traces"), /^(?:events-)?(\d{4}-\d{2}-\d{2})\.jsonl$/, MemoryTicker.TRACE_RETAIN_DAYS, false); }
    catch (e) { warn(`[memory/memory-ticker] traces 保留期清理失败: ${e && e.message ? e.message : e}`); }
    // 每轮可重建上下文档 (memory/turns): 只存"做过什么", 保留期比 daily 短得多 (它是派生档, 不是事实源)
    try { turnsRemoved = sweepFiles(path.join(this.dir, "turns"), /^(\d{4}-\d{2}-\d{2})\.jsonl$/, MemoryTicker.TURN_ARCHIVE_RETAIN_DAYS, true); }
    catch (e) { warn(`[memory/memory-ticker] turns 保留期清理失败: ${e && e.message ? e.message : e}`); }
    this.state.lastRetentionDay = today;
    this.state.retention = {
      at: new Date().toISOString(),
      longterm_retain_days: MemoryTicker.LONGTERM_RETAIN_DAYS,
      daily_retain_days: MemoryTicker.DAILY_RETAIN_DAYS,
      trace_retain_days: MemoryTicker.TRACE_RETAIN_DAYS,
      turns_retain_days: MemoryTicker.TURN_ARCHIVE_RETAIN_DAYS,
      longterm_sections_dropped: trimmed,
      daily_files_removed: dailyRemoved,
      trace_files_removed: traceRemoved,
      turns_files_removed: turnsRemoved,
    };
    this._saveState();
    if (trimmed || dailyRemoved || traceRemoved || turnsRemoved) {
      info(`[memory/memory-ticker] 保留期清理: longterm 段 ${trimmed}, daily 文件 ${dailyRemoved}, traces 文件 ${traceRemoved}, turns 文件 ${turnsRemoved} (天龄上限 ${MemoryTicker.LONGTERM_RETAIN_DAYS}/${MemoryTicker.DAILY_RETAIN_DAYS}/${MemoryTicker.TRACE_RETAIN_DAYS}/${MemoryTicker.TURN_ARCHIVE_RETAIN_DAYS} 天)`);
    }
  }

  // 跨天: 把上一日事件归档到 daily/ 并滚入 longterm (从 session 派生, 非 today.md)
  // longterm 段只追加"滚动游标之后"的事件 —— 已经由 _compileDaily_Rolling 写过的不再写第二遍
  _compileDaily() {
    const day = this.state.day;
    const evs = _dayEvents(this.sessionStore, day);
    const lines = evs.map(_lineOfEvent);
    writeText(path.join(this.dir, "daily", `${day}.md`), `# ${day}

${_scrub(lines.join("\n"))}\n`);
    if (!lines.length) return;
    const afterSeq = this.state.lastRolledDay === day ? (this.state.lastRolledSeq || 0) : 0;
    const pending = evs.filter((e) => e.seq > afterSeq);
    if (pending.length) {
      // v3.2.3 (P2#10): 追加写替代全量重写 (readText 拼接 writeText 在 longterm 增长后
      // 每次归档都 O(N) 全文件读写); 语义等价 —— 内容与格式逐字节一致, 仅写方式不同
      this._appendLongterm(pending.length === evs.length
        ? `\n## ${day}\n${_scrub(lines.join("\n"))}\n`
        : `\n## ${day} (补齐)\n${_scrub(pending.map(_lineOfEvent).join("\n"))}\n`);
    }
    this.state.lastRolledDay = day;
    this.state.lastRolledSeq = evs[evs.length - 1].seq;
    this._saveState();
  }

  // longterm.md 的唯一追加入口 (2026-10-04): 加跨进程文件锁 —— 军团多进程共用 dataDir 时
  // 裸 appendFileSync 在 Windows 上可能交错写坏行; 游标推进必须紧随成功追加, 防重复写。
  _appendLongterm(chunk) {
    withFileLock(this.longtermMd, () => appendText(this.longtermMd, chunk));
  }

  // 长期记忆层的"每轮落库"入口。
  // v1 (2026-10-06 交接): 第三参数是**可选对象** —— 旧的两参数调用方 (scripts/skills/测试)
  //   一个字节的行为都不变 (opts 缺省 = 无证据无草稿 = 不写 turns 档)。
  //   opts.evidence: 本轮工具调用/回执 (接受 agent/context.js 的折叠后事件形状 {type,data}
  //                  与扁平槽位 {tool,args,ok,result|digest}, 两种都能吃 —— 折叠由写入方做过,
  //                  本层只再兜一次底, 不另起一套截断)。
  //   opts.drafts:   轮内 assistant 中间草稿 (含被后置校验丢弃的错答), 字符串或 {content, tools}。
  //   两者都只作为**可重建上下文**落 memory/turns/ 的追加档, 绝不进蒸馏 (下面那两段一个字没改)。
  async recordTurn(user, assistant, opts = {}) {
    this._rollDay();
    this.state.turnCount += 1;
    this._saveState();
    // 来源分级 (v2026-10-XX, 交接项「turnArchive 没有读者, 接线来源分级时请就地标注」的落地):
    //   本轮 tier = 声明级 与 证据级 的**最弱**者 —— 抓过外部内容的轮次里, 蒸馏出的任何事实都只能是
    //   tool-fetched (隔离带), 无论调用方怎么声明。判定只看证据里的工具名 (调用点事实), 不看文本。
    const turnTier = tierOfTurn({
      provenance: opts && opts.provenance,
      source: "extract",           // 本层的默认声明: LLM 蒸馏 = 模型推断
      evidence: opts && opts.evidence,
    });
    // 本轮"做过什么"落到记忆层自己的可重建上下文档 (append-only, 失败绝不影响蒸馏主链)
    this._archiveTurnContext({
      evidence: opts && opts.evidence,
      drafts: opts && opts.drafts,
      sessionKey: opts && opts.sessionKey,
      assistant,
      turn: this.state.turnCount,
      provenance: turnTier,
    });
    // 对话原文已由 session 事件日志保存; 今日视图由 session 派生
    if (this.state.turnCount % TURNS_PER_SUMMARY === 0) this._compileDaily_Rolling();
    await this._compactIfNeeded();
    // P1#9: 若配 LLM 提炼器且本次对话含高信号, 走结构化提炼; 否则退回启发式
    if (this.extractor && _hasSignal(user, assistant)) {
      try {
        // 感知式提炼: 先检索与本次对话相关的已有记忆 (同主题 top 3), 喂给提炼器从源头去重
        const related = String(user || "").trim()
          ? this.factStore.query(user, { limit: 3 }).filter((f) => !(f.hits && f.hits > 5)) // 高命中已稳定, 不再重复提炼
          : [];
        // 蒸馏输入 = user + 最终回复 (逐字保持): 证据/草稿在这里没有入口 —— 这是
        // "工具抓到的网页原文不会变成用户记忆"的第一道结构性保证 (第二道在写入侧来源分级)
        const facts = await this.extractor(String(user || ""), String(assistant || ""), related);
        if (facts && facts.length) {
          // similarThreshold=0.6: LLM 提炼的字面变体 (同义不同词) 与已有事实语义相似时命中加分,
          // 防「三件套」这类反复提炼的变体污染记忆库
          // provenance=本轮 tier (v2026-10-XX): 蒸馏输入虽然只有 user + 最终回复, 但"最终回复"可能
          //   复述了本轮抓来的内容 —— 所以只要本轮跑过外部工具, 蒸馏结论就一律降为隔离带。
          //   用户原话仍由下面的 addMemory 以 user-stated 入库, 两条通道互不削弱。
          for (const f of facts) this.factStore.add(f, { source: "extract", provenance: turnTier, similarThreshold: 0.6 });
          return;
        }
      } catch (e) { debug(`[memory/memory-ticker] 已忽略异常: ${e && e.message ? e.message : e}`); }
    }
    if (user) this.factStore.addMemory(user);
  }

  // 本轮证据 + 轮内草稿 -> memory/turns/YYYY-MM-DD.jsonl 的一行 (追加写, 跨进程文件锁, 临界区全同步)
  // 与 longterm 的分工: longterm.md 是"读得下去"的散文归档 (只认 user/assistant);
  //   turns 是"重建得出来"的结构化档 (按轮存 工具/回执/草稿), 永不进 context(), 也不进蒸馏输入。
  // 幂等/追加: 本方法只 append, 绝不 read-modify-write 已写过的行 (读-改-写曾在锁外造成真实数据丢失)。
  _archiveTurnContext({ evidence = null, drafts = null, sessionKey = null, assistant = "", turn = 0, provenance = null } = {}) {
    // 折叠口径与 src/agent/context.js 的 foldText 同形 (头 70% + 尾 30% + 可见占位)。
    //   写成局部闭包而不是新顶层符号: 本文件的模块级/类方法符号集需与技能内联副本同源,
    //   而 context.js 从未导出 foldText (memory/** 也不该反向依赖 agent/**)。
    const CAP = MemoryTicker.TURN_ARCHIVE_ITEM_CHARS;
    const fold = (s, cap = CAP) => {
      const str = String(s == null ? "" : s).replace(/\r/g, "");
      if (str.length <= cap) return str;
      const head = Math.max(0, Math.floor(cap * 0.7));
      const tail = Math.max(0, cap - head);
      return str.slice(0, head) + `…[已折叠, 原 ${str.length} 字符]…` + (tail ? str.slice(-tail) : "");
    };
    // 凭证类路径的内容一律不落记忆文件 (约束: 记忆档里不得出现 .env/config 原文)。
    //   命中时只丢正文, 不丢"这个工具跑过"这一事实 —— 诚实记录做过什么, 但不存它读到了什么。
    const CRED = /(^|[^\w.-])\.env[\w.-]*|secrets?[\\/.]|credential|\.git-credentials|id_(?:rsa|ed25519)|private[-_]?key|token[\\/._-]?store/i;
    const capOf = (d) => String(d.args ?? d.input ?? d.path ?? d.command ?? "");
    const evs = Array.isArray(evidence) ? evidence : [];
    const dfs = Array.isArray(drafts) ? drafts : [];
    if (!evs.length && !dfs.length) return null;   // 普通闲聊轮: 一行都不写 (零增长)
    const credTurn = evs.some((e) => {
      const d = (e && typeof e === "object" && e.data && typeof e.data === "object") ? e.data : e;
      return CRED.test(capOf(d));
    });
    const items = [];
    for (const e of evs) {
      if (!e || typeof e !== "object") continue;
      const d = (e.data && typeof e.data === "object") ? e.data : e;
      const type = e.type || (("ok" in d || "digest" in d || "result" in d || "error" in d) ? "tool/result" : "tool/call");
      const tool = String(d.tool || d.name || "tool").slice(0, 40);
      const callId = d.callId == null ? null : String(d.callId).slice(0, 40);
      if (type === "tool/call") {
        const args = fold(d.args ?? d.input ?? "");
        items.push({ k: "call", tool, callId, args, cred: CRED.test(args) ? true : undefined });
        continue;
      }
      const body = d.digest ?? d.content ?? d.result ?? d.error ?? "";
      items.push({
        k: "result", tool, callId,
        ok: d.ok !== false,
        ms: Number(d.durationMs) || 0,
        out: credTurn || CRED.test(String(body)) ? "" : fold(body),
        omitted: credTurn ? "凭证类入参, 正文未存" : (CRED.test(String(body)) ? "正文含凭证特征, 未存" : undefined),
      });
    }
    for (const raw of dfs) {
      if (raw == null) continue;
      const isObj = raw && typeof raw === "object";
      const text = fold(isObj ? (raw.content ?? raw.text ?? "") : raw);
      // 工具名只留名字 (约束: 绝不落工具入参值), 中间草稿的"做了什么"靠它自证
      const names = isObj && Array.isArray(raw.tools) ? raw.tools.map((t) => String(t).slice(0, 40)).filter(Boolean)
        : (isObj && Array.isArray(raw.tool_calls) ? raw.tool_calls.map((c) => String(c?.function?.name || c?.name || "").slice(0, 40)) : []);
      if (!text && !names.length) continue;
      items.push({ k: "draft", text, tools: names.length ? names.slice(0, MemoryTicker.TURN_ARCHIVE_ITEMS) : undefined });
    }
    if (!items.length) return null;
    // 条数闸门: 每类各保最近 N 条 (超出的只数不数内容), 与下面的字节闸门互补
    const MAX = Math.max(1, MemoryTicker.TURN_ARCHIVE_ITEMS);
    const evOnly = items.filter((x) => x.k !== "draft");
    const draftOnly = items.filter((x) => x.k === "draft");
    let dropped = Math.max(0, evOnly.length - MAX) + Math.max(0, draftOnly.length - MAX);
    let body = [...evOnly.slice(-MAX), ...draftOnly.slice(-MAX)]
      // 与最终回复逐字相同的草稿不重复存 (收尾那条已由 session 事件日志承载)
      .filter((x) => !(x.k === "draft" && x.text && x.text === String(assistant || "").replace(/\r/g, "").trim()));
    const rec = {
      // v:2 —— 新增 prov/untrusted 两个来源分级字段 (v:1 = 无分级标注的存量行, 读取侧按工具名重算)
      v: 2, ts: Date.now(), day: logicalDay(),
      sessionKey: String(sessionKey == null ? "" : sessionKey).slice(0, 80),
      turn,
      counts: { evidence: evOnly.length, drafts: draftOnly.length },
      // 来源标注 (交接项落地: "turnArchive 没有读者, 接线来源分级的人必须就地标源"):
      //   这一行里存的是**抓来的正文**, 所以它自己就是不可信输入。写清 tier + 污点工具名, 未来的
      //   读者 (经验蒸馏/审计/回放) 一眼能判定"要不要包 wrapUntrusted", 不必回头猜工具白名单。
      prov: String(provenance || TIER_MODEL),
      untrusted: untrustedToolsIn(evidence).slice(0, 8),
    };
    // 一行 JSON 的唯一组装口: dropped 只在 >0 时出现, 空位不留 null 噪音
    const lineOf = (arr, drop) => JSON.stringify(drop > 0 ? { ...rec, dropped: drop, items: arr } : { ...rec, items: arr });
    let line = lineOf(body, dropped);
    // 单行硬封顶: 从最旧条目开始丢 (保最近 = 保可重建性), 丢多少记多少, 绝不静默
    while (Buffer.byteLength(line, "utf8") > MemoryTicker.TURN_ARCHIVE_LINE_BYTES && body.length > 1) {
      body = body.slice(1);
      dropped++;
      line = lineOf(body, dropped);
    }
    const file = path.join(this.dir, "turns", `${rec.day}.jsonl`);
    try {
      // 目录必须先存在: 锁文件与数据文件同目录, 而 withFileLock 的 wx 创建在缺目录时必失败
      // (appendText 内部的 ensureDir 发生在锁内, 抢不到锁就永远走不到那里)
      ensureDir(path.dirname(file));
      withFileLock(file, () => appendText(file, _scrub(line) + "\n")); // 临界区必须同步 (store.js 会拒绝异步回调)
    } catch (e) {
      debug(`[memory/memory-ticker] 轮次上下文落盘失败 (不影响蒸馏): ${e && e.message ? e.message : e}`);
      return null;
    }
    return { file, bytes: Buffer.byteLength(line, "utf8"), items: body.length, dropped };
  }

  // 读回某天的轮次上下文 (可重建 "那一轮到底做了什么"): 尾窗读 + 逐行解析, 坏行跳过不抛。
  // 只读派生档: 本方法的结果**从不**注入 prompt (context() 不看它), 供检索/审计/测试与后续
  // 经验蒸馏用 —— 谁把它喂进 system prompt 谁就得自己负责来源分级, 这里先把边界写清楚。
  //
  // 来源分级 (v2026-10-XX, 交接项 "turnArchive 没有读者, 接线来源分级时请就地标注 source" 的落地):
  //   返回的每一行都带 prov / untrusted / quarantined 三个判定字段, 读取方**不需要**再去猜工具白名单:
  //     · v≥2 的行按写入时记下的 prov;
  //     · v:1 的存量行按 items 里的工具名确定性重算 (只看工具名 = 调用点事实, 不看正文, provDerived=true 可见)。
  //   quarantined=true 的行里存的是外部抓取正文: 任何把它写进 system prompt 的调用方必须再过一层
  //   src/security/injection.js 的 wrapUntrusted —— 本层保证"必须包裹"这件事是可判定的, 而不是靠约定。
  _labelArchiveRow(r) {
    const items = Array.isArray(r.items) ? r.items : [];
    const declared = r.prov ? normalizeTier(r.prov) : null;
    const prov = declared || (tierFromEvidence(items) || TIER_MODEL);
    r.prov = prov;
    r.quarantined = isQuarantined(prov);
    if (!Array.isArray(r.untrusted)) r.untrusted = untrustedToolsIn(items).slice(0, 8);
    if (!declared) r.provDerived = true; // 存量行的 tier 是算出来的, 不是写下来的 (诚实标注来源链)
    return r;
  }

  turnArchive({ day = null, sessionKey = null, limit = 20, tailBytes = 65536 } = {}) {
    const d = day ? String(day).slice(0, 10) : logicalDay();
    const file = path.join(this.dir, "turns", `${d}.jsonl`);
    const TAIL = Math.max(1024, Number(tailBytes) || 65536);
    const out = [];
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return out; }
    let fd;
    try {
      const len = Math.min(size, TAIL);
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, size - len);
      const text = buf.slice(0, got).toString("utf8");
      const lines = text.split("\n");
      if (size > TAIL) lines.shift();   // 窗口起点落在某行中间: 半截行不可解析, 丢掉
      for (const l of lines) {
        const s = l.trim();
        if (!s) continue;
        try {
          const r = JSON.parse(s);
          if (!r || typeof r !== "object") continue;
          if (sessionKey != null && String(r.sessionKey || "") !== String(sessionKey)) continue;
          out.push(this._labelArchiveRow(r));
        } catch { /* 交错/半截行: 跳过, 绝不让一次读取抛错 */ }
      }
    } catch (e) {
      debug(`[memory/memory-ticker] turns 读取失败: ${e && e.message ? e.message : e}`);
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { debug(`[memory/memory-ticker] 句柄关闭失败: ${e && e.message ? e.message : e}`); } }
    }
    const n = Math.max(1, Number(limit) || 20);
    return out.slice(-n);
  }


  // P1#9: 注入 LLM 结构化提炼器 (agent 调 setExtractor)
  setExtractor(fn) { this.extractor = typeof fn === "function" ? fn : null; }

  // 每 N 轮: 把今日新增事件滚动归档进 longterm (从 session 派生)
  // v1.2.0 fix: 用游标(lastRolledDay/lastRolledSeq)只追加"本次滚动之后"的新事件,
  // 不再每次把今日全文重复追加 —— 否则同一段对话会在 longterm 中反复出现, 加剧重复回话。
  _compileDaily_Rolling() {
    const today = logicalDay();
    const st = this.state;
    if (st.lastRolledDay !== today) { st.lastRolledDay = today; st.lastRolledSeq = 0; } // 跨天重置游标
    const afterSeq = st.lastRolledSeq || 0;
    const rows = [];
    let maxSeq = afterSeq;
    for (const e of _dayEvents(this.sessionStore, today)) {
      if (e.seq <= afterSeq) continue;
      rows.push(_lineOfEvent(e));
      if (e.seq > maxSeq) maxSeq = e.seq;
    }
    if (rows.length) this._appendLongterm(`\n## ${today} (滚动)\n${_scrub(rows.join("\n"))}\n`);
    st.lastRolledSeq = maxSeq;
    this._saveState();
  }

  // 滚动压缩: 今日事件超量时, 把最旧对话聚合压缩进 longterm, 只留近期
  // v1.0.7 节流: 压缩后 COMPACT_MIN_INTERVAL_MS 内不重复, 防每轮对话都付 LLM 压缩成本
  async _compactIfNeeded() {
    const now = Date.now();
    if (now - (this._lastCompactAt || 0) < COMPACT_MIN_INTERVAL_MS) return;
    const today = logicalDay();
    const evs = _dayEvents(this.sessionStore, today);
    if (evs.length < COMPACT_THRESHOLD) return;
    const compacted = evs.slice(0, -COMPACT_KEEP); // 最旧区间: 聚合压缩进 longterm, 近期保留
    if (!compacted.length) return;
    const compactedLines = compacted.map(_lineOfEvent);
    const userMsgs = compactedLines
      .filter((li) => li.indexOf("用户:") !== -1)
      .map((li) => li.split("用户:")[1].trim())
      .filter(Boolean);
    let summary;
    if (this.summarizer && compactedLines.length) {
      try {
        const raw = compactedLines.slice(0, 60).join("\n");
        const s = await this.summarizer(raw);
        summary = "[" + today + " llm-summary] " + (s || "(空)");
      } catch {
        summary = "[" + today + " thin] archived " + compactedLines.length + " lines (llm fail)";
      }
    } else if (userMsgs.length) {
      summary = "[" + today + " thin] " + userMsgs.length + " rounds archived: " + userMsgs.slice(0, 12).join(" | ") + (userMsgs.length > 12 ? " | ..." : "");
    } else {
      summary = "[" + today + " thin] archived " + compactedLines.length + " lines";
    }
    // v3.2.3 (P2#10): 追加写替代全量重写, 语义等价 (见 _compileDaily 注释)
    this._appendLongterm("\n## " + today + " (rollup)\n" + _scrub(summary) + "\n");
    // 游标对齐 (2026-10-04): 这段对话已由 rollup 承载, 滚动/日终归档不得再追加原文,
    //   否则同一天既有摘要又有逐行原文 (双写)。取 max: 滚动已写得更远时不回退游标。
    if (this.state.lastRolledDay !== today) { this.state.lastRolledDay = today; this.state.lastRolledSeq = 0; }
    this.state.lastRolledSeq = Math.max(this.state.lastRolledSeq || 0, compacted[compacted.length - 1].seq);
    this._saveState();
    this._lastCompactAt = now; // 节流: 压缩完成后记录, 60s 内不再压缩
  }

  context(userMsg) {
    const todayCount = this.sessionStore ? _renderLines(this.sessionStore, logicalDay()).length : 0;
    // F9a (2026-10-04): 尾窗读 longterm.md, 不再全量读盘。本方法在每次 LLM 请求前的**同步**
    //   热路径上 (HTTP + SSE 一起被卡), 旧实现 readText 读整只文件 (实测 1.9MB 读 1,128,890
    //   字符) 却只用最后 3000 字符。窗口从 LONGTERM_TAIL_WINDOW_BYTES 起, 不够用按 4x 扩张,
    //   最坏退化为整文件 (语义与旧实现逐字一致, 见 _longtermExcludingToday)。
    //   同样写成局部闭包: 本文件符号集需与技能内联副本同源, 不新增顶层函数/类方法。
    const alignToSection = (text, isPartialWindow) => {
      if (!isPartialWindow) return text;
      // 窗口起点落在某段中间 (甚至截断多字节字符) 时, 该段归属哪天无法判定 (段头在窗口外),
      // 必须丢到第一个段头为止 —— 否则可能把"今天"的原文当历史注入, 正是 G7 修掉的重复回话诱因
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) return lines.slice(i).join("\n");
      }
      return "";
    };
    const readTail = (size, len) => {
      let fd;
      try {
        fd = fs.openSync(this.longtermMd, "r");
        const buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, size - len);
        return buf.slice(0, got).toString("utf8");
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { debug(`[memory/memory-ticker] 尾窗读关闭句柄失败: ${e && e.message ? e.message : e}`); } }
      }
    };
    const need = MemoryTicker.LONGTERM_CONTEXT_CHARS;
    const today = logicalDay();
    let fileSize = 0;
    try { fileSize = fs.statSync(this.longtermMd).size; } catch { fileSize = 0; }
    let windowBytes = 0;
    let longterm = "";
    if (fileSize > 0) {
      let win = Math.min(fileSize, MemoryTicker.LONGTERM_TAIL_WINDOW_BYTES);
      for (;;) {
        const raw = readTail(fileSize, win);
        longterm = _longtermExcludingToday(alignToSection(raw, win < fileSize), today).slice(-need);
        windowBytes = win;
        if (longterm.length >= need || win >= fileSize) break;
        win = Math.min(fileSize, win * MemoryTicker.LONGTERM_TAIL_GROWTH);
      }
    }
    this._lastContextTailBytes = windowBytes; // 可观测: 本轮热路径实际读了多少字节 (见 stats())
    const topFacts = this.factsTop(userMsg);
    // v1.2.0 fix: 今日对话原文由会话历史(history)承载, 不再逐行重复注入到 system,
    // 避免模型在 system 的"今日记忆"里看到与 history 相同的对话而重复回话。
    const todayNote = todayCount
      ? `今日已进行 ${todayCount} 轮对话（完整内容已随会话历史提供）。`
      : "今日暂无对话。";
    return `
# 今日对话
${todayNote}

# 长期记忆 (最近)
${longterm || "(暂无)"}

# 关键事实
${topFacts || "(暂无)"}
`;
  }

  // 关键事实: 按当前问题语义检索优先, 不足 8 条用衰减分补齐 (去重)。
  // 让每轮自动注入的记忆与当前问题相关, 而非纯衰减取 top (v0.8.1 语义注入)
  // 来源分级 (v2026-10-XX, 本文件唯一的 prompt 影响力闸门):
  //   ① 隔离带 (tool-fetched / unknown) 一律**不出**这里 —— "关键事实"是每轮都进 system prompt 的
  //      注入位, 抓来的东西一旦进来就有了持久影响力。它仍然可存可检索 (memory_search 看得到, 带标签),
  //      只是不再被 harness 自动复述。
  //   ② 渲染走 provenance.factLine: user-stated 逐字节保持既有形状 (`- [score] content`),
  //      model-inferred 追加 `(来源:模型推断)` —— 静态前缀与既有断言都不受影响 (cache-audit 守)。
  //   ③ 标签文本来自 provenance.js 闭集常量, content 里的伪装标签在写入侧已被剥掉,
  //      所以标签本身不构成新的注入向量。
  factsTop(userMsg) {
    try {
      const q = String(userMsg || "").trim();
      const semantic = q ? this.factStore.query(q, { limit: 8 }) : [];
      const decay = this.factStore.query("", { limit: 8 });
      const seen = new Set();
      const merged = [];
      for (const f of [...semantic, ...decay]) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        if (isQuarantined(tierOfRecord(f))) continue; // 隔离带: 可检索, 不可被自动复述
        merged.push(f);
        if (merged.length >= 8) break;
      }
      return merged.map((f) => factLine(f)).join("\n");
    } catch { return ""; }
  }

  // 可观测: longterm 大小 + 今日事件数, 供 agent.stats() 聚合
  stats() {
    let longtermBytes = 0;
    try { longtermBytes = fs.statSync(this.longtermMd).size; } catch (e) { debug(`[memory/memory-ticker] 已忽略异常: ${e && e.message ? e.message : e}`); }
    // 轮次上下文档 (memory/turns) 当天体积: 它是唯一会因"本轮做过什么"而增长的记忆层文件,
    // 把它的字节数报出来 = 让"证据撑爆存储"这种退化在第一时间可见 (闸门是单行 8KB + 每类 12 条)
    let turnsBytes = 0;
    try { turnsBytes = fs.statSync(path.join(this.dir, "turns", `${logicalDay()}.jsonl`)).size; }
    catch (e) { debug(`[memory/memory-ticker] 已忽略异常: ${e && e.message ? e.message : e}`); }
    return {
      longterm_bytes: longtermBytes,
      turns_bytes_today: turnsBytes,
      turns_retain_days: MemoryTicker.TURN_ARCHIVE_RETAIN_DAYS,
      events_today: _renderLines(this.sessionStore, logicalDay()).length,
      // F9: 尾窗可观测 —— 每轮 context() 实际读了多少字节 (应为窗口量级, 而不是 longterm_bytes)
      longterm_tail_bytes: MemoryTicker.LONGTERM_TAIL_WINDOW_BYTES,
      longterm_context_read_bytes: this._lastContextTailBytes || 0,
      // 上一次保留期清理的游标与结果 (每日边界, 见 _rollDay)
      retention_day: this.state.lastRetentionDay || null,
      retention: this.state.retention || null,
    };
  }
}

// 读取长期记忆, 并剔除"今天"的段落 —— 当日对话已由会话历史(history)承载,
// 若 longterm 里今天滚动块也注入, 会与 history 重复, 是"重复回话"的诱因。
function _longtermExcludingToday(text, today) {
  const out = [];
  let inToday = false;
  for (const l of String(text || "").split("\n")) {
    const m = l.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
    if (m) { inToday = (m[1] === today); continue; }
    if (!inToday) out.push(l);
  }
  return out.join("\n").trim();
}

// P0 (2026-10-04): 落盘前脱密。longterm.md / daily/*.md 是原文归档, 会长期驻留、
//   逐日增长并回灌进每轮 context (还会发给云端 provider) —— 凭证/密钥绝不能进。
//   保留 email/phone: 用户主动要求记住的联系方式是记忆的正常用途; 其余 PII 一律 REDACTED。
function _scrub(text) {
  return scrubPII(String(text ?? ""), { keep: ["email", "phone"] }).cleaned;
}

// P1#9: 记忆信号预筛 - 命中关键词或长度信号才触发 LLM 提炼 (省成本)
function _hasSignal(user, assistant) {
  const u = String(user || "");
  const a = String(assistant || "");
  const text = (u + " " + a).slice(0, 500);
  if (text.length < 8) return false;
  const SIGNAL = /(我是|我喜欢|我讨厌|我记得|请记住|记住|偏好|习惯|目标是|我需要|我要|想买|喜欢|不喜欢|重要|关键|待办|计划|打算|希望|擅长|不擅长|生日|地址|电话|邮箱|账号|密码|股票|基金|仓位|止损|止盈|策略|工作|项目|公司|同事|老板|朋友|家人|对象|结婚|买房|买车|考试|学习)/;
  const isGreeting = /^(你好|在吗|谢谢|好的|嗯|ok|hi|hello|再见|拜拜|哈喽)[!。？?]*$/i.test(u.trim());
  // 收紧: 无信号关键词时, 仅对真正信息密集的长对话触发 LLM 提炼, 避免普通闲聊累积成本 [复审 P1#9]
  return !isGreeting && (SIGNAL.test(text) || text.length > 200);
}

