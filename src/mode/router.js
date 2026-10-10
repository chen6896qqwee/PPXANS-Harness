// src/mode/router.js - Router + Skill 模式
// 意图路由: 按用户输入匹配已安装技能, 把匹配到的 SKILL.md 注入上下文后执行。
// 适合: 多领域任务, 快速定位专门能力; 按需加载技能, 省 token。
import path from "node:path";
import { SkillLoader } from "../skills/loader.js";

// 技能匹配移至 src/skills/search.js (2026-10-01): name 加权 + 高置信阈值 + 歧义不押注,
// 并供 skill_search 工具复用同一打分器。此处保持转出口兼容既有 import。
export { matchSkill } from "../skills/search.js";

export async function routerExecutor(agent, userMsg, { sessionKey = "default" } = {}) {
  if (!agent.llm) {
    return (await agent._localIntent(userMsg)) || "[皮皮虾] 未配置模型 provider (配置见 docs/QUICKSTART.md 第 3 节)。";
  }
  // 1. 技能路由: 匹配用户输入到已安装技能
  // 2026-10-01 优化: 复用 agent.skills (原每条消息 new 一个 loader 全量重扫),
  // 命中即 trackUse — 路由路径此前绕过了使用统计, 自进化飞轮 (auto_skill/升级闸门) 因此少计数。
  const loader = agent.skills || new SkillLoader(path.join(agent.root, "skills"));
  const skill = matchSkill(loader, userMsg);
  if (skill && typeof loader.trackUse === "function") { try { loader.trackUse(skill.id); } catch {} }
  // 2. 注入技能内容到 system prompt, 再执行 (场景上下文已由 agent._context 注入)
  const system = agent._context(userMsg)
    + (skill ? `\n\n[已激活技能: ${skill.name}]\n${loader.read(skill.id)}` : "");
  const history = await agent._loadHistory(sessionKey);
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: String(userMsg) }];
  return agent._llmWithFallback(messages);
}
