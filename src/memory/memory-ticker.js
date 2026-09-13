// src/memory/memory-ticker.js - 记忆水位线 (参考 openhanako v4)
// 架构: 会话事件日志 (SessionStore) 为唯一事实源; 今日视图由它派生
// 不再独立维护 today.md 对话原文 (原 l0/session/today 三处重复, 已收敛到 session)
// 今日视图 -> 滚动压缩 -> longterm.md (长期记忆)
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readText, writeText, logicalDay } from "../utils/store.js";

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

export class MemoryTicker {
  constructor(dataDir, factStore, summarizer = null, sessionStore = null) {
    this.summarizer = summarizer;
    this.extractor = null; // P1#9: LLM 结构化提炼器 (agent 注入), 提取关键事实/偏好/待办
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
    try {
      if (fs.existsSync(this.stateFile)) this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch { this.state = { day: null, turnCount: 0 }; }
  }

  _saveState() {
    writeText(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  _rollDay() {
    const today = logicalDay();
    if (this.state.day !== today) {
      if (this.state.day) this._compileDaily();
      this.state.day = today;
      this._saveState();
    }
  }

  // 跨天: 把上一日事件归档到 daily/ 并滚入 longterm (从 session 派生, 非 today.md)
  _compileDaily() {
    const day = this.state.day;
    const lines = _renderLines(this.sessionStore, day);
    const dailyFile = path.join(this.dir, "daily", `${day}.md`);
    writeText(dailyFile, `# ${day}

${lines.join("\n")}\n`);
    if (lines.length) {
      let longterm = readText(this.longtermMd) || "";
      longterm += `\n## ${day}\n${lines.join("\n")}\n`;
      writeText(this.longtermMd, longterm);
    }
  }

  async recordTurn(user, assistant) {
    this._rollDay();
    this.state.turnCount += 1;
    this._saveState();
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
        const facts = await this.extractor(String(user || ""), String(assistant || ""), related);
        if (facts && facts.length) {
          // similarThreshold=0.6: LLM 提炼的字面变体 (同义不同词) 与已有事实语义相似时命中加分,
          // 防「三件套」这类反复提炼的变体污染记忆库
          for (const f of facts) this.factStore.add(f, { source: "extract", similarThreshold: 0.6 });
          return;
        }
      } catch {}
    }
    if (user) this.factStore.addMemory(user);
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
    const dayEvents = this.sessionStore && typeof this.sessionStore.replayDay === "function"
      ? this.sessionStore.replayDay(today)
      : [];
    for (const e of dayEvents) {
      if (e.seq <= afterSeq) continue;
      const who = e.type === "user/message" ? "用户" : "皮皮虾";
      rows.push(`- [${new Date(e.ts).toISOString()}] ${who}: ${String(e.data?.content || "").slice(0, 200)}`);
      if (e.seq > maxSeq) maxSeq = e.seq;
    }
    if (rows.length) {
      let longterm = readText(this.longtermMd) || "";
      longterm += `\n## ${today} (滚动)\n${rows.join("\n")}\n`;
      writeText(this.longtermMd, longterm);
    }
    st.lastRolledSeq = maxSeq;
    this._saveState();
  }

  // 滚动压缩: 今日事件超量时, 把最旧对话聚合压缩进 longterm, 只留近期
  // v1.0.7 节流: 压缩后 COMPACT_MIN_INTERVAL_MS 内不重复, 防每轮对话都付 LLM 压缩成本
  async _compactIfNeeded() {
    const now = Date.now();
    if (now - (this._lastCompactAt || 0) < COMPACT_MIN_INTERVAL_MS) return;
    const lines = _renderLines(this.sessionStore, logicalDay());
    if (lines.length < COMPACT_THRESHOLD) return;
    const compactedLines = lines.slice(0, -COMPACT_KEEP);
    const userMsgs = compactedLines
      .filter((li) => li.indexOf("用户:") !== -1)
      .map((li) => li.split("用户:")[1].trim())
      .filter(Boolean);
    let summary;
    if (this.summarizer && compactedLines.length) {
      try {
        const raw = compactedLines.slice(0, 60).join("\n");
        const s = await this.summarizer(raw);
        summary = "[" + logicalDay() + " llm-summary] " + (s || "(空)");
      } catch {
        summary = "[" + logicalDay() + " thin] archived " + compactedLines.length + " lines (llm fail)";
      }
    } else if (userMsgs.length) {
      summary = "[" + logicalDay() + " thin] " + userMsgs.length + " rounds archived: " + userMsgs.slice(0, 12).join(" | ") + (userMsgs.length > 12 ? " | ..." : "");
    } else {
      summary = "[" + logicalDay() + " thin] archived " + compactedLines.length + " lines";
    }
    let longterm = readText(this.longtermMd) || "";
    longterm += "\n## " + logicalDay() + " (rollup)\n" + summary + "\n";
    writeText(this.longtermMd, longterm);
    this._lastCompactAt = now; // 节流: 压缩完成后记录, 60s 内不再压缩
  }

  context(userMsg) {
    const todayCount = this.sessionStore ? _renderLines(this.sessionStore, logicalDay()).length : 0;
    const rawLongterm = readText(this.longtermMd) || "";
    const longterm = _longtermExcludingToday(rawLongterm, logicalDay()).slice(-3000);
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
        merged.push(f);
        if (merged.length >= 8) break;
      }
      return merged.map((f) => `- [${f.score}] ${f.content}`).join("\n");
    } catch { return ""; }
  }

  // 可观测: longterm 大小 + 今日事件数, 供 agent.stats() 聚合
  stats() {
    let longtermBytes = 0;
    try { longtermBytes = fs.statSync(this.longtermMd).size; } catch {}
    return {
      longterm_bytes: longtermBytes,
      events_today: _renderLines(this.sessionStore, logicalDay()).length,
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

