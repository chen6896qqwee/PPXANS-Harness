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

const DELEGATE_TIMEOUT_MS = 120000; // 子任务最长等待 (防卡死主 agent 工具循环)

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

// 带超时等待 (防子 agent 卡死) — 定时器必须清理, 否则快速 resolve 后仍挂起 120s 阻止进程退出
function withTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}超时 (${ms / 1000}s)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
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

export function registerDelegateTools(catalog, _opts = {}) {
  catalog.register({
    name: "spawn_agent",
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
      const role = String(args.role || "helper").replace(/[^\w-]/g, "_").slice(0, 24);

      const perspectives = Array.isArray(args.perspectives) ? args.perspectives.map((p) => String(p)).slice(0, tasks.length) : [];

      try {
        // SDD review 循环: 实施 -> 审查 -> 修复 -> 熔断
        // 单任务: 直接跑; 多任务: 每个任务独立一对 (实施者+只读审查者), 并行跑, 可仲裁聚合
        if (args.review) {
          const prefix = `${role}_${Date.now().toString(36)}`;
          if (tasks.length === 1) {
            return await runReviewLoop({
              agent, L, task: tasks[0],
              perspective: perspectives[0],
              role, judge: args.judge,
              fixRounds: args.fix_rounds,
              namePrefix: `${prefix}_0`,
            });
          }
          // 多任务: 并行各任务 review, 各自独立 (agent 名唯一, 不冲突)
          const settled = await Promise.all(tasks.map(async (task, i) => {
            try {
              return await runReviewLoop({
                agent, L, task,
                perspective: perspectives[i],
                role, judge: args.judge,
                fixRounds: args.fix_rounds,
                namePrefix: `${prefix}_${i}`,
              });
            } catch (e) {
              return `[子任务${i + 1} review 失败] ${e.message}`;
            }
          }));
          if (args.arbitrate) {
            return await arbitrate(agent, tasks, settled, perspectives, args.judge);
          }
          return tasks.map((t, i) => {
            const p = perspectives?.[i] ? ` (${perspectives[i]})` : "";
            return `【子任务${i + 1}${p}】${t}\n${settled[i]}`;
          }).join("\n\n");
        }
        // 并行 spawn 子 agent: 每个独立数据目录 + 独立视角
        const names = tasks.map((_, i) => `${role}_${i}_${Date.now().toString(36)}`);
        for (const n of names) {
          L.spawnAgent(n, {
            dataDir: path.join(agent.dataDir, "legion", n),
            globalDataDir: agent.globalDataDir,
          });
        }
        // 生命周期: 繁衍计数 (ANS: reproducing)
        if (agent.lifecycle) agent.lifecycle.reproduce(names.length);

        // 并行派发, 全部等结果 (各自独立超时)
        const settled = await Promise.all(tasks.map(async (task, i) => {
          try {
            const reply = await withTimeout(
              L.send(names[i], { type: "chat", message: task, perspective: perspectives[i] }, { timeout: DELEGATE_TIMEOUT_MS + 5000 }),
              DELEGATE_TIMEOUT_MS,
              `子任务${i + 1}`
            );
            return { ok: true, reply: reply.reply || "(子 agent 无回复)" };
          } catch (e) {
            return { ok: false, reply: `[子任务${i + 1}失败] ${e.message}` };
          }
        }));
        const results = settled.map((s) => s.reply);

        // 单任务: 保持旧行为, 直接返回子 agent 回复
        if (tasks.length === 1) return results[0];

        // 多任务: 有 arbitrate 走主 agent 仲裁聚合, 否则拼接各方结果
        if (args.arbitrate) {
          const out = await arbitrate(agent, tasks, results, perspectives, args.judge);
          return out;
        }
        return tasks.map((t, i) => {
          const p = perspectives?.[i] ? ` (${perspectives[i]})` : "";
          return `【子任务${i + 1}${p}】${t}\n${results[i]}`;
        }).join("\n\n");
      } catch (e) {
        return `[工具错误] spawn_agent: ${e.message}`;
      }
    },
  });
}
