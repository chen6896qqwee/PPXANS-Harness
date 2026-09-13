// src/memory/l2.js - L2 场景记忆 (腾讯风格 scene extraction)
// 把相关记忆归档成场景: { name, keywords, facts[], lastUpdated }
// 零依赖: 用关键词聚类 + 时间窗聚合
import path from "node:path";
import { ensureDir, readJson, writeJson, logicalDay, withFileLock } from "../utils/store.js";

// 中文简单分词: 提取有意义的词 (2字以上连续片段 + 已知高频概念)
const STOP = new Set(["这个","那个","我们","你们","他们","什么","怎么","可以","一个","就是","知道","没有","如果","因为","所以","但是","然后","现在","今天","昨天","明天","已经","还有","所有","这样","那样","自己","的时候","一下","一点","一些","这些","那些","东西","事情","问题","觉得","应该","需要","开始","继续","大家","真的","只是","可能","不是","都是","一直","非常","其实","最后","主要","联系","关系"]);

function tokenize(text) {
  const clean = String(text || "").replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ");
  const words = clean.split(/\s+/).filter(Boolean);
  const cjk = clean.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  return [...new Set([...words, ...cjk.map((w) => w.toLowerCase())].filter((w) => !STOP.has(w) && w.length >= 2))];
}

export class SceneStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "memory", "l2");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "scenes.json");
    this.scenes = readJson(this.file, []);
  }

  // 把一条事实归入最匹配的场景 (或新建)
  assign(fact) {
    const tokens = tokenize(fact.content);
    if (!tokens.length) return null;

    // 找最匹配的场景
    let best = null, bestScore = 0;
    for (const s of this.scenes) {
      let score = 0;
      for (const t of tokens) if ((s.keywords || []).includes(t)) score++;
      if (score > bestScore) { bestScore = score; best = s; }
    }

    if (best && bestScore >= 1) {
      best.facts.push({ id: fact.id, content: fact.content, ts: fact.created });
      if (best.facts.length > 50) best.facts = best.facts.slice(-50);
      best.lastUpdated = logicalDay();
      // 合并新关键词
      for (const t of tokens) if (!best.keywords.includes(t)) best.keywords.push(t);
      if (best.keywords.length > 30) best.keywords = best.keywords.slice(-30);
    } else {
      best = {
        id: "s_" + Math.random().toString(36).slice(2, 8),
        name: tokens.slice(0, 3).join("·"),
        keywords: tokens.slice(0, 10),
        facts: [{ id: fact.id, content: fact.content, ts: fact.created }],
        mode: "auto",
        description: tokens.slice(1, 4).join("、") || "自动场景",
        canHelp: "基于该话题的对话与记忆提供帮助",
        created: logicalDay(),
        lastUpdated: logicalDay(),
      };
      this.scenes.push(best);
    }
    // v1.0.9: 写盘加文件锁 (防军团多进程共享 dataDir 时写交错)
    return withFileLock(this.file, () => {
      writeJson(this.file, this.scenes);
      return best;
    });
  }

  // 手动创建场景 (用户设定人设/能力, 类似灵魂文件)
  create({ name, description, canHelp, keywords = [] }) {
    const scene = {
      id: "s_" + Math.random().toString(36).slice(2, 8),
      name: String(name || "").slice(0, 50),
      keywords: keywords.slice(0, 15),
      facts: [],
      mode: "manual",
      description: String(description || "").slice(0, 300),
      canHelp: String(canHelp || "").slice(0, 300),
      created: logicalDay(),
      lastUpdated: logicalDay(),
    };
    this.scenes.push(scene);
    this._save();
    return scene;
  }

  // 列出所有场景 (含介绍)
  listWithDesc() {
    return this.scenes.map((s) => ({
      id: s.id, name: s.name, mode: s.mode || "auto",
      description: s.description || "", canHelp: s.canHelp || "",
      facts: (s.facts || []).length, lastUpdated: s.lastUpdated,
    }));
  }

  // 按文本匹配激活场景 (关键词命中)
  findMatch(text) {
    const tokens = tokenize(text);
    if (!tokens.length) return null;
    let best = null, bestScore = 0;
    for (const s of this.scenes) {
      let score = 0;
      for (const t of tokens) if ((s.keywords || []).includes(t)) score++;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return bestScore >= 1 ? best : null;
  }

  // 激活场景的上下文块 (人设 + 能力)
  activeContext(text) {
    const s = this.findMatch(text);
    if (!s) return "";
    return [
      `【当前场景:${s.name}】`,
      s.description ? `场景介绍: ${s.description}` : "",
      s.canHelp ? `你可以帮用户: ${s.canHelp}` : "",
      s.mode === "manual" ? "(用户手动设定, 请遵循此场景行为)" : "",
    ].filter(Boolean).join("\n");
  }  // 按记忆 id 找回场景
  findByFactId(id) {
    return this.scenes.find((s) => s.facts.some((f) => f.id === id));
  }

  context(limit = 5) {
    return this.scenes.slice(-limit).map((s) =>
      `【场景:${s.name}】\n${s.facts.slice(-5).map((f) => `  - ${f.content}`).join("\n")}`
    ).join("\n");
  }

  count() { return this.scenes.length; }

  // v1.0.9: _save 加锁 (create/scene_describe 等写盘路径)
  _save() { withFileLock(this.file, () => writeJson(this.file, this.scenes)); }
}