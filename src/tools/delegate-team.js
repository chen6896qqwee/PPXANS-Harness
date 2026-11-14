// src/tools/delegate-team.js - 多 agent 协作 · 编排流组 (2026-11-03 从 delegate.js 拆出)
// 职责: 委派的全部执行流 —— 专家解析 (resolveExpertFor) / 仲裁 (arbitrate*) / 班组拓扑编排
//   (runTeam) / 监督者循环 (runSupervisorLoop) / SDD review 循环 (runReviewLoop) / 记忆板发布。
// 纯函数 (提示词/解析) 在 delegate-review.js, 工具注册面 (spawn_agent 的 schema 与 execute)
//   在 delegate.js。本模块不 import delegate.js (无环); DELEGATE_TIMEOUT_MS 是编排的
//   子任务等待常量, 随编排流住在这里, 宿主注册面经重导出引用。
import path from "node:path";
import { resolveExpert, resolveExpertWithUser } from "../orchestrator/experts.js";
import { withTimeout } from "../utils/async.js";
import { currentTrace } from "../core/trace.js";
import { beginWorkerRun } from "../flow/router.js";
import { buildReviewPrompt, buildFixPrompt, parseReviewFindings, needsFix, severityLabel } from "./delegate-review.js";

export const DELEGATE_TIMEOUT_MS = 120000; // 子任务最长等待 (防卡死主 agent 工具循环)

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
    const sessionKey = currentTrace()?.sessionKey || "default";
    // 高级编排此前只在 spawn_agent 入口记一条决策事件; 这里给每次派发补工单 + dispatch/report,
    //   让 team/topology 与直派路径在 /work 与审计链上同源可查。
    const run = beginWorkerRun(agent, {
      task: message, worker: spawnNames[i], role: who,
      expert: list[i].id || null, sessionKey,
    });
    const startedAt = Date.now();
    try {
      const r = await withTimeout(
        L.send(spawnNames[i], {
          type: "chat", message, perspective: list[i].perspective || null,
          ticketId: run.ticketId, assignmentId: run.assignmentId,
        }, { timeout: DELEGATE_TIMEOUT_MS + 5000 }),
        DELEGATE_TIMEOUT_MS,
        who,
      );
      run.finish({
        ok: true, envelope: r?.envelope || null, reply: String(r?.reply || ""),
        durationMs: Date.now() - startedAt,
      });
      return String(r?.reply || "(无回复)");
    } catch (e) {
      run.finish({ ok: false, errorKind: "worker_error", durationMs: Date.now() - startedAt });
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
  // (进程级 supervisor 拓扑已随 orchestrator/supervisor.js 于 2026-11-08 精简移除, 评审语义由本文件 arbitrate 承载)
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
    const sessionKey = currentTrace()?.sessionKey || "default";
    const run = beginWorkerRun(agent, {
      task: message, worker: spawnNames[i], role: experts[i].name,
      expert: experts[i].id || null, sessionKey,
    });
    const startedAt = Date.now();
    try {
      const r = await withTimeout(
        L.send(spawnNames[i], {
          type: "chat", message, perspective: experts[i].perspective || null,
          ticketId: run.ticketId, assignmentId: run.assignmentId,
        }, { timeout: DELEGATE_TIMEOUT_MS + 5000 }),
        DELEGATE_TIMEOUT_MS,
        experts[i].name,
      );
      run.finish({
        ok: true, envelope: r?.envelope || null, reply: String(r?.reply || ""),
        durationMs: Date.now() - startedAt,
      });
      return String(r?.reply || "(无回复)");
    } catch (e) {
      run.finish({ ok: false, errorKind: "worker_error", durationMs: Date.now() - startedAt });
      return `[${experts[i].name} 失败] ${e.message}`;
    }
  };

  let feedback = null;
  let final = "";
  let lastReplies = [];
  for (let round = 1; round <= maxRounds; round++) {
    const parts = [`【任务】${task}`];
    if (feedback) parts.push(`【上一轮监督者反馈】\n${feedback}\n\n请据此修正你的结论。`);
    if (experts) parts.push("请独立给出你的结论与依据。");
    const replies = await Promise.all(experts.map((_, i) => send(i, parts.join("\n\n"))));
    lastReplies = replies;

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
  // 2026-10-25 修复 (评估报告 P2): 超轮时原实现只回一句占位语 —— 各专家的原始结论
  //   被整轮丢弃 (line 旧 `body` 变量算了不用), 与返回文案"输出各方原始结论"的承诺相悖。
  //   现在超轮时把最后一轮各方结论如实带回 (各截 2000 字), 交主 agent/用户裁定。
  if (final) return [head.join("\n"), "", final].join("\n");
  const body = experts
    .map((e, i) => `【${e.name}】\n${String(lastReplies[i] ?? "(无回复)").slice(0, 2000)}`)
    .join("\n\n");
  return [head.join("\n"), "", `⚠️ 监督者未在 ${maxRounds} 轮内接受, 各方最后一轮原始结论如下 (供裁定):`, "", body].join("\n");
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

// ---- SDD review 循环: 实施 -> 只读审查 -> (修复 -> 复审) * N -> 熔断 ----
// 返回: 通过时 "✅ 审查通过..." + 产出; 熔断时 "⚠️ 未决发现停放..." + 产出
// namePrefix: 多任务 review 时传入 `${role}_${ts}_${i}`, 保证每对 agent 名唯一
// (原为 delegate.js 内的私有函数; 拆分后经本模块导出供注册面引用, 对外入口不变)
export async function runReviewLoop({ agent, L, task, perspective, role, judge, fixRounds, namePrefix = null }) {
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

  // 每次 send 都是一次可查的分派: 工单 + dispatch/report (与 runTeam 同口径)。
  const runSend = async ({ worker, role: workerRole, message, perspective, label }) => {
    const sessionKey = currentTrace()?.sessionKey || "default";
    const run = beginWorkerRun(agent, { task: message, worker, role: workerRole, sessionKey });
    const startedAt = Date.now();
    try {
      const r = await withTimeout(
        L.send(worker, {
          type: "chat", message, perspective,
          ticketId: run.ticketId, assignmentId: run.assignmentId,
        }, { timeout: DELEGATE_TIMEOUT_MS + 5000 }),
        DELEGATE_TIMEOUT_MS,
        label,
      );
      run.finish({
        ok: true, envelope: r?.envelope || null, reply: String(r?.reply || ""),
        durationMs: Date.now() - startedAt,
      });
      return { ok: true, r };
    } catch (e) {
      run.finish({ ok: false, errorKind: "worker_error", durationMs: Date.now() - startedAt });
      return { ok: false, error: e };
    }
  };

  // 1. 实施
  {
    const impl = await runSend({ worker: implName, role: `${role}:impl`, message: task, perspective, label: "实施" });
    if (!impl.ok) return `[工具错误] spawn_agent(review): 实施失败: ${impl.error.message}`;
    result = String(impl.r?.reply || "").trim() || "(实施者无回复)";
  }
  ledger.push({ round: 0, step: "implement" });

  // 2. 审查 + 修复循环
  let round = 0;
  while (true) {
    const reviewText = await (async () => {
      const rev = await runSend({
        worker: revName, role: `${role}:review`,
        message: buildReviewPrompt(task, judge, perspective) + `\n\n【产出】\n${result.slice(0, 6000)}`,
        perspective, label: "审查",
      });
      return rev.ok ? String(rev.r?.reply || "") : `[Critical] 审查者不可用: ${rev.error.message}`;
    })();
    findings = parseReviewFindings(reviewText);
    ledger.push({ round, step: "review", findings });
    if (!needsFix(findings)) break;   // 通过
    if (round >= max) break;          // 熔断
    round++;
    {
      const fix = await runSend({
        worker: implName, role: `${role}:impl`,
        message: buildFixPrompt(task, findings), perspective, label: `修复第${round}轮`,
      });
      if (!fix.ok) {
        ledger.push({ round, step: "fix", error: fix.error.message });
        break;
      }
      result = String(fix.r?.reply || "").trim() || "(实施者无回复)";
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
