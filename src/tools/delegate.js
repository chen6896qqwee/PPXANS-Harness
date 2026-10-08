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
import { runSupervisor } from "../orchestrator/supervisor.js"; // 2026-10-03 接线
import { resolveExpert, HIGH_RISK_DOMAINS } from "../orchestrator/experts.js";
// 专家/班组名册不再内联进工具描述 (实测 spawn_agent schema 曾占 1338 tok): 名册改由
// expert_list / team_list 工具按需给出, 描述里只留"去查哪个工具"。
import { resolveTeam, teamExperts } from "../orchestrator/teams.js";
import { getGovernor, governorOptsFromConfig } from "../orchestrator/governor.js";
import { withTimeout } from "../utils/async.js";
import { currentTrace } from "../core/trace.js";
import { debug } from "../utils/logger.js";
// Codex 权限交集不变量 (2026-10-05 吸收): 子 agent 生效档位 = 请求档位 ∩ 父生效档位,
// 只准变窄, 不准变宽; 解析不了的输入终止交集并全锁死 (失败关闭)。
import { SandboxPolicy } from "../permissions/index.js";
import { profileFromEngine, intersectPermissionProfiles, childSpawnEnv } from "../permissions/intersection.js";

// 子任务超时 (2026-10-07): 从硬编码常量改为可配置 (agent.legion.delegate_timeout_ms), 兜底保持旧值
const DELEGATE_TIMEOUT_MS = 120000; // 子任务最长等待 (防卡死主 agent 工具循环)
export function delegateTimeoutMs(agent) {
  const n = Number(agent?.config?.agent?.legion?.delegate_timeout_ms);
  return Number.isFinite(n) && n > 0 ? n : DELEGATE_TIMEOUT_MS;
}

// 专家解析 (2026-10-07 吸收 Octop 后统一入口): 代码内置名册优先, 专家包兜底。
//   顺序刻意如此 —— EXPERTS 的 id 是既有契约 (测试与文档都引用), 不能被同名专家包悄悄顶掉;
//   专家包补的是"名册之外、可分发可增长"的那部分 (用户自己装/导入的专家)。
function resolveAnyExpert(agent, key) {
  if (!key) return null;
  const e = resolveExpert(key);
  if (e) return e;
  const packs = agent?.expertPacks;
  if (packs && typeof packs.resolve === "function") {
    const p = packs.resolve(key);
    if (p) {
      return {
        name: p.label,
        // 专家包的人格块直接作为视角注入 (骨架 + SOUL + 可选 MBTI), 比一句 perspective 厚得多
        perspective: packs.personaOf(p.id, {
          agentName: agent?.config?.agent?.name || "皮皮虾",
          userDisplay: agent?.userName || "兄弟",
          withAgents: true,
        }) || p.perspective,
        readonly: !!p.readonly,
        requiresHuman: !!p.requiresHuman,
        domain: p.domain,
        skills: p.skills,
        packId: p.id,
      };
    }
  }
  return null;
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

// ---- SDD review 循环: 实施 -> 只读审查 -> (修复 -> 复审) * N -> 熔断 ----
// 返回: 通过时 "✅ 审查通过..." + 产出; 熔断时 "⚠️ 未决发现停放..." + 产出
// namePrefix: 多任务 review 时传入 `${role}_${ts}_${i}`, 保证每对 agent 名唯一
async function runReviewLoop({ agent, L, task, perspective, role, judge, fixRounds, namePrefix = null, track = null, envFor = null, timeoutMs = DELEGATE_TIMEOUT_MS }) {
  const ts = Date.now().toString(36);
  const implName = namePrefix ? `${namePrefix}_impl` : `${role}_impl_${ts}`;
  const revName = namePrefix ? `${namePrefix}_rev` : `${role}_rev_${ts}`;
  const mkOpts = (n) => ({ dataDir: path.join(agent.dataDir, "legion", n), globalDataDir: agent.globalDataDir });
  // envFor: 交集结论 → worker env (缺省时保持旧口径: 仅审查者挂只读杠杆)
  const envOf = (ro) => (envFor ? envFor(ro) : ro ? { PPX_AGENT_READONLY: "1" } : {});
  // 受治理批量 spawn (有 spawnAgents 时): 两个子进程一起排队拿槽位, 而不是绕过并发上限直接 spawn
  if (typeof L.spawnAgents === "function") {
    await L.spawnAgents([
      { name: implName, opts: { ...mkOpts(implName), env: envOf(false) } },
      { name: revName, opts: { ...mkOpts(revName), env: envOf(true) } },
    ]);
  } else {
    L.spawnAgent(implName, { ...mkOpts(implName), env: envOf(false) });
    // 审查者只读: PPX_AGENT_READONLY=1 时 worker 禁用全部修改/执行工具
    L.spawnAgent(revName, { ...mkOpts(revName), env: envOf(true) });
  }
  if (track) { track(implName); track(revName); }
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
    const r = await withTimeout(L.send(implName, { type: "chat", message: task, perspective }, { timeout: timeoutMs + 5000 }), timeoutMs, "实施");
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
        const r = await withTimeout(L.send(revName, { type: "chat", message: buildReviewPrompt(task, judge, perspective) + `\n\n【产出】\n${result.slice(0, 6000)}`, perspective }, { timeout: timeoutMs + 5000 }), timeoutMs, "审查");
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
      const r = await withTimeout(L.send(implName, { type: "chat", message: buildFixPrompt(task, findings), perspective }, { timeout: timeoutMs + 5000 }), timeoutMs, `修复第${round}轮`);
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

// ---- 班组编排 (2026-10-07): 拓扑决定"成员之间怎么协作", 而不是"谁参与" ----
// 返回 { text, spawnNames } —— 调用方负责回收 spawnNames。
export async function runTeam({ agent, L, team, members, task, timeoutMs = DELEGATE_TIMEOUT_MS, envFor = null, onSpawn = null }) {
  const names = [];
  const ts = Date.now().toString(36);
  const spawn = async (list) => {
    const specs = list.map((m, i) => ({
      name: `${m.name}_${team.id}_${ts}_${i}`,
      opts: {
        dataDir: path.join(agent.dataDir, "legion", `${m.name}_${team.id}_${ts}_${i}`),
        globalDataDir: agent.globalDataDir,
        // 只读专家 → 只读杠杆 (与权限交集结论一致: 只准变窄)
        env: envFor ? envFor(!!m.readonly) : (m.readonly ? { PPX_AGENT_READONLY: "1" } : {}),
      },
    }));
    if (typeof L.spawnAgents === "function") await L.spawnAgents(specs);
    else for (const s of specs) L.spawnAgent(s.name, s.opts);
    for (const s of specs) { names.push(s.name); onSpawn?.(s.name); }
    return specs.map((s) => s.name);
  };
  const ask = (name, message, perspective, label) =>
    withTimeout(L.send(name, { type: "chat", message, perspective }, { timeout: timeoutMs + 5000 }), timeoutMs, label)
      .then((r) => String(r?.reply || "").trim() || "(无回复)")
      .catch((e) => `[失败] ${e.message}`);

  const topology = team.topology || "parallel";
  let text = "";

  if (topology === "pipeline") {
    // 流水线: 前一环产出即后一环输入 (强顺序依赖, 不并行)
    const order = await spawn(members);
    let carry = `【任务】${task}`;
    const steps = [];
    for (let i = 0; i < members.length; i++) {
      const out = await ask(order[i], `${carry}\n\n【你的角色】${members[i].name}`, members[i].perspective, `流水线→${members[i].name}`);
      steps.push(`【${members[i].name}】\n${out}`);
      carry = `【任务】${task}\n\n【上一环 (${members[i].name}) 的产出】\n${out}\n\n请在此基础上继续推进, 不要重复上一环已完成的工作。`;
    }
    text = steps.join("\n\n");
  } else if (topology === "review") {
    // 实施 + 只读审查: 复用 SDD 循环 (实施者取首个非只读成员, 审查者取首个只读成员)
    const impl = members.find((m) => !m.readonly) || members[0];
    const rev = members.find((m) => m.readonly && m !== impl) || members[1] || members[0];
    const order = await spawn([impl, rev]);
    const implOut = await ask(order[0], task, impl.perspective, `实施→${impl.name}`);
    const revOut = await ask(order[1], buildReviewPrompt(task, "", rev.perspective) + `\n\n【产出】\n${implOut.slice(0, 6000)}`, rev.perspective, `审查→${rev.name}`);
    const findings = parseReviewFindings(revOut);
    text = findings.length && needsFix(findings)
      ? `⚠️ 审查发现问题 (未自动修复, 单轮模式):\n${findings.map((f) => `- [${severityLabel(f.severity)}] ${f.finding}`).join("\n")}\n\n【${impl.name} 产出】\n${implOut}`
      : `✅ 审查通过\n\n【${impl.name} 产出】\n${implOut}`;
  } else if (topology === "supervisor") {
    const order = await spawn(members);
    const out = await runSupervisor({
      legion: L,
      agents: order,
      task,
      judge: "",
      llm: agent.auxLLM || agent.llm,
      maxRounds: 3,
      timeoutMs,
    });
    text = (out.divergent
      ? `⚠️ 监督者编排 (${out.rounds} 轮, 一致率 ${(out.consensus * 100).toFixed(0)}%): 仍有分歧`
      : `✅ 监督者编排 (${out.rounds} 轮, 一致率 ${(out.consensus * 100).toFixed(0)}%):`)
      + `\n\n${out.answer}`;
  } else if (topology === "debate") {
    // 对抗论证: 成员按序分正反两方, 强制把反方论据摆上台面
    const half = Math.max(1, Math.ceil(members.length / 2));
    const sides = members.map((m, i) => ({ ...m, side: i < half ? "正方" : "反方" }));
    const order = await spawn(sides);
    const outs = await Promise.all(sides.map((m, i) =>
      ask(order[i], `${task}\n\n【立场】你是${m.side}: 请为该立场给出最强论据、关键假设与反证条件。必须指出对方立场最可能对的地方。`, m.perspective, `对抗→${m.name}`)
    ));
    const body = sides.map((m, i) => `【${m.side}·${m.name}】\n${outs[i]}`).join("\n\n");
    const verdict = await arbitrate(agent, sides.map((m) => `${task} (${m.side})`), outs, sides.map((m) => m.perspective), "对比正反论据, 指出各自的成立条件与不成立条件, 给出在有条件前提下的结论; 若证据不足以判定, 明确说不足以判定。");
    text = `${body}\n\n【仲裁】\n${verdict}`;
  } else {
    // parallel: 各自独立产出, 再仲裁整合 (不仲裁就是拼接)
    const order = await spawn(members);
    const settled = await Promise.all(members.map((m, i) => ask(order[i], task, m.perspective, `并行→${m.name}`)));
    const body = members.map((m, i) => `【${m.name}】\n${settled[i]}`).join("\n\n");
    const merged = await arbitrate(agent, members.map((m) => task), settled, members.map((m) => m.perspective),
      `整合 ${team.name} 各专家的结果: 合并重复、标注冲突、给出结论。`);
    text = `${merged}\n\n— 各方原始产出 —\n${body}`;
  }
  return { text, spawnNames: names };
}

export function registerDelegateTools(catalog, opts = {}) {
  const board = opts.board || null;
  catalog.register({
    name: "spawn_agent",
    // F1 定档: medium + 非只读。子 agent 会起 legion 子进程并自主用工具 (含写盘),
    // 所以绝不能算只读 —— 旧兜底把它报成 readOnly:true, plan 模式与「只读巡检」都能
    // 静默派生一批能干活的 agent。没定 high 是有意保留既有协作链路: 默认 workspace-write
    // 模式下委派仍直通 (与今天一致), 收紧到 ask 的只有 plan / 只读档位。
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "subprocess+llm" },
    description: "派生子 agent 干子任务并等结果。适合需要专门角色、并行、或多视角对抗/隔离执行的活。子 agent 共享全局经验库。可用 team 点名班组 (推荐), 或用 experts 点几个专家; arbitrate=true 由主 agent 仲裁聚合; review=true 走实施+只读审查循环; supervisor=true 走多专家收敛循环。派发前用 legion_status 查并发上限。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "单个子任务 (与 tasks 二选一)" },
        tasks: { type: "array", items: { type: "string" }, description: "并行子任务列表 (每个子 agent 一个)" },
        perspectives: { type: "array", items: { type: "string" }, description: "与 tasks 一一对应的差异化视角 (对抗同质失败)" },
        team: { type: "string", description: "专家班组 (优先于 expert/experts/supervisor/review)。班组自带成员与协作拓扑。可用值见 team_list 工具; 也接受中文名 (研发/调研/数据/内容/办公/商业/评审/生活/对抗)" },
        role: { type: "string", description: "子 agent 角色名, 默认 helper" },
        arbitrate: { type: "boolean", description: "由主 agent 仲裁聚合各方结果 (多任务时推荐)" },
        judge: { type: "string", description: "仲裁评审指令; review=true 时作审查准则" },
        review: { type: "boolean", description: "SDD 循环: 实施 → 只读审查 → 发现问题自动修复复审 → 达上限熔断停放" },
        fix_rounds: { type: "number", description: "修复/收敛最大轮数 (默认 3, 上限 5)" },
        share_board: { type: "boolean", description: "结论发布到军团共享记忆板 (默认 true)" },
        expert: { type: "string", description: "单个固化专家角色 (见 expert_list 工具; 只读专家自动禁修改工具)" },
        experts: { type: "array", items: { type: "string" }, description: "每任务一个专家 (与 tasks 一一对应); supervisor=true 时作编排专家名册" },
        supervisor: { type: "boolean", description: "多专家并行 → 分歧检测 → 评审打回 → 定稿收敛循环" },
        topology: { type: "string", enum: ["parallel", "supervisor", "debate", "pipeline", "review"], description: "与 experts 连用: 覆盖默认并行拓扑 (pipeline 按依赖顺序传, debate 前半为一方)" },
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
      // 并发治理 (2026-10-07): 每次委派前把配置同步进进程级治理器 —— 用户改完配置不必重启进程,
      // 而并发上限对**所有** Legion 实例 (含嵌套委派懒建的) 统一生效。
      const governor = L.governor || getGovernor();
      try { governor.configure(governorOptsFromConfig(agent.config, agent.dataDir || null)); }
      catch (e) { debug(`[delegate] 治理器参数同步失败 (沿用旧值): ${e && e.message ? e.message : e}`); }
      const timeoutMs = delegateTimeoutMs(agent);
      // ---- Codex 权限交集不变量 (2026-10-05 吸收) ----
      // 子 agent 的生效权限 = 请求档位 ∩ 父生效档位, 只准变窄不准变宽。
      // ppx worker 是独立进程, spawn 前唯一既有的收紧杠杆是 agent-worker.js 里的
      // PPX_AGENT_READONLY env (命中即 enableReadonlyMode) —— 交集结论统一落到这根杠杆上:
      //   结果只读/锁死/plan → 挂上杠杆; 无收紧 → env 保持今天的样子 ({} 或原只读标记)。
      // 无权限引擎 (老测试桩 agent) 时保持旧口径, 单 agent (无委派) 路径完全不变。
      const parentProfile = agent.permissions
        ? profileFromEngine(agent.permissions, {
            planEnabled: typeof agent.isPlanMode === "function"
              ? agent.isPlanMode(currentTrace()?.sessionKey || "default")
              : undefined,
          })
        : null;
      const envFor = (wantReadOnly) => {
        if (!parentProfile) return wantReadOnly ? { PPX_AGENT_READONLY: "1" } : {};
        const requested = wantReadOnly
          ? { ...parentProfile, sandbox: SandboxPolicy.READ_ONLY }
          : parentProfile; // 实现者默认请求与父同档: 交集幂等 → 与今天零差异
        return childSpawnEnv(intersectPermissionProfiles(parentProfile, requested), wantReadOnly);
      };
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
      const expertList = tasks.map((_, i) => resolveAnyExpert(agent, expertKeys[i] ?? expertKeys[0]));
      const effRoles = tasks.map((_, i) => expertList[i]?.name || role);
      const effPersps = tasks.map((_, i) => perspectives[i] || expertList[i]?.perspective || null);

      // ---- 班组解析 (2026-10-07): team 指定后,**班组定义整体接管**分工与拓扑 ----
      // 优先级: team > experts/expert > role/perspectives。班组是比"点几个专家"更高层的组织单位,
      // 用户点名班组时不该被零散的 experts 参数部分覆盖 (混着给只会产出无法解释的分工)。
      const team = args.team ? resolveTeam(args.team) : null;
      const teamMembers = team ? teamExperts(team) : [];
      // 风险画像: 全员只读 / 含高风险域 → 产出必须标人类复核
      const teamHighRisk = teamMembers.filter((m) => m.requiresHuman || HIGH_RISK_DOMAINS.includes(m.domain));
      const teamAllReadonly = teamMembers.length > 0 && teamMembers.every((m) => m.readonly);

      const boardTopic = role;
      // 本轮委派新建的子进程名 (2026-10-04): 委派名带时间戳 ⇒ 每次调用都是全新进程, 军团不会复用。
      //   统一在 finally 回收, 否则 ppx-serve / taskbench 这类长跑进程里子进程只增不减。
      const spawned = [];
      const track = (n) => { spawned.push(n); };

      try {
        // ---- 班组编排 (2026-10-07, 优先于其余模式): 一次点名 = 一组角色 + 一套收敛机制 ----
        // 班组自带拓扑与成员, 因此会整体接管 supervisor/review 等单点开关 —— 两者同时给会让
        // 分工变得无法解释 (到底按班组还是按 experts?), 这里明确: 班组赢。
        if (team) {
          if (!teamMembers.length) return `[工具错误] spawn_agent: 班组 ${team.id} 成员名册为空`;
          const { text: teamOut, spawnNames } = await runTeam({
            agent, L, team, members: teamMembers, task: tasks[0],
            timeoutMs, envFor, onSpawn: track,
          });
          if (agent.lifecycle) agent.lifecycle.reproduce(spawnNames.length);
          for (const n of spawnNames) {
            publishToBoard(board, { from: n, topic: team.id, task: tasks[0], reply: teamOut, status: "完成" });
          }
          // 高风险班组 (含医疗/法律/金融/安全/合规专家): 产出只是人类决策的输入
          const riskNote = teamHighRisk.length
            ? `\n\n⚠ 本班组含高风险域专家 (${teamHighRisk.map((m) => m.name).join("、")}),`
              + `${teamAllReadonly ? "且全程只读" : "其产出仅供分析参考"} —— 需人类复核后执行。`
            : "";
          return `【班组】${team.name} · 拓扑 ${team.topology} · 成员 ${teamMembers.map((m) => m.name).join("/")}\n\n${teamOut}${riskNote}`;
        }

        // experts + topology: 用专家列表临时组一个班组 (不落名册, 只借拓扑与收敛机制)。
        // 与 team 的区别: team 是名册里的固定班组, 这里是"临时点几个专家 + 指定协作形状"。
        if (args.topology && !args.supervisor && !args.review) {
          // 取参口径: 显式给的 experts 数组优先 (单任务也能点多个专家), 否则退回按任务解析的结果
          const keys = Array.isArray(args.experts) && args.experts.length ? args.experts : expertKeys;
          const picked = keys
            .map((k, i) => { const e = resolveAnyExpert(agent, k); return e ? { ...e, id: `${e.name}#${i}` } : null; })
            .filter(Boolean);
          if (picked.length >= 2) {
            const adhoc = { id: "adhoc", name: "临时专家组", topology: args.topology === "review" ? "review" : args.topology };
            const { text: out, spawnNames } = await runTeam({
              agent, L, team: adhoc, members: picked, task: tasks[0], timeoutMs, envFor, onSpawn: track,
            });
            if (agent.lifecycle) agent.lifecycle.reproduce(spawnNames.length);
            return `【临时专家组】拓扑 ${adhoc.topology} · 成员 ${picked.map((m) => m.name).join("/")}\n\n${out}`;
          }
        }

        // 监督者编排循环 (2026-10-03 接线, runSupervisor 首个产品入口):
        // 同一任务 → 多专家并行 → 分歧检测 → 监督者评审 (接受/打回带反馈) → 定稿。默认 2 专家。
        if (args.supervisor) {
          const nExperts = Math.min(4, Math.max(2,
            (Array.isArray(args.experts) && args.experts.length) || perspectives.length || 2));
          const ts = Date.now().toString(36);
          const names = [];
          for (let i = 0; i < nExperts; i++) {
            const nm = `${effRoles[i] || role}_sup_${ts}_${i}`;
            const opts = { dataDir: path.join(agent.dataDir, "legion", nm), globalDataDir: agent.globalDataDir };
            opts.env = envFor(!!expertList[i]?.readonly); // 交集结论 (只读专家防线对齐 review 循环)
            L.spawnAgent(nm, opts);
            names.push(nm);
            track(nm);
          }
          if (agent.lifecycle) agent.lifecycle.reproduce(nExperts);
          const out = await runSupervisor({
            legion: L,
            agents: names,
            task: tasks[0],
            judge: args.judge || "",
            llm: agent.auxLLM || agent.llm,
            maxRounds: (() => { const n = Number(args.fix_rounds); return Number.isFinite(n) ? Math.min(Math.max(n, 1), 5) : 3; })(),
            timeoutMs,
          });
          const head = out.divergent
            ? `⚠️ 监督者编排 (${out.rounds} 轮, 一致率 ${(out.consensus * 100).toFixed(0)}%): 达轮数上限仍有分歧, 各方结论如下`
            : `✅ 监督者编排 (${out.rounds} 轮, 一致率 ${(out.consensus * 100).toFixed(0)}%):`;
          return `${head}\n\n${out.answer}`;
        }

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
              track,
              envFor,
              timeoutMs,
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
                track,
                envFor,
                timeoutMs,
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
        // 并行 spawn 子 agent: 每个独立数据目录 + 独立视角; 只读专家 spawn 时禁修改工具
        // 2026-10-07: 改走 Legion.spawnAgents (受并发治理器约束, 排队而非无限 spawn);
        //   桩对象/无治理器场景回落到逐个体 spawnAgent (老测试与老调用方零差异)。
        const names = tasks.map((_, i) => `${effRoles[i]}_${i}_${Date.now().toString(36)}`);
        if (typeof L.spawnAgents === "function") {
          await L.spawnAgents(names.map((n, i) => ({
            name: n,
            opts: {
              dataDir: path.join(agent.dataDir, "legion", n),
              globalDataDir: agent.globalDataDir,
              env: envFor(!!expertList[i]?.readonly),
            },
          })));
          for (const n of names) track(n);
        } else {
          for (let i = 0; i < names.length; i++) {
            track(names[i]);
            L.spawnAgent(names[i], {
              dataDir: path.join(agent.dataDir, "legion", names[i]),
              globalDataDir: agent.globalDataDir,
              env: envFor(!!expertList[i]?.readonly),
            });
          }
        }
        // 生命周期: 繁衍计数 (ANS: reproducing)
        if (agent.lifecycle) agent.lifecycle.reproduce(names.length);

        // 并行派发, 全部等结果 (各自独立超时)
        const settled = await Promise.all(tasks.map(async (task, i) => {
          try {
            const reply = await withTimeout(
              L.send(names[i], { type: "chat", message: task, perspective: effPersps[i] }, { timeout: timeoutMs + 5000 }),
              timeoutMs,
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
      } catch (e) {
        return `[工具错误] spawn_agent: ${e.message}`;
      } finally {
        // 回收本轮子进程 (2026-10-04): 成功/失败/提前返回都要收, 并行 kill 不串行等宽限期。
        //   测试与调用方可能注入不含 killAgent 的军团桩, 故先探方法再调。
        if (spawned.length && typeof L.killAgent === "function") {
          await Promise.all(spawned.map((n) => Promise.resolve(L.killAgent(n)).catch(() => false)));
        }
      }
    },
  });
}
