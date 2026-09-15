// src/orchestrator/supervisor.js - supervisor 编排模式 (P3⑨)
// 吸收 LangGraph supervisor 拓扑 + OpenAI Agents SDK handoff 思想 (仅思想, 无源码复制):
//   监督者(S) 分解任务 → 派发给多个专家子 agent (E1..En) → 收集结果 →
//   S 综合/评审 → 决定: 接受最终答案 / 发现分歧 → 重新派发修正 / 升级人工。
// 皮皮虾自研实现, 构建在现有 Legion (多进程) + delegate 仲裁之上。
// 与 delegate.js 的 arbitrate (一次性聚合) 互补: supervisor 是完整编排循环 (可多轮修正)。

// 带超时等待 (防子 agent 卡死) — 定时器必须清理
export function withTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}超时 (${ms / 1000}s)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export const SUPERVISOR_DEFAULTS = {
  maxRounds: 3,          // 最多几轮修正
  timeoutMs: 120000,     // 每轮子 agent 超时
  minConsensus: 0.6,     // 一致率低于此值视为分歧 (需重新派发)
};

// ---- 纯函数: 从子结果中识别分歧 ----
// results: [{agent, reply}]  reply 为文本
// 返回 { consensus: 0~1, clusters: [{key, members, replies}], divergent: boolean }
// 用词法相似度聚类 (零依赖, 可升级 embedding)
export function findDisagreement(results, { minConsensus = SUPERVISOR_DEFAULTS.minConsensus } = {}) {
  const list = (results || []).filter((r) => r && typeof r.reply === "string" && r.reply.trim());
  if (list.length < 2) return { consensus: 1, clusters: [{ key: "solo", members: list, replies: list.map((r) => r.reply) }], divergent: false };

  // 贪心聚类: 相似度 > 0.4 归一组
  const clusters = [];
  const assigned = new Set();
  for (let i = 0; i < list.length; i++) {
    if (assigned.has(i)) continue;
    const members = [list[i]];
    assigned.add(i);
    for (let j = i + 1; j < list.length; j++) {
      if (assigned.has(j)) continue;
      if (lexSim(list[i].reply, list[j].reply) > 0.4) {
        members.push(list[j]);
        assigned.add(j);
      }
    }
    clusters.push({ key: "c" + clusters.length, members, replies: members.map((m) => m.reply) });
  }
  const largest = Math.max(...clusters.map((c) => c.members.length));
  const consensus = largest / list.length;
  return { consensus, clusters, divergent: consensus < minConsensus };
}

function lexSim(a, b) {
  // 中文连续串用字符 bigram (词级 Jaccard 对中文短句失效), 与 playbook.js 同策略
  const ta = String(a || "");
  const tb = String(b || "");
  if (!ta || !tb) return 0;
  const tk = (s) => {
    const words = s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.length > 1) return words;
    const chars = s.replace(/\s+/g, "").toLowerCase();
    const out = [];
    for (let i = 0; i < chars.length - 1; i++) out.push(chars.slice(i, i + 2));
    return out.length ? out : chars.split("");
  };
  const A = new Set(tk(ta));
  const B = new Set(tk(tb));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// ---- 纯函数: 组装监督者修正提示词 (把分歧/缺陷反馈给子 agent) ----
export function buildRevisionPrompt(task, feedback) {
  const lines = (feedback || []).map((f, i) => `${i + 1}. ${f}`).join("\n");
  return `${task}\n\n【监督者反馈】以下问题需修正:\n${lines}\n\n请针对反馈逐条修正, 只解决反馈问题, 不要引入新内容。`;
}

