// src/memory/l3.js - L3 核心画像 (腾讯风格 persona generation)
// 从记忆提炼: 用户画像 (user.persona.md) + agent 人格 (agent.persona.md)
// 零依赖: 高频词统计 + 主题聚合, 输出结构化画像
//
// 前缀缓存约束 (2026-10-05, scripts/cache-audit.js volatile_isolation 回归修复):
//   画像正文会被注入 system prompt 的静态区 (agent._context → _l3Context)。provider 缓存按
//   最长公共前缀匹配, 所以正文里**不能烘任何按天变化的字节** —— 旧实现把 logicalDay() 烤进
//   "> 更新: <日期>" 和 "- 生成时间: <日期>" 两行, 画像每天必变一次, 整段前缀白白重新计费。
//   现在的契约: ① 正文无日期; ② 更新日落档到旁路元数据 meta.json (信息不丢, stats()/personaDays()
//   仍可见); ③ 旧文件里已烘的日期在首次读取时惰性剥离并迁进 meta (迁移幂等, 不重写无日期文件)。
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJson, writeJson, readText, writeText, logicalDay } from "./store.js";

// 旧版正文里两处烘日期的行 (只匹配**生成模板**的精确形态, 绝不通吃用户事实里可能出现的日期)
const BAKED_UPDATED_RE = /\n> (由皮皮虾 L3 画像引擎生成|从经验库自动学习) \| 更新: (\d{4}-\d{2}-\d{2})/;
const BAKED_GEN_TIME_RE = /\n- 生成时间: (\d{4}-\d{2}-\d{2})(?=\n|$)/;

const STOP = new Set(["这个","那个","我们","你们","他们","什么","怎么","可以","一个","就是","知道","没有","如果","因为","所以","但是","然后","现在","今天","昨天","明天","已经","还有","所有","这样","那样","自己","的东西","的事情","一下","一点","一些","这些","那些","东西","事情","问题","觉得","应该","需要","开始","继续","大家","真的","只是","可能","不是","都是","一直","非常","其实","最后","主要","联系","关系","喜欢","讨厌","不要","想要","认为"]);

export class PersonaStore {
  constructor(dataDir, { userName = "兄弟" } = {}) {
    this.dir = path.join(dataDir, "memory", "l3");
    ensureDir(this.dir);
    this.userFile = path.join(this.dir, "user.persona.md");
    this.agentFile = path.join(this.dir, "agent.persona.md");
    // 旁路元数据: { userPersonaDay, agentPersonaDay } —— 画像"更新到哪一天"的唯一落点,
    // 供 MemoryService 跨进程判定"今天是否已刷新过" (旧实现只在内存, 同天重启会强制重建画像,
    // 而画像文本在缓存静态区 → 每次「学习+重启」都作废整个前缀, 即 cache-audit 学习→重启探针抓到的回归)。
    this.metaFile = path.join(this.dir, "meta.json");
    this.userName = userName;
    this._migrated = new Set(); // 每实例一次性惰性迁移守卫 (避免每轮 _context 都重复扫描/重写)
  }

  // 从一批事实提炼用户画像
  buildUserPersona(facts, { force = false } = {}) {
    if (!force && this._exists(this.userFile)) return this.userPersona();
    // 聚焦用户相关的记忆 (来源: 对话 / LLM提炼 / 主动记 / 手动 / 用户分享)
    // 注: 事实的来源标记在 source 字段 (type 恒为 general), 之前按 type 过滤永远为空 -> 修正为按 source
    const USER_SOURCES = ["conversation", "extract", "agent-self", "manual", "user-shared"];
    const userFacts = facts.filter((f) => USER_SOURCES.includes(f.source) || USER_SOURCES.includes(f.type));
    const interests = this._topTopics(userFacts);
    // 记忆概要: 内容去重后取最近 10 条 (防 LLM 提炼变体/重复记忆稀释画像)
    const uniq = this._uniqByContent(userFacts).slice(-10);
    // 正文无日期 (前缀缓存契约, 见文件头): 更新日写入 meta.userPersonaDay
    const md = `# ${this.userName} 的用户画像

> 由皮皮虾 L3 画像引擎生成

## 关注主题
${interests.length ? interests.map(([w, n]) => `- ${w} (出现${n}次)`).join("\n") : "- 暂无足够数据"}

## 记忆概要
${uniq.map((f) => `- ${f.content}`).join("\n") || "- 暂无"}

## 画像版本
- 数据来源: 对话记忆 + 用户主动分享
`;
    writeText(this.userFile, md);
    this._markBuilt(this.userFile, "userPersonaDay");
    return md;
  }

  // 提炼 agent 自身人格 (从经验/工具使用学习)
  buildAgentPersona(lessons, { force = false } = {}) {
    if (!force && this._exists(this.agentFile)) return this.agentPersona();
    // 学到的经验: 内容去重后取最近 10 条 (防重复经验污染自我画像)
    const uniq = this._uniqByContent(lessons, (l) => l.lesson).slice(-10);
    const md = `# 皮皮虾 自我画像

> 从经验库自动学习

## 学到的经验
${uniq.map((l) => `- ${l.lesson}`).join("\n") || "- 暂无"}

## 能力画像
- 工具: 文件操作 / 命令执行 / 搜索 / HTTP / 定时任务
- 记忆: 四层架构 (L0对话→L1原子→L2场景→L3画像)
- 自愈: 崩溃恢复 / 数据修复
- 军团: 多进程并行协作
`;
    writeText(this.agentFile, md);
    this._markBuilt(this.agentFile, "agentPersonaDay");
    return md;
  }

  // 内容去重: 按归一化内容 (去空白折叠) 过滤, 保留首次出现的条目
  _uniqByContent(items, pick = (x) => x.content) {
    const seen = new Set();
    const out = [];
    for (const it of items || []) {
      const key = String(pick(it) || "").trim().replace(/\s+/g, " ");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  }

  // 读取已生成的画像 (供 agent._context 注入; 未生成返回 "")。
  // 读取即惰性迁移: 旧文件里烘进正文的日期被剥出 → 正文回到字节稳定, 日期落进 meta.json。
  userPersona() { return this._readPersona(this.userFile, "userPersonaDay"); }
  agentPersona() { return this._readPersona(this.agentFile, "agentPersonaDay"); }

  // 画像正文的"最后生成日" (来自 meta.json; 文件缺失/未记录返回 null)。
  // 先读正文的意义: 让旧数据的烘日期在判定前就被迁移进 meta, personaDays 与迁移原子衔接。
  personaDays() {
    const u = this.userPersona();
    const a = this.agentPersona();
    const m = this._meta();
    return {
      user: u ? (m.userPersonaDay || null) : null,
      agent: a ? (m.agentPersonaDay || null) : null,
    };
  }

  // 可观测: L3 画像更新时间 (meta 优先——迁移/重写的 mtime 不代表内容版本; 无信息回退文件 mtime)
  stats() {
    const m = this._meta();
    return {
      user_updated: m.userPersonaDay || this._mtime(this.userFile),
      agent_updated: m.agentPersonaDay || this._mtime(this.agentFile),
    };
  }

  _readPersona(file, metaKey) {
    const text = this._read(file);
    if (!text || this._migrated.has(file)) return text;
    return this._stripBakedDay(file, metaKey, text);
  }

  // 惰性迁移 (幂等, 每实例每文件一次): 剥掉正文烘日期行 → 重写文件 → 日期写入 meta (不丢信息)。
  // 只识别本模块历史模板的两行精确形态, 用户事实内容里的日期一律不碰。
  _stripBakedDay(file, metaKey, text) {
    let out = text;
    let found = null;
    out = out.replace(BAKED_UPDATED_RE, (_m, label, day) => { found = day; return "\n> " + label; });
    out = out.replace(BAKED_GEN_TIME_RE, (_m, day) => { found = found || day; return ""; });
    if (found || out !== text) {
      const meta = this._meta();
      if (found && !meta[metaKey]) meta[metaKey] = found;
      if (out !== text) {
        writeJson(this.metaFile, meta);
        writeText(file, out);
      }
    }
    this._migrated.add(file);
    return out;
  }

  // 生成即落日期档 (正文不带日期, 见文件头的前缀缓存契约)
  _markBuilt(file, metaKey) {
    this._migrated.add(file);
    const meta = this._meta();
    meta[metaKey] = logicalDay();
    writeJson(this.metaFile, meta);
  }

  _meta() {
    const m = readJson(this.metaFile, null);
    return m && typeof m === "object" ? m : {};
  }

  _mtime(f) {
    try { return new Date(fs.statSync(f).mtime).toISOString().slice(0, 10); } catch { return null; }
  }

  _topTopics(facts) {
    const freq = new Map();
    for (const f of facts) {
      const words = String(f.content).match(/[\u4e00-\u9fa5]{2,4}/g) || [];
      for (const w of words) {
        if (STOP.has(w)) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }

  _exists(f) { try { return fs.existsSync(f); } catch { return false; } }
  _read(f) { return readText(f, ""); }
}
