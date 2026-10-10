// src/tools/delegate.js - 多 agent 自主协作工具 (spawn_agent)
// 让 agent 在工具循环里自主决定 spawn 子 agent 分工 (ANS 神经元中枢的最小实现):
//   - 主 agent 分析任务 → 认为需要专门角色/并行/隔离 → 调 spawn_agent
//   - 子 agent: 独立会话目录 (隔离) + 共享全局经验库 (ANS 全局记忆)
//   - 子 agent 复用懒建军团 (agent._legion), 不重复 spawn 进程
// v2 (2026-08-17): 吸收 Anthropic 多智能体研究洞察
//   - 并行任务: tasks 数组并行派发多个子 agent (专才 + 并行化)
//   - 差异化上下文: perspectives 注入每个子 agent 专属视角, 对抗同质失败
//   - 仲裁聚合: arbitrate 时主 agent LLM 综合各子结果做最终裁决
// v3 (2026-08-17): 吸收 Superpowers SDD 子代理驱动开发
//   - review 循环: 实施者 -> 只读审查者 -> (发现问题 -> 修复 -> 复审) * fixRounds -> 熔断停放
//   - 审查者只读 (PPX_AGENT_READONLY), 实施者修复复用原进程 (上下文完整)
//   - 账本 ledger: 全程记录审查/修复轮次, 熔断时未决发现交主 agent 裁定
import path from "node:path";
import { Legion } from "../orchestrator/legion.js";
import { resolveExpert, listExperts, normalizePersona, registerUserExpert, resolveExpertWithUser, saveUserExperts } from "../orchestrator/experts.js";
import { resolveTeam, teamExperts, teamRiskProfile, listTeams } from "../orchestrator/teams.js";
import { withTimeout } from "../utils/async.js";
import { profileFromEngine, childSpawnEnv } from "../permissions/intersection.js";
import { currentTrace } from "../core/trace.js";

const DELEGATE_TIMEOUT_MS = 120000; // 子任务最长等待 (防卡死主 agent 工具循环)

// ---- 专家解析 (2026-10-10 接线) ----
// 专家包 (磁盘上可增长) 优先, 再落内置 EXPERTS 名册 + 用户档。
//   此前只认内置名册, 于是专家包 id ("ai-coding-coach" / "ops-engineer" 等) 恒解析失败,
//   静默降级成"无专家", 人格视角根本没进子 agent。此处补上包目录这条通路。
export function resolveExpertFor(agent, key) {
  const k = String(key || "").trim();
  if (!k) return null;
  const packs = agent?.expertPacks;
  if (packs && typeof packs.resolve === "function") {
    const pack = packs.resolve(k);
    if (pack) {
      let persona = null;
      try {
        persona = typeof packs.personaOf === "function"
          ? packs.personaOf(pack.id, {
            agentName: agent?.config?.agent?.name || "皮皮虾",
            userDisplay: agent?.userName || "兄弟",
            withAgents: true,
          })
          : null;
      } catch { /* persona 渲染失败 → 回落包自带 perspective */ }
      return {
        name: pack.label || pack.id,
        perspective: persona || pack.perspective || null,
        readonly: !!pack.readonly,
        requiresHuman: !!pack.requiresHuman,
        domain: pack.domain,
        source: "pack",
      };
    }
  }
  return resolveExpert(k) || resolveExpertWithUser(k) || null;
}

// ---- SDD review 循环: 纯函数 (可测) ----

// 严重级标签映射 (v1.0.8): 内部表示 Critical/Important/Minor, 展示用中文, 解析兼容中英
export function severityLabel(s) {
  if (s === "Critical" || s === "严重" || s === "P0") return "严重";
  if (s === "Important" || s === "重要" || s === "P1") return "重要";
  return "次要";
}
function severityOf(token) {
  if (token === "严重" || token === "P0") return "Critical";
  if (token === "重要" || token === "P1") return "Important";
  if (token === "Critical" || token === "Important") return token; // 英文 token 原样映射
  return "Minor";
}

// 解析审查者输出 -> 发现列表 [{ severity, finding }]
// 期望格式: 每行 "[严重|重要|次要] 描述" (兼容英文 Critical/Important/Minor), 无发现为 "(无发现)"
export function parseReviewFindings(text) {
  if (!text) return [];
  const out = [];
  const re = /\[(严重|重要|次要|Critical|Important|Minor)\]\s*([^\n]+)/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const finding = m[2].trim();
    if (finding) out.push({ severity: severityOf(m[1]), finding });
  }
  return out;
}

// 是否需要触发修复: 有 Critical/Important
export function needsFix(findings) {
  return findings.some((f) => f.severity === "Critical" || f.severity === "Important");
}

// 组装审查者提示词 (只读审查契约)
export function buildReviewPrompt(workDesc, judge, perspective) {
  const p = perspective ? `\n【审查视角】${perspective}` : "";
  return `你是只读审查者。审查下面"产出"中实施者的结果, 找出问题。严格遵守: 只读审查, 禁止修改/写入任何文件, 禁止执行命令。

【任务要求】${workDesc}
【审查准则】${judge || "对照任务要求检查: 功能正确性 / 需求满足度 / 边界情况 / 明显风险"}${p}

【产出】
${"<产出内容>"}

输出发现清单, 每行一条, 格式 "[严重级] 描述", 严重级用:
- [严重] 功能错误 / 需求未满足 / 会导致失败
- [重要] 质量缺陷 / 边界情况 / 明显风险
- [次要] 小改进 / 风格
没有任何问题时只输出一行 "(无发现)"。不要输出其他内容。`;
}

// 修复提示词: 把未决发现交给实施者修复
export function buildFixPrompt(task, findings) {
  const open = findings.filter((f) => f.severity === "Critical" || f.severity === "Important");
  const lines = open.map((f) => `[${severityLabel(f.severity)}] ${f.finding}`).join("\n");
  return `上一轮产出存在以下 ${open.length} 项问题, 请逐一修复 (只解决这些问题, 不要引入新问题):\n${lines}\n\n原始任务: ${task}`;
}

// ---- 纯函数: 组装多子结果 + 视角 (仲裁输入) ----
export function buildArbitrationInput(tasks, results, perspectives) {
  return tasks.map((t, i) => {
    const p = perspectives?.[i] ? ` (视角: ${perspectives[i]})` : "";
    return `【子任务${i + 1}${p}】${t}\n【结果${i + 1}】${String(results[i] || "").slice(0, 2000)}`;
  }).join("\n\n");
}

// 主 agent 聚合评审 (仲裁者模式): 综合各子结果, 输出最终裁决
// 无 LLM 或评审失败时退化为简单拼接 (不阻塞)
export async function arbitrate(agent, tasks, results, perspectives, judge) {
  const input = buildArbitrationInput(tasks, results, perspectives);
  const system = "你是多 agent 结果的仲裁者。综合各方结果, 识别分歧与共识, 给出一个整合后的最终答案。直接输出最终答案, 不要复述过程。";
  const user = input + (judge ? `\n\n【评审要求】${judge}` : "");
  try {
    const r = await agent.llm.chat([
      { role: "system", content: system },
      { role: "user", content: user.slice(0, 6000) },
    ]);
    const text = String(r?.content || "").trim();
    return text || `(仲裁无输出)\n\n${input}`;
  } catch (e) {
    return `(仲裁失败, 直出各方结果)\n\n${input}`;
  }
}

// (withTimeout 收敛到 utils/async.js: 原先本文件与 orchestrator/supervisor.js 各写一份)

// 仲裁 + 记忆板上下文 (2026-10-02): share_board 时先读板 (本角色最近发布), 让仲裁者看到军团累积知识。
// 板为空/异常时静默退化为纯仲裁, 不阻塞。
export async function arbitrateWithBoard(agent, tasks, results, perspectives, judge, { board, shareBoard, boardTopic } = {}) {
  let boardContext = "";
  if (shareBoard && board) {
    try {
      const entries = board.query({ topic: boardTopic, limit: 20 });
      if (entries.length) {
        boardContext = "\n\n【军团记忆板 (本角色近期发布)】\n" + entries.map((e) => `- ${e.from}: ${e.content}`).join("\n");
      }
    } catch { /* 读板失败不阻塞仲裁 */ }
  }
  return arbitrate(agent, tasks, results, perspectives, judge + boardContext);
}

/* ======================= 班组编排 (runTeam) ======================= */

/**
 * 按拓扑把一个任务分派给班组并整合产出。
 * 五种拓扑: pipeline (前环产出成为后环输入) / parallel (各自产出 + 仲裁整合) /
 *          debate (正反两方 + 仲裁) / review (实施 + 只读审查) / supervisor (兜底走仲裁整合)。
 * 安全侧: 只读成员一律挂 PPX_AGENT_READONLY; 全部 spawn 走治理入口 (spawnAgents 优先);
 *        数据目录在 <agent.dataDir>/legion/<成员名> 下隔离。
 * @param {object} o
 * @param {object} o.agent  主 agent
 * @param {object} o.L      军团 (测试可注入桩)
 * @param {{id:string,name:string,topology:string}} o.team
 * @param {Array<{name:string,perspective?:string,readonly?:boolean}>} o.members
 * @param {string} o.task
 * @param {string} [o.judge]     仲裁/审查准则
 * @param {Function} [o.onSpawn] 每 spawn 一个成员回调一次 (供调用方 finally 回收)
 * @returns {Promise<{text:string, spawnNames:string[], replies:string[]}>}
 */
export async function runTeam({ agent, L, team, members = [], task, judge = null, onSpawn = null } = {}) {
  const teamId = String(team?.id || "team").replace(/[^\w-]/g, "") || "team";
  const topology = String(team?.topology || "parallel");
  const list = (members || []).filter(Boolean);
  if (!task) return { text: "(班组任务为空)", spawnNames: [], replies: [] };
  if (!list.length) return { text: "(班组无成员)", spawnNames: [], replies: [] };

  const ts = Date.now().toString(36);
  // 名字带班组标识 → 与其他委派/其他班组的子 agent 不冲突
  const spawnNames = list.map((m, i) => {
    const slug = String(m.name || m.id || `m${i}`).replace(/[^\w\u4e00-\u9fff-]/g, "").slice(0, 12);
    return `${teamId}_${i}_${slug}_${ts}`;
  });
  const specs = list.map((m, i) => ({
    name: spawnNames[i],
    opts: {
      dataDir: path.join(agent.dataDir, "legion", spawnNames[i]),
      globalDataDir: agent.globalDataDir,
      // 只读成员挂只读杠杆 (子进程侧禁修改类工具)
      env: m.readonly ? { PPX_AGENT_READONLY: "1" } : {},
    },
  }));

  // 治理入口: 整批走 spawnAgents (可被配额/并发治理拦下), 缺该口才退回逐个 spawn
  if (typeof L?.spawnAgents === "function") await L.spawnAgents(specs);
  else for (const s of specs) L?.spawnAgent?.(s.name, s.opts);
  for (const s of specs) { try { onSpawn?.(s.name); } catch { /* 回调异常不影响编排 */ } }
  if (agent.lifecycle) agent.lifecycle.reproduce(specs.length);

  const send = async (i, message) => {
    const who = list[i].name || spawnNames[i];
    try {
      const r = await withTimeout(
        L.send(spawnNames[i], { type: "chat", message, perspective: list[i].perspective || null }, { timeout: DELEGATE_TIMEOUT_MS + 5000 }),
        DELEGATE_TIMEOUT_MS,
        who,
      );
      return String(r?.reply || "(无回复)");
    } catch (e) {
      return `[${who} 失败] ${e.message}`;
    }
  };
  const nameOf = list.map((m) => m.name || m.id);
  const persps = list.map((m) => m.perspective || null);

  // ---- pipeline: 前环产出成为后环输入 ----
  if (topology === "pipeline") {
    const replies = [];
    for (let i = 0; i < list.length; i++) {
      const parts = [`【任务】${task}`];
      if (i > 0) {
        parts.push(`【上一环产出】\n${replies[i - 1]}\n\n请在此基础上继续推进, 不要重复上一环已完成的工作。`);
      }
      if (persps[i]) parts.push(`【你的视角】${persps[i]}`);
      replies.push(await send(i, parts.join("\n\n")));
    }
    return { text: replies.map((r, i) => `【${nameOf[i]}】\n${r}`).join("\n\n"), spawnNames, replies };
  }

  // ---- debate: 正反两方 + 仲裁 ----
  if (topology === "debate") {
    const replies = [];
    for (let i = 0; i < list.length; i++) {
      const side = i === 0 ? "正方" : "反方";
      const msg = `【议题】${task}\n\n你是**${side}**。请坚决站在${side}立场论证, 并主动预见并回应对方可能提出的反驳。`
        + (persps[i] ? `\n【你的视角】${persps[i]}` : "");
      replies.push(await send(i, msg));
    }
    const verdict = await arbitrate(
      agent,
      list.map(() => task), replies, persps,
      judge || "权衡正反两方论据, 给出经得起反驳的结论, 并说明结论成立的前提条件",
    );
    const text = [`【仲裁结论】\n${verdict}`]
      .concat(replies.map((r, i) => `【${i === 0 ? "正方" : "反方"}·${nameOf[i]}】\n${r}`))
      .join("\n\n");
    return { text, spawnNames, replies };
  }

  // ---- review: 实施者 (可写) + 只读审查者 ----
  if (topology === "review") {
    const impl = await send(0, `【任务】${task}`);
    const revTexts = [];
    const findings = [];
    for (let i = 1; i < list.length; i++) {
      const r = await send(i, `${buildReviewPrompt(task, judge, persps[i])}\n\n【产出】\n${impl}`);
      revTexts.push(r);
      findings.push(...parseReviewFindings(r));
    }
    const open = findings.filter((f) => f.severity === "Critical" || f.severity === "Important");
    const head = `【实施·${nameOf[0]}】\n${impl}`;
    const text = open.length
      ? `${head}\n\n⚠️ 审查发现问题 (${open.length} 项, 未修复 —— 交主 agent 裁定)\n${open.map((f) => `[${severityLabel(f.severity)}] ${f.finding}`).join("\n")}`
      : (revTexts.length ? `${head}\n\n✅ 审查通过\n${revTexts.join("\n")}` : head);
    return { text, spawnNames, replies: [impl, ...revTexts] };
  }

  // ---- parallel / supervisor: 各自独立产出 → 仲裁整合 ----
  // (supervisor 的进程级调度在 orchestrator/supervisor.js, 这里保持"各自产出 + 仲裁"的协作形状)
  const replies = await Promise.all(list.map((_, i) => send(i, [
    `【任务】${task}`,
    persps[i] ? `【你的视角】${persps[i]}` : "",
    "请独立给出你的结论与依据, 不必迁就他人观点。",
  ].filter(Boolean).join("\n\n"))));
  const verdict = await arbitrate(agent, list.map(() => task), replies, persps, judge);
  const text = [`【仲裁结论】\n${verdict}`, "## 各方原始产出"]
    .concat(replies.map((r, i) => `【${nameOf[i]}】\n${r}`))
    .join("\n\n");
  return { text, spawnNames, replies };
}

/* ======================= 监督者编排循环 ======================= */
// supervisor 模式: 编排 N 个专家子 agent 并行产出 → 监督者 LLM 评审 (评估各专家子 agent)
// → 打回则带反馈再派发一轮 → 接受则产出定稿。返回带 "✅ 监督者编排" 头的完整报告。
export async function runSupervisorLoop({ agent, L, task, judge = null, expertKeys = [], role = "专家", maxRounds = 3 } = {}) {
  // 专家名册解析: 有 expertKeys 用名册, 否则用 2 个默认差异化专家
  const experts = (expertKeys && expertKeys.length)
    ? expertKeys.map((k) => resolveExpertFor(agent, k) || { name: String(k), perspective: null })
    : [
        { name: "分析专家", perspective: "从收益与可行性两个维度独立论证" },
        { name: "风险专家", perspective: "从风险与反例角度独立论证, 主动挑出漏洞" },
      ];
  const ts = Date.now().toString(36);
  const spawnNames = experts.map((m, i) => `${role}_${i}_${ts}`);
  const spawned = [];
  for (let i = 0; i < experts.length; i++) {
    L.spawnAgent(spawnNames[i], {
      dataDir: path.join(agent.dataDir, "legion", spawnNames[i]),
      globalDataDir: agent.globalDataDir,
      // 非只读专家不设 readonly
      env: experts[i].readonly ? { PPX_AGENT_READONLY: "1" } : {},
    });
    spawned.push(spawnNames[i]);
  }
  if (agent.lifecycle) agent.lifecycle.reproduce(experts.length);

  const send = async (i, message) => {
    try {
      const r = await withTimeout(
        L.send(spawnNames[i], { type: "chat", message, perspective: experts[i].perspective || null }, { timeout: DELEGATE_TIMEOUT_MS + 5000 }),
        DELEGATE_TIMEOUT_MS,
        experts[i].name,
      );
      return String(r?.reply || "(无回复)");
    } catch (e) {
      return `[${experts[i].name} 失败] ${e.message}`;
    }
  };

  let feedback = null;
  let final = "";
  for (let round = 1; round <= maxRounds; round++) {
    const parts = [`【任务】${task}`];
    if (feedback) parts.push(`【上一轮监督者反馈】\n${feedback}\n\n请据此修正你的结论。`);
    if (experts) parts.push("请独立给出你的结论与依据。");
    const replies = await Promise.all(experts.map((_, i) => send(i, parts.join("\n\n"))));

    // 监督者评审 (LLM): 返回 {accept, feedback[]}
    const verdict = await supervise(agent, task, experts.map((e) => e.name), replies, judge);
    if (verdict.accept) {
      final = await finalize(agent, task, replies, judge);
      break;
    }
    feedback = (verdict.feedback && verdict.feedback.length)
      ? verdict.feedback.join("\n")
      : "结论不够具体, 请补充可执行的依据";
  }

  const head = ["✅ 监督者编排", `专家: ${experts.map((e) => e.name).join(" · ")}`];
  const body = experts.map((e, i) => `【${e.name}】\n${final ? "" : ""}`);
  return [head.join("\n"), "", final || `(监督者未在 ${maxRounds} 轮内接受, 输出各方原始结论)`, ""].join("\n");
}

// 监督者评审: 用主 agent LLM 评估各专家产出, 返回 {accept, feedback[]}
async function supervise(agent, task, names, replies, judge) {
  const input = names.map((n, i) => `【${n}】\n${String(replies[i]).slice(0, 2000)}`).join("\n\n");
  const system = "你是监督者, 评估各专家子 agent 的结论。若结论充分可直接采用, 否则给出打回反馈。只输出 JSON: {\"accept\": true/false, \"feedback\": [\"...\"]}";
  const user = `【任务】${task}\n\n${input}\n\n【评审准则】${judge || "结论必须具体可执行"}`;
  try {
    const r = await agent.llm.chat([
      { role: "system", content: system },
      { role: "user", content: user.slice(0, 8000) },
    ]);
    const text = String(r?.content || "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const obj = JSON.parse(m[0]);
      return { accept: !!obj.accept, feedback: Array.isArray(obj.feedback) ? obj.feedback : [] };
    }
    return { accept: true, feedback: [] };
  } catch {
    return { accept: true, feedback: [] };
  }
}

// 定稿: 监督者接受后, 用主 agent LLM 综合产出最终结论
async function finalize(agent, task, replies, judge) {
  try {
    const r = await agent.llm.chat([
      { role: "system", content: "你是最终定稿者。综合各专家结论, 给出定稿。" },
      { role: "user", content: `【任务】${task}\n\n${replies.map((x) => String(x).slice(0, 2000)).join("\n\n")}` },
    ]);
    return String(r?.content || "").trim() || "定稿结论: " + replies.join(" / ");
  } catch {
    return "定稿结论: " + replies.join(" / ");
  }
}

/* ======================= 可生长专家: 自动建档 ======================= */

/**
 * 用主 agent 的 LLM 为一个未知领域自动建档专家 (opt-in: config.agent.auto_create_experts)。
 * 契约: 默认关 → null; 无 llm → null; LLM 输出不是合法 JSON → null (走原错误路径, 不硬造)。
 */
export async function autoCreateExpert(agent, query) {
  const cfg = agent?.config?.agent || {};
  if (cfg.auto_create_experts !== true) return null;
  if (!agent?.llm || typeof agent.llm.chat !== "function") return null;
  const q = String(query || "").trim();
  if (!q) return null;
  try {
    const r = await agent.llm.chat([
      {
        role: "system",
        content: "你是专家建档器。根据用户给出的领域, 输出**一个 JSON 对象** (不要代码块、不要解释): "
          + '{"id":"英文短横线标识","name":"中文专家名(≤24字)","domain":"领域","perspective":"分析视角(≤400字)","skills":["技能"]}',
      },
      { role: "user", content: `领域: ${q.slice(0, 200)}` },
    ]);
    // LLM 客户端两种返回形态都要认: 裸字符串 / { content } (与 arbitrate 的取用口径一致地放宽)
    const raw = (typeof r === "string" ? r : String(r?.content ?? r?.message?.content ?? ""))
      .trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(raw); // 坏输出直接抛 → catch → null, 不硬造
    const expert = registerUserExpert(normalizePersona({
      ...parsed,
      perspective: `${parsed.perspective || ""} (自动建档)`,
    }));
    saveUserExperts(agent.dataDir);
    return resolveExpertWithUser(expert.id) || expert;
  } catch {
    return null;
  }
}

// ---- SDD review 循环: 实施 -> 只读审查 -> (修复 -> 复审) * N -> 熔断 ----
// 返回: 通过时 "✅ 审查通过..." + 产出; 熔断时 "⚠️ 未决发现停放..." + 产出
// namePrefix: 多任务 review 时传入 `${role}_${ts}_${i}`, 保证每对 agent 名唯一
async function runReviewLoop({ agent, L, task, perspective, role, judge, fixRounds, namePrefix = null }) {
  const ts = Date.now().toString(36);
  const implName = namePrefix ? `${namePrefix}_impl` : `${role}_impl_${ts}`;
  const revName = namePrefix ? `${namePrefix}_rev` : `${role}_rev_${ts}`;
  const mkOpts = (n) => ({ dataDir: path.join(agent.dataDir, "legion", n), globalDataDir: agent.globalDataDir });
  L.spawnAgent(implName, mkOpts(implName));
  // 审查者只读: PPX_AGENT_READONLY=1 时 worker 禁用全部修改/执行工具
  L.spawnAgent(revName, { ...mkOpts(revName), env: { PPX_AGENT_READONLY: "1" } });
  if (agent.lifecycle) agent.lifecycle.reproduce(2);

  const max = (() => { // v1.0.8: fix_rounds=0 应能设 0 (原 `|| 3` 把 0 变 3)
    const parsed = Number(fixRounds);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 5) : 3;
  })(); // 熔断上限 (Superpowers 5 轮, 默认 3 控成本; 0 = 不修复直接停放)
  const ledger = [];
  let findings = [];
  let result = "";

  // 1. 实施
  try {
    const r = await withTimeout(L.send(implName, { type: "chat", message: task, perspective }, { timeout: DELEGATE_TIMEOUT_MS + 5000 }), DELEGATE_TIMEOUT_MS, "实施");
    result = String(r?.reply || "").trim() || "(实施者无回复)";
  } catch (e) {
    return `[工具错误] spawn_agent(review): 实施失败: ${e.message}`;
  }
  ledger.push({ round: 0, step: "implement" });

  // 2. 审查 + 修复循环
  let round = 0;
  while (true) {
    const reviewText = await (async () => {
      try {
        const r = await withTimeout(L.send(revName, { type: "chat", message: buildReviewPrompt(task, judge, perspective) + `\n\n【产出】\n${result.slice(0, 6000)}`, perspective }, { timeout: DELEGATE_TIMEOUT_MS + 5000 }), DELEGATE_TIMEOUT_MS, "审查");
        return String(r?.reply || "");
      } catch (e) {
        return `[Critical] 审查者不可用: ${e.message}`;
      }
    })();
    findings = parseReviewFindings(reviewText);
    ledger.push({ round, step: "review", findings });
    if (!needsFix(findings)) break;   // 通过
    if (round >= max) break;          // 熔断
    round++;
    try {
      const r = await withTimeout(L.send(implName, { type: "chat", message: buildFixPrompt(task, findings), perspective }, { timeout: DELEGATE_TIMEOUT_MS + 5000 }), DELEGATE_TIMEOUT_MS, `修复第${round}轮`);
      result = String(r?.reply || "").trim() || "(实施者无回复)";
    } catch (e) {
      ledger.push({ round, step: "fix", error: e.message });
      break;
    }
    ledger.push({ round, step: "fix" });
  }

  // 3. 汇总: 通过 or 熔断停放 (账本交主 agent 裁定)
  const open = findings.filter((f) => f.severity === "Critical" || f.severity === "Important");
  if (open.length) {
    return `⚠️ 审查未通过: 达到修复上限 (${max} 轮), 以下 ${open.length} 项未决发现已停放, 请主 agent 裁定是否接受当前产出:\n`
      + open.map((f) => `- [${severityLabel(f.severity)}] ${f.finding}`).join("\n")
      + `\n\n当前产出:\n${result}`;
  }
  const summary = findings.length
    ? findings.map((f) => `[${severityLabel(f.severity)}]`).join(" ")
    : "无";
  return `✅ 审查通过 (审查发现: ${summary})\n\n${result}`;
}