// ---- 监督者循环 ----
// opts: { legion, agents: [name...], task, judge, maxRounds, timeoutMs, minConsensus, onRound }
// 返回 { answer, rounds, consensus, divergent, history: [{round, results, feedback}] }
export async function runSupervisor({ legion, agents = [], task = "", judge = "", maxRounds = SUPERVISOR_DEFAULTS.maxRounds, timeoutMs = SUPERVISOR_DEFAULTS.timeoutMs, minConsensus = SUPERVISOR_DEFAULTS.minConsensus, onRound = null, llm = null, finalize = null } = {}) {
  const history = [];
  let currentTask = task;
  let answer = "";
  let rounds = 0;

  for (let r = 0; r < maxRounds; r++) {
    rounds = r + 1;
    // 派发给所有专家
    const results = [];
    for (const name of agents) {
      try {
        const resp = await withTimeout(
          legion.send(name, { type: "chat", message: currentTask }, { timeout: timeoutMs + 5000 }),
          timeoutMs,
          `监督者派发→${name}`
        );
        results.push({ agent: name, reply: String(resp?.reply || "").trim() || "(无回复)" });
      } catch (e) {
        results.push({ agent: name, reply: `[失败] ${e.message}` });
      }
    }

    // 分歧检测
    const { consensus, divergent, clusters } = findDisagreement(results, { minConsensus });
    const roundRec = { round: r + 1, results, consensus, divergent, feedback: [] };

    // 监督者评审: 有 LLM 且有多结果时, 让监督者决定是否接受或给反馈
    let accept = !divergent;
    let feedback = [];
    if (llm && results.length >= 2) {
      const verdict = await judgeRound(llm, task, results, judge);
      accept = verdict.accept;
      feedback = verdict.feedback;
    } else if (divergent) {
      feedback = [`各方结果存在分歧 (一致率 ${(consensus * 100).toFixed(0)}%), 请重新给出更一致的结论。`];
    }
    roundRec.feedback = feedback;
    history.push(roundRec);
    onRound?.(roundRec);

    if (accept) {
      // 监督者 (或 finalize) 产出最终答案
      if (llm) {
        const final = await finalizeRound(llm, task, results, judge);
        answer = final;
      } else {
        answer = results[0]?.reply || "";
      }
      return { answer, rounds, consensus, divergent: false, history };
    }
    // 不通过: 带反馈重新派发
    currentTask = buildRevisionPrompt(task, feedback.length ? feedback : ["请给出更精确、一致的答案。"]);
  }
  // 达到轮数上限: 返回最近一轮结果 + 分歧标记
  const last = history[history.length - 1];
  answer = last.results.map((r) => `【${r.agent}】${r.reply}`).join("\n\n");
  return { answer, rounds, consensus: last.consensus, divergent: true, history };
}

// 监督者评审: 综合各结果, 决定接受/打回 + 反馈
async function judgeRound(llm, task, results, judge) {
  const input = results.map((r) => `【${r.agent}】\n${String(r.reply).slice(0, 1500)}`).join("\n\n");
  try {
    const r = await llm.chat([
      { role: "system", content: "你是监督者。评估各专家子 agent 的结果是否满足任务要求。输出 JSON: {\"accept\": true/false, \"feedback\": [\"问题1\", \"问题2\"]}。accept=true 时 feedback 为空数组。只输出 JSON。" },
      { role: "user", content: `【任务】${String(task).slice(0, 1000)}\n${judge ? `【评审要求】${judge}\n` : ""}【各方结果】\n${input.slice(0, 5000)}` },
    ]);
    const text = String(r?.content || "").replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { accept: false, feedback: ["监督者输出格式错误, 请重新回答"] };
    const parsed = JSON.parse(m[0]);
    return {
      accept: parsed.accept === true,
      feedback: Array.isArray(parsed.feedback) ? parsed.feedback.slice(0, 5).map(String) : [],
    };
  } catch {
    return { accept: false, feedback: ["监督者评审失败, 请重新回答"] };
  }
}

// 监督者定稿: 综合各结果给最终答案
async function finalizeRound(llm, task, results, judge) {
  const input = results.map((r) => `【${r.agent}】\n${String(r.reply).slice(0, 2000)}`).join("\n\n");
  try {
    const r = await llm.chat([
      { role: "system", content: "你是监督者。综合各专家结果, 给出最终整合答案。直接输出最终答案, 不要复述过程。" },
      { role: "user", content: `【任务】${String(task).slice(0, 1000)}\n${judge ? `【评审要求】${judge}\n` : ""}【各方结果】\n${input.slice(0, 6000)}` },
    ]);
    return String(r?.content || "").trim() || "(监督者无输出)";
  } catch {
    return results.map((r) => `【${r.agent}】${r.reply}`).join("\n\n");
  }
}

export default { runSupervisor, findDisagreement, buildRevisionPrompt };
