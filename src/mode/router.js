// src/mode/router.js - Router + Skill 模式
// 意图路由: 按用户输入匹配已安装技能, 把匹配到的 SKILL.md 注入上下文后执行。
// 适合: 多领域任务, 快速定位专门能力; 按需加载技能, 省 token。
import path from "node:path";
import { SkillLoader } from "../skills/loader.js";
import { buildMessages } from "./index.js";

// 技能匹配: 中文用连续两字(bigram)命中描述, 英文/数字用词命中
export function matchSkill(loader, text) {
  const skills = loader.list();
  const q = String(text || "").toLowerCase();
  let best = null, bestScore = 0;
  for (const s of skills) {
    const desc = (s.description || "").toLowerCase();
    let score = 0;
    const bigrams = new Set();
    const cjk = q.match(/[\u4e00-\u9fff]+/g) || [];
    for (const seg of cjk) for (let i = 0; i < seg.length - 1; i++) bigrams.add(seg.slice(i, i + 2));
    for (const bg of bigrams) if (desc.includes(bg)) score += 1;
    const words = q.match(/[a-z0-9]+/g) || [];
    for (const w of words) if (w.length >= 2 && desc.includes(w)) score += 1;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 1 ? best : null;
}

export async function routerExecutor(agent, userMsg, { sessionKey = "default" } = {}) {
  if (!agent.llm) {
    return (await agent._localIntent(userMsg)) || "[皮皮虾] 未配置模型 provider (配置见 docs/QUICKSTART.md 第 3 节)。";
  }
  // 1. 技能路由: 匹配用户输入到已安装技能
  const loader = new SkillLoader(path.join(agent.root, "skills"));
  const skill = matchSkill(loader, userMsg);
  // 2. 注入技能内容到 system prompt, 再执行 (场景上下文已由 agent._context 注入)
  const system = agent._context(userMsg)
    + (skill ? `\n\n[已激活技能: ${skill.name}]\n${loader.read(skill.id)}` : "");
  const history = await agent._loadHistory(sessionKey);
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: String(userMsg) }];
  return agent._llmWithFallback(messages);
}