// ---- 军团共享记忆板接入 (2026-10-02) ----
// 子任务结论自动发布到记忆板 (topic=角色), 仲裁前自动读板注入。
// 发布永不阻塞委派: 任何异常吞掉 (记忆板是增强, 不是依赖)。
export function publishToBoard(board, { from, topic, task, reply, status = "完成" }) {
  if (!board) return;
  try {
    board.publish({
      from,
      topic,
      content: `[${status}] 任务: ${String(task).slice(0, 120)} → 结论: ${String(reply).slice(0, 400)}`,
    });
  } catch { /* 记忆板满/IO 异常均不阻塞委派 */ }
}

export function registerDelegateTools(catalog, opts = {}) {
  const board = opts.board || null;
  catalog.register({
    name: "spawn_agent",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "system" },
    description: "派生子 agent 处理子任务并等待结果。适合需要专门角色、并行、或隔离执行的任务 (如数据分析、代码审查、多角度论证)。子 agent 共享全局经验库。支持: 单个 task; 或 tasks 数组并行派发多个子 agent + perspectives 差异化视角; arbitrate=true 时主 agent 仲裁聚合各方结果; review=true 时走 SDD 审查循环: 实施者干活 -> 只读审查者挑问题 -> 修复 -> 复审, 达上限熔断停放交主 agent 裁定 (单任务直接审查; 多任务每个子任务独立一对实施+审查, 可配 arbitrate 聚合)。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "单个子任务描述 (清晰完整, 含上下文); 与 tasks 二选一" },
        tasks: { type: "array", items: { type: "string" }, description: "并行子任务列表 (每个子 agent 一个), 适合多角度论证/并行处理; 与 task 二选一" },
        perspectives: { type: "array", items: { type: "string" }, description: "差异化视角列表, 与 tasks 一一对应, 注入每个子 agent 专属视角 (对抗同质失败), 可缺省" },
        role: { type: "string", description: "子 agent 角色名 (如 数据分析师/代码审查员), 默认 helper" },
        arbitrate: { type: "boolean", description: "是否由主 agent 仲裁聚合所有子结果 (并行/多任务 review 时推荐), 默认 false 直接返回拼接结果" },
        judge: { type: "string", description: "仲裁评审指令 (arbitrate=true 时生效, 如 找出最可靠结论/合并去重); review=true 时为审查准则, 可缺省" },
        review: { type: "boolean", description: "SDD 审查循环: 实施者 -> 只读审查者 -> 发现问题自动修复复审, 达上限熔断, 默认 false。单 task 与多 tasks 均支持" },
        fix_rounds: { type: "number", description: "审查循环最大修复轮数 (review=true 时生效, 默认 3, 上限 5)" },
        share_board: { type: "boolean", description: "子任务结论自动发布到军团共享记忆板 (board_query 可查), 仲裁前主 agent 自动读板。默认 true" },
        expert: { type: "string", description: `固化专家角色 (单任务)。名册: ${listExperts()}。专家自带角色名+专属视角 (只读专家自动禁修改工具)` },
        experts: { type: "array", items: { type: "string" }, description: "每任务一个专家 (与 tasks 一一对应, 优先于 expert)。如 [\"code\",\"design\",\"security\"] 三任务分派代码/设计/安全专家" },
        team: { type: "string", description: `班组名 (整体接管分工, 按班组拓扑编排成员): ${listTeams()}` },
        topology: { type: "string", description: "临时专家组拓扑 (与 experts 同用时生效): pipeline=前环产出喂后环 / parallel=各自产出再仲裁 / debate=正反两方 / review=实施+只读审查" },
      },
    },
    execute: async (args, ctx) => {
      const agent = ctx?.agent;
      if (!agent) return "[工具错误] spawn_agent: 无 agent 上下文";
      // 先校验参数, 再校验环境 (输入校验优先)
      let tasks = null;
      if (Array.isArray(args.tasks) && args.tasks.length) {
        tasks = args.tasks.map((t) => String(t).slice(0, 4000));
      } else if (args.task) {
        tasks = [String(args.task).slice(0, 4000)];
      }
      if (!tasks) return "[工具错误] spawn_agent: 需要 task 或 tasks";
      if (!agent.llm) return "[工具错误] spawn_agent: 主 agent 未配置模型, 无法委派";
      // 懒建军团 (复用已有, 避免重复 spawn 进程)
      let L = agent._legion;
      if (!L) { L = new Legion(); agent._legion = L; }
      // 角色名清洗: 保留中文 (中文向导项目, 侦察兵/分析师等中文角色名是常态), 只洗特殊字符
      const role = String(args.role || "helper").replace(/[^\w\u4e00-\u9fff-]/g, "_").slice(0, 24);

      const perspectives = Array.isArray(args.perspectives) ? args.perspectives.map((p) => String(p)).slice(0, tasks.length) : [];
      // share_board 默认开: 子任务结论自动上板, 仲裁前自动读板 (显式 false 关闭)
      const shareBoard = args.share_board !== false && !!board;

      // 专家名册解析 (2026-10-02): experts 每任务 > expert 全局 > 无专家 (退回 role/perspectives)
      // 未命中的专家键静默降级为无专家, 不炸委派。
      const expertKeys = Array.isArray(args.experts) && args.experts.length
        ? args.experts
        : args.expert ? [args.expert] : [];
      const expertList = tasks.map((_, i) => resolveExpertFor(agent, expertKeys[i] ?? expertKeys[0]));
      const effRoles = tasks.map((_, i) => expertList[i]?.name || role);
      const effPersps = tasks.map((_, i) => perspectives[i] || expertList[i]?.perspective || null);

      const boardTopic = role;

      // 班组模式 (2026-10-07): team 命中名册 → 整体接管分工 (成员/拓扑/只读杠杆全由名册给出)
      if (args.team) {
        const t = resolveTeam(args.team);
        if (t) {
          const members = teamExperts(t);
          const risk = teamRiskProfile(t);
          const { text } = await runTeam({
            agent, L, team: t, members,
            task: tasks.join("\n\n"),
            judge: args.judge,
          });
          const head = [
            `【班组】${t.name}`,
            `拓扑 ${t.topology}`,
            `成员: ${members.map((m) => m.name + (m.readonly ? "(只读)" : "")).join(" · ")}`,
          ];
          // 含高风险域专家 → 明说复核要求, 不把"仅供参考"藏进正文
          if (risk.requiresHuman) {
            head.push(`⚠ 本班组含高风险域专家 (${risk.highRiskMembers.join("、")}): 结论仅供参考, 需人类复核后执行`);
          }
          return [...head, "", text].join("\n");
        }
        // 未知名册班组 → 静默退回普通委派 (不炸)
      }

      // 临时专家组 (experts + topology): 不入班册, 按拓扑把专家排起来
      if (args.topology && expertKeys.length) {
        const members = expertKeys.map((k) => {
          const e = resolveExpertFor(agent, k);
          return e
            ? { name: e.name || String(k), perspective: e.perspective, readonly: !!e.readonly, requiresHuman: !!e.requiresHuman }
            : { name: String(k), perspective: null };
        });
        const { text } = await runTeam({
          agent, L,
          team: { id: "adhoc", name: "临时专家组", topology: args.topology },
          members, task: tasks.join("\n\n"), judge: args.judge,
        });
        return [`【临时专家组】拓扑 ${args.topology}`, `成员: ${members.map((m) => m.name).join(" · ")}`, "", text].join("\n");
      }

      try {
        // SDD review 循环: 实施 -> 审查 -> 修复 -> 熔断
        // 单任务: 直接跑; 多任务: 每个任务独立一对 (实施者+只读审查者), 并行跑, 可仲裁聚合
        if (args.review) {
          const prefix = `${role}_${Date.now().toString(36)}`;
          if (tasks.length === 1) {
            const out = await runReviewLoop({
              agent, L, task: tasks[0],
              perspective: effPersps[0],
              role: effRoles[0], judge: args.judge,
              fixRounds: args.fix_rounds,
              namePrefix: `${prefix}_0`,
            });
            publishToBoard(board, { from: `${effRoles[0]}_impl`, topic: boardTopic, task: tasks[0], reply: out, status: out.startsWith("✅") ? "完成" : "熔断停放" });
            return out;
          }
          // 多任务: 并行各任务 review, 各自独立 (agent 名唯一, 不冲突)
          const settled = await Promise.all(tasks.map(async (task, i) => {
            try {
              const out = await runReviewLoop({
                agent, L, task,
                perspective: effPersps[i],
                role: effRoles[i], judge: args.judge,
                fixRounds: args.fix_rounds,
                namePrefix: `${prefix}_${i}`,
              });
              publishToBoard(board, { from: `${effRoles[i]}_${i}_impl`, topic: boardTopic, task, reply: out, status: out.startsWith("✅") ? "完成" : "熔断停放" });
              return out;
            } catch (e) {
              return `[子任务${i + 1} review 失败] ${e.message}`;
            }
          }));
          if (args.arbitrate) {
            return await arbitrateWithBoard(agent, tasks, settled, perspectives, args.judge, { board, shareBoard, boardTopic });
          }
          return tasks.map((t, i) => {
            const p = perspectives?.[i] || expertList[i] ? ` (${expertList[i]?.name || ""}${perspectives[i] ? "·" + perspectives[i] : ""})` : "";
            return `【子任务${i + 1}${p}】${t}\n${settled[i]}`;
          }).join("\n\n");
        }
        // ---- supervisor: 监督者编排循环 (2026-10-10 补齐) ----
        // 监督者 LLM 评审各专家产出 → 打回则带着反馈再派发一轮 → 接受则定稿。
        if (args.supervisor) {
          const out = await runSupervisorLoop({
            agent, L, task: tasks.join("\n\n"), judge: args.judge,
            expertKeys, role,
          });
          return out;
        }

        // 并行 spawn 子 agent: 每个独立数据目录 + 独立视角; 只读专家 spawn 时禁修改工具。
        // 委派权限交集 (2026-10-05): 子进程 env = 父生效档位 ∩ 本次请求的只读要求。
        //   父侧只读/锁死/会话处于计划态 → 子必挂 PPX_AGENT_READONLY=1 (旧缺陷: 子比父宽)。
        const names = tasks.map((_, i) => `${effRoles[i]}_${i}_${Date.now().toString(36)}`);
        const sessionKey = currentTrace()?.sessionKey || "default";
        const parentProfile = profileFromEngine(agent.permissions, {
          planEnabled: (typeof agent.isPlanMode === "function" ? agent.isPlanMode(sessionKey) : false)
            || agent.permissions?.planEnabled === true,
        });
        try {
          for (let i = 0; i < names.length; i++) {
            L.spawnAgent(names[i], {
              dataDir: path.join(agent.dataDir, "legion", names[i]),
              globalDataDir: agent.globalDataDir,
              env: childSpawnEnv(parentProfile, !!expertList[i]?.readonly),
            });
          }
          // 生命周期: 繁衍计数 (ANS: reproducing)
          if (agent.lifecycle) agent.lifecycle.reproduce(names.length);

          // 并行派发, 全部等结果 (各自独立超时)
          const settled = await Promise.all(tasks.map(async (task, i) => {
            try {
              const reply = await withTimeout(
                L.send(names[i], { type: "chat", message: task, perspective: effPersps[i] }, { timeout: DELEGATE_TIMEOUT_MS + 5000 }),
                DELEGATE_TIMEOUT_MS,
                `子任务${i + 1}`
              );
              return { ok: true, reply: reply.reply || "(子 agent 无回复)" };
            } catch (e) {
              return { ok: false, reply: `[子任务${i + 1}失败] ${e.message}` };
            }
          }));
          const results = settled.map((s) => s.reply);

          // share_board: 每个子任务结论自动上板 (成功/失败都记, 状态区分)
          if (shareBoard) {
            settled.forEach((s, i) => {
              publishToBoard(board, { from: names[i], topic: boardTopic, task: tasks[i], reply: s.reply, status: s.ok ? "完成" : "失败" });
            });
          }

          // 单任务: 保持旧行为, 直接返回子 agent 回复
          if (tasks.length === 1) return results[0];

          // 多任务: 有 arbitrate 走主 agent 仲裁聚合, 否则拼接各方结果
          if (args.arbitrate) {
            const out = await arbitrateWithBoard(agent, tasks, results, perspectives, args.judge, { board, shareBoard, boardTopic });
            return out;
          }
          return tasks.map((t, i) => {
            const p = perspectives?.[i] || expertList[i] ? ` (${expertList[i]?.name || ""}${perspectives[i] ? "·" + perspectives[i] : ""})` : "";
            return `【子任务${i + 1}${p}】${t}\n${results[i]}`;
          }).join("\n\n");
        } finally {
          // 生命周期回收 (L1, 2026-10-10): 本轮派生的每个子进程都必须回收 ——
          //   放在 finally 里, 成功/失败/异常三条路径都走到, 不靠成功分支。
          //   回收失败不掩盖真实结果 (逐个 settle, 不抛出)。
          await Promise.allSettled(names.map((n) => (typeof L.killAgent === "function" ? L.killAgent(n) : null)));
        }
      } catch (e) {
        return `[工具错误] spawn_agent: ${e.message}`;
      }
    },
  });
}
