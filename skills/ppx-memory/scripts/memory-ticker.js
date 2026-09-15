// src/memory/memory-ticker.js - 记忆水位移线 (参考 openhanako v4)
// today.md (今日水位线) -> daily/ (每日日记) -> longterm.md (长期记忆)
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readText, writeText, appendLine, logicalDay } from "./store.js";

const TURNS_PER_SUMMARY = 10;
const COMPACT_THRESHOLD = 50;   // today.md 超过此行数触发滚动压缩
const COMPACT_KEEP = 20;        // 压缩后保留的近期行数

export class MemoryTicker {
  constructor(dataDir, factStore, summarizer = null) {
    this.summarizer = summarizer;
    this.dir = path.join(dataDir, "memory");
    ensureDir(this.dir);
    ensureDir(path.join(this.dir, "daily"));
    this.factStore = factStore;
    this.todayMd = path.join(this.dir, "today.md");
    this.longtermMd = path.join(this.dir, "longterm.md");
    this.stateFile = path.join(this.dir, "daily-state.json");
    this.state = { day: null, turnCount: 0 };
    this._loadState();
    this._rollDay();
  }

  _loadState() {
    try {
      if (fs.existsSync(this.stateFile)) this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch { this.state = { day: null, turnCount: 0 }; }
  }

  _saveState() {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
  }

  _rollDay() {
    const today = logicalDay();
    if (this.state.day !== today) {
      if (this.state.day) this._compileDaily();
      this.state.day = today;
      this._saveState();
      writeText(this.todayMd, `# ${today}\n\n`);
    }
  }

  _compileDaily() {
    const today = this.state.day;
    const content = readText(this.todayMd);
    const dailyFile = path.join(this.dir, "daily", `${today}.md`);
    writeText(dailyFile, content || `# ${today}\n`);
    const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
    if (lines.length) {
      let longterm = readText(this.longtermMd);
      longterm += `\n## ${today}\n${lines.join("\n")}\n`;
      writeText(this.longtermMd, longterm);
      writeText(this.todayMd, `# ${logicalDay()}\n\n`);
    }
  }

  async recordTurn(user, assistant) {
    this._rollDay();
    this.state.turnCount += 1;
    const line = `- [${new Date().toISOString()}] 用户: ${String(user).slice(0, 200)}`;
    appendLine(this.todayMd, line);
    if (assistant) appendLine(this.todayMd, `  -> ${String(assistant).slice(0, 200)}`);
    this._saveState();
    if (this.state.turnCount % TURNS_PER_SUMMARY === 0) this._compileDaily_Rolling();
    await this._compactIfNeeded();
    if (user) this.factStore.addMemory(user);
  }

  _compileDaily_Rolling() {
    const content = readText(this.todayMd);
    const lines = content.split("\n").filter((l) => l.trim().startsWith("- "));
    if (lines.length) {
      let longterm = readText(this.longtermMd);
      longterm += `\n## ${logicalDay()} (滚动)\n${lines.slice(-20).join("\n")}\n`;
      writeText(this.longtermMd, longterm);
    }
  }



  // 滚动上下文压缩: today.md 超量时, 把最旧对话聚合压缩进 longterm, 只留近期
  async _compactIfNeeded() {
    const content = readText(this.todayMd);
    const lines = content.split("\n").filter((li) => li.trim());
    if (lines.length < COMPACT_THRESHOLD) return;
    const keepLines = lines.slice(0, 1).concat(lines.slice(-COMPACT_KEEP));
    const compactedLines = lines.slice(1, -COMPACT_KEEP);
    const userMsgs = compactedLines
      .filter((li) => li.indexOf("用户:") !== -1)
      .map((li) => li.split("用户:")[1].trim())
      .filter(Boolean);
    let summary;
    // 优先 LLM 真摘要 (若配置了 summarizer), 否则降级为堆叠
    if (this.summarizer && compactedLines.length) {
      try {
        const raw = compactedLines.slice(0, 60).join("\n");
        const s = await this.summarizer(raw);
        summary = "[" + logicalDay() + " llm-summary] " + (s || "(空)");
      } catch (e) {
        summary = "[" + logicalDay() + " thin] archived " + compactedLines.length + " lines (llm fail: " + e.message + ")";
      }
    } else if (userMsgs.length) {
      summary = "[" + logicalDay() + " thin] " + userMsgs.length + " rounds archived: " + userMsgs.slice(0, 12).join(" | ") + (userMsgs.length > 12 ? " | ..." : "");
    } else {
      summary = "[" + logicalDay() + " thin] archived " + compactedLines.length + " lines";
    }
    let longterm = readText(this.longtermMd);
    longterm += "\n## " + logicalDay() + " (rollup)\n" + summary + "\n";
    writeText(this.longtermMd, longterm);
    writeText(this.todayMd, keepLines.join("\n") + "\n");
  }
  context() {
    const today = readText(this.todayMd);
    const longterm = readText(this.longtermMd).slice(-3000);
    const topFacts = this.factsTop();
    return `
# 今日记忆
${today}

# 长期记忆 (最近)
${longterm}

# 关键事实
${topFacts || "(暂无)"}
`;
  }

  factsTop() {
    try {
      return this.factStore.query("", { limit: 8 }).map((f) => `- [${f.score}] ${f.content}`).join("\n");
    } catch { return ""; }
  }
}