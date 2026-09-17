// src/memory/fork.js - 会话 fork 基线 (P2⑦)
// 吸收 HanaAgent 的 fork baseline 设计思想:
//   子代理 spawn 时携带记忆基线快照 (L1 facts + L3 persona + 经验精选), 子任务结束按结果 merge 或 discard。
// 皮皮虾自研实现: 主 agent 记忆导出为子 dataDir 可读的快照文件, 子 agent 独立演进,
//   结束后可选 merge 回主记忆 (去重) 或丢弃 (隔离)。纯代码, 无 LLM 参与 merge 决策。
import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeText, readText } from "../utils/store.js";
import { lexicalSimilarity } from "../evolve/playbook.js";

// 从主 agent 导出记忆快照到子 dataDir
// 快照内容: L1 facts (top N) + L3 persona (若存在) + 全局经验精选 (top M)
// 返回 { wrote: {facts, persona, experience}, path }
export function exportMemorySnapshot({ agent, toDataDir, factsLimit = 50, experienceLimit = 10 } = {}) {
  if (!agent) return { wrote: {}, path: null };
  const snapDir = path.join(toDataDir, "memory", "snapshot");
  ensureDir(snapDir);
  const wrote = {};

  // L1 facts: 取衰减分 top N (事实快照)
  try {
    if (agent.facts && typeof agent.facts.query === "function") {
      const top = agent.facts.query("", { limit: factsLimit });
      const lines = top.map((f) => `- [${Math.round(f.score * 100)}] ${f.content}`).join("\n") || "(无)";
      writeText(path.join(snapDir, "facts.md"), `# L1 事实快照 (fork 基线)\n${lines}\n`);
      wrote.facts = top.length;
    }
  } catch {}

  // L3 persona: 主 agent 画像 (用户画像 + agent 人格)
  // 修复 (2026-09-17): 原调用 agent.personaStore.read() —— PersonaStore 并不存在 read(),
  //   真实 API 是 userPersona() / agentPersona()。虽有 typeof 守卫不致崩, 但分支永不进入,
  //   persona.md 从未生成 (静默降级)。此处改用真实方法, 并把两份画像一并导出。
  try {
    const ps = agent.personaStore;
    if (ps && typeof ps.userPersona === "function") {
      const parts = [];
      const u = typeof ps.userPersona === "function" ? ps.userPersona() : "";
      const a = typeof ps.agentPersona === "function" ? ps.agentPersona() : "";
      if (u) parts.push(String(u).trim());
      if (a) parts.push(String(a).trim());
      if (parts.length) {
        writeText(path.join(snapDir, "persona.md"), `# L3 画像快照 (fork 基线)\n\n${parts.join("\n\n---\n\n")}\n`);
        wrote.persona = true;
      }
    }
  } catch {}

  // 全局经验精选
  try {
    if (agent.experience && typeof agent.experience.list === "function") {
      const list = agent.experience.list({ limit: experienceLimit });
      if (list && list.length) {
        const lines = list.map((e) => `- ${e.lesson || e.content || ""}`).join("\n");
        writeText(path.join(snapDir, "experience.md"), `# 经验快照 (fork 基线)\n${lines}\n`);
        wrote.experience = list.length;
      }
    }
  } catch {}

  return { wrote, path: snapDir };
}

// 子任务完成后 merge 回主记忆 (按内容去重, 冲突保留主记忆)
// 返回 { merged: n, skipped: n }
export function mergeSnapshotBack({ agent, fromDataDir, dryRun = false } = {}) {
  const snapDir = path.join(fromDataDir, "memory", "snapshot");
  const factsFile = path.join(snapDir, "facts.md");
  let merged = 0;
  let skipped = 0;
  if (!agent || !agent.facts || !fs.existsSync(factsFile)) return { merged: 0, skipped: 0 };
  const text = readText(factsFile) || "";
  const lines = text.split("\n").filter((l) => /^- \[/.test(l));
  for (const l of lines) {
    const content = l.replace(/^- \[\d+\]\s*/, "").trim();
    if (!content) continue;
    // 精确/高度词法相似才判定重复 (BM25 分数不可靠: 短查询常命中不相关事实)
    const dup = (agent.facts.query(content, { limit: 3 }) || []).find((f) => lexicalSimilarity(f.content, content) > 0.8);
    if (dup) { skipped++; continue; }
    if (!dryRun) agent.facts.add(content, { source: "fork-merge", similarThreshold: 0.8 });
    merged++;
  }
  return { merged, skipped };
}

// 便捷: 判断某 dataDir 是否带快照
export function hasSnapshot(dataDir) {
  return fs.existsSync(path.join(dataDir, "memory", "snapshot", "facts.md"));
}

export default { exportMemorySnapshot, mergeSnapshotBack, hasSnapshot };
