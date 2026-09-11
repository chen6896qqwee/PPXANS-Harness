// src/memory/l3.js - L3 核心画像 (腾讯风格 persona generation)
// 从记忆提炼: 用户画像 (user.persona.md) + agent 人格 (agent.persona.md)
// 零依赖: 高频词统计 + 主题聚合, 输出结构化画像
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readText, writeText, logicalDay } from "./store.js";

const STOP = new Set(["这个","那个","我们","你们","他们","什么","怎么","可以","一个","就是","知道","没有","如果","因为","所以","但是","然后","现在","今天","昨天","明天","已经","还有","所有","这样","那样","自己","的东西","的事情","一下","一点","一些","这些","那些","东西","事情","问题","觉得","应该","需要","开始","继续","大家","真的","只是","可能","不是","都是","一直","非常","其实","最后","主要","联系","关系","喜欢","讨厌","不要","想要","需要","觉得","认为","认为"]);

export class PersonaStore {
  constructor(dataDir, { userName = "兄弟" } = {}) {
    this.dir = path.join(dataDir, "memory", "l3");
    ensureDir(this.dir);
    this.userFile = path.join(this.dir, "user.persona.md");
    this.agentFile = path.join(this.dir, "agent.persona.md");
    this.userName = userName;
  }

  // 从一批事实提炼用户画像
  buildUserPersona(facts, { force = false } = {}) {
    if (!force && this._exists(this.userFile)) return this._read(this.userFile);
    // 聚焦用户相关的记忆 (来源 conversations / 主动分享)
    const userFacts = facts.filter((f) => ["conversation", "manual", "user-shared"].includes(f.type));
    const interests = this._topTopics(userFacts);
    const md = `# ${this.userName} 的用户画像

> 由皮皮虾 L3 画像引擎生成 | 更新: ${logicalDay()}

## 关注主题
${interests.length ? interests.map(([w, n]) => `- ${w} (出现${n}次)`).join("\n") : "- 暂无足够数据"}

## 记忆概要
${userFacts.slice(-10).map((f) => `- ${f.content}`).join("\n") || "- 暂无"}

## 画像版本
- 生成时间: ${logicalDay()}
- 数据来源: 对话记忆 + 用户主动分享
`;
    writeText(this.userFile, md);
    return md;
  }

  // 提炼 agent 自身人格 (从经验/工具使用学习)
  buildAgentPersona(lessons, { force = false } = {}) {
    if (!force && this._exists(this.agentFile)) return this._read(this.agentFile);
    const md = `# 皮皮虾 自我画像

> 从经验库自动学习 | 更新: ${logicalDay()}

## 学到的经验
${lessons.slice(-10).map((l) => `- ${l.lesson}`).join("\n") || "- 暂无"}

## 能力画像
- 工具: 文件操作 / 命令执行 / 搜索 / HTTP / 定时任务
- 记忆: 四层架构 (L0对话→L1原子→L2场景→L3画像)
- 自愈: 崩溃恢复 / 数据修复
- 军团: 多进程并行协作
`;
    writeText(this.agentFile, md);
    return md;
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