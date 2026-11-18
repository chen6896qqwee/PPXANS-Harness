// src/tools/delegate.js - 多 agent 自主协作工具 (spawn_agent)
// 让 agent 在工具循环里自主决定 spawn 子 agent 分工 (ANS 神经元中枢的最小实现):
//   - 主 agent 分析任务 → 认为需要专门角色/并行/隔离 → 调 spawn_agent
//   - 子 agent: 独立会话目录 (隔离) + 共享全局经验库 (ANS 全局记忆)
//   - 子 agent 复用懒建军团 (agent._legion), 不重复 spawn 进程
// v2 (2026-08-17): 多智能体研究洞察落地 (设计对照, 自研实现)
//   - 并行任务: tasks 数组并行派发多个子 agent (专才 + 并行化)
//   - 差异化上下文: perspectives 注入每个子 agent 专属视角, 对抗同质失败
//   - 仲裁聚合: arbitrate 时主 agent LLM 综合各子结果做最终裁决
// v3 (2026-08-17): SDD 子代理驱动开发 (设计溯源 docs/PROVENANCE.md#superpowers)
//   - review 循环: 实施者 -> 只读审查者 -> (发现问题 -> 修复 -> 复审) * fixRounds -> 熔断停放
//   - 审查者只读 (PPX_AGENT_READONLY), 实施者修复复用原进程 (上下文完整)
//   - 账本 ledger: 全程记录审查/修复轮次, 熔断时未决发现交主 agent 裁定
// 2026-11-03 巨石拆分: 宿主保留「工具注册面 (spawn_agent 的 schema + execute 编排) +
//   autoCreateExpert (可生长专家建档)」; SDD review 纯函数拆进 delegate-review.js,
//   编排流 (专家解析/仲裁/runTeam/监督者循环/review 循环/记忆板) 拆进 delegate-team.js。
//   全部公开导出经下方重导出保持原 import 路径不变; 拆出模块不 import 本文件 (无环)。
import path from "node:path";
import { noteCatch } from "../utils/catch-log.js";
import { Legion } from "../orchestrator/legion.js";
import { registerUserExpert, normalizePersona, resolveExpertWithUser, saveUserExperts } from "../orchestrator/experts.js";
import { resolveTeam, teamExperts, teamRiskProfile } from "../orchestrator/teams.js";
import { withTimeout } from "../utils/async.js";
import { profileFromEngine, childSpawnEnv } from "../permissions/intersection.js";
import { currentTrace } from "../core/trace.js";
import { createTrigger } from "../flow/trigger.js";
import {
  ROUTE_KIND, ROUTER_EVENT, buildDelegationBrief, emitRouterEvent, normalizeWorkerReport,
} from "../flow/router.js";
import { createWorktree, collectWorktreeChanges, removeWorktree } from "../orchestrator/worktree.js";
import {
  DELEGATE_TIMEOUT_MS, resolveExpertFor, runTeam, runSupervisorLoop, runReviewLoop,
  arbitrateWithBoard, publishToBoard,
} from "./delegate-team.js";

// ---- 可生长专家: 自动建档 ----

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
  } catch (e) {
    noteCatch(e); // 坏 JSON 是预期分支, 但写盘失败也必须能复盘
    return null;
  }
}

export function registerDelegateTools(catalog, opts = {}) {
  const board = opts.board || null;
  catalog.register({
    name: "spawn_agent",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "system" },
    // 委派是长任务: 不声明时吃全局 tool_timeout_ms (默认 30s), 子 agent 正常跑一轮就会被掐断
    //   (2026-11-04 实测: 只读任务 worker 30.5s 完成, 主侧在 30s 已返回"超时")。
    //   内部单任务上限是 DELEGATE_TIMEOUT_MS (120s), 外层给到 180s 覆盖单任务/并行 + 一次修正。
    timeoutMs: DELEGATE_TIMEOUT_MS + 60000,
    description: "派生子 agent 处理子任务并等待结果; 适合需要专门角色、并行或隔离执行的任务。子 agent 共享全局经验库。各参数之间怎么搭配, 见参数说明 (task/tasks 二选一; perspectives 配 tasks; arbitrate 聚合; review 走 SDD 审查; supervisor 走监督者编排)。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "单个子任务描述 (清晰完整, 含上下文); 与 tasks 二选一" },
        tasks: { type: "array", items: { type: "string" }, description: "并行子任务列表 (每个子 agent 一个), 适合多角度论证/并行处理; 与 task 二选一" },
        perspectives: { type: "array", items: { type: "string" }, description: "差异化视角列表, 与 tasks 一一对应, 注入每个子 agent 专属视角 (对抗同质失败), 可缺省" },
        role: { type: "string", description: "子 agent 角色名 (如 数据分析师/代码审查员), 默认 helper" },
        isolation: {
          type: "string",
          enum: ["none", "worktree"],
          default: "none",
          description: "隔离方式: none=共享当前工作区; worktree=每个子任务在独立 git worktree 执行, "
            + "回执附变更统计与补丁路径 (git apply --3way 可合入)。需要 git 仓库与 HEAD 提交, 不自动合并",
        },
        arbitrate: { type: "boolean", description: "是否由主 agent 仲裁聚合所有子结果 (并行/多任务 review 时推荐), 默认 false 直接返回拼接结果" },
        judge: { type: "string", description: "仲裁评审指令 (arbitrate=true 时生效, 如 找出最可靠结论/合并去重); review=true 时为审查准则, 可缺省" },
        review: { type: "boolean", description: "SDD 审查循环: 实施者 -> 只读审查者 -> 发现问题自动修复复审, 达上限熔断, 默认 false。单 task 与多 tasks 均支持" },
        // 2026-10-25 补 (评估报告 P2): supervisor 参数此前在 execute 里被读取却未声明进
        //   schema —— 模型按 tools 清单无法稳定发现/触发监督者编排, 等于半隐藏功能。
        supervisor: { type: "boolean", description: "监督者编排: N 个专家并行产出 → 监督者 LLM 评审 → 打回带反馈再派一轮 → 接受则定稿; 未接受输出各方原始结论供裁定, 默认 false" },
        supervisor_rounds: { type: "number", description: "监督者编排最大评审轮数 (supervisor=true 时生效, 默认 3, 上限 5)" },
        fix_rounds: { type: "number", description: "审查循环最大修复轮数 (review=true 时生效, 默认 3, 上限 5)" },
        share_board: { type: "boolean", description: "子任务结论自动发布到军团共享记忆板 (board_query 可查), 仲裁前主 agent 自动读板。默认 true" },
        expert: { type: "string", description: "固化专家角色 (单任务)。用 expert_list 工具查全部专家 id; 专家自带角色名+专属视角 (只读专家自动禁修改工具)" },
        experts: { type: "array", items: { type: "string" }, description: "每任务一个专家 (与 tasks 一一对应, 优先于 expert)。如 [\"code\",\"design\",\"security\"] 三任务分派代码/设计/安全专家" },
        team: { type: "string", description: "班组名 (整体接管分工, 按班组拓扑编排成员), 用 team_list 工具查全部班组 id" },
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

      // 高级编排 (团队/临时专家组/审查/监督) 走各自循环, 不经过下方直派路径 ——
      //   这里先记一条决策事件, 让"Router 为什么开这批 worker"在审计链上可见;
      //   逐 Worker 的 dispatch/report 仍由各编排流的 step 事件与工具调用证据覆盖。
      const advanced = args.team ? "team" : args.topology ? "topology"
        : args.review ? "review" : args.supervisor ? "supervisor" : null;
      if (advanced) {
        const advSk = currentTrace()?.sessionKey || "default";
        agent._markTurnRoute?.(advSk, "worker");
        emitRouterEvent(agent, ROUTER_EVENT.DECISION, {
          kind: "spawn_agent",
          route: ROUTE_KIND.WORKER,
          tasks: tasks.length,
          workers: tasks.length,
          sessionKey: advSk,
          origin: "delegate",
          reason: advanced,
          memoryInjected: false,
          routerRole: agent?.role === "router",
        });
      }

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
          const sr = Number(args.supervisor_rounds);
          const maxRounds = Number.isFinite(sr) ? Math.min(Math.max(Math.trunc(sr), 1), 5) : 3;
          const out = await runSupervisorLoop({
            agent, L, task: tasks.join("\n\n"), judge: args.judge,
            expertKeys, role, maxRounds,
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
        // 委派建单 (2026-11-05 调度闭环收口 ②): Router 的每次委派落一张工单 —— 分派/收口
        //   与入站同源可查 (/work 面板 / watchdog / 审计链)。source=spawn_agent, messageId
        //   留空 (每任务独立建单不误去重); 账本未装配/失败降级 ticket=null, 不阻断委派。
        const work = agent?.work || null;
        agent._markTurnRoute?.(sessionKey, "worker");
        const memoryInject = agent?.config?.agent?.delegate_memory_inject === true && !!agent?.facts;
        emitRouterEvent(agent, ROUTER_EVENT.DECISION, {
          kind: "spawn_agent",
          route: ROUTE_KIND.WORKER,
          tasks: tasks.length,
          workers: names.length,
          sessionKey,
          origin: "delegate",
          reason: args.team ? "team" : args.supervisor ? "supervisor" : args.review ? "review"
            : tasks.length > 1 ? "parallel" : "single",
          memoryInjected: memoryInject,
          routerRole: agent?.role === "router",
        });
        const tickets = tasks.map((task) => {
          try {
            return work ? work.submit(createTrigger({
              source: "spawn_agent", from: sessionKey, text: String(task),
            }), { sessionKey, cause: "delegate" }) : null;
          } catch { return null; }
        });
        // worktree 隔离 (2026-11-16): 每个子任务一个 detached worktree, worker 以其为 cwd。
        //   注意作用域: 声明必须在 try 外 —— try 块内的 const 在 finally 里不可见。
        const isolation = args.isolation === "worktree" ? "worktree" : "none";
        const worktrees = new Array(names.length).fill(null);
        try {
          // 配额治理 (2026-11-05 收口): 此前逐个 L.spawnAgent() 绕过 ConcurrencyGovernor
          //   (README 声称 spawn 已纳治理, 但普通并行路径漏网)。整批走 spawnAgents
          //   (acquire(1)/进程退出归还, legion.js 一期已铺), 缺该口才退回逐个 spawn
          //   (与 delegate-team.runTeam 同款回退, 兼容测试桩)。
          if (isolation === "worktree") {
            for (let i = 0; i < names.length; i++) {
              worktrees[i] = createWorktree(agent.root, { id: names[i] });
            }
          }
          const specs = names.map((name, i) => ({
            name,
            opts: {
              dataDir: path.join(agent.dataDir, "legion", name),
              globalDataDir: agent.globalDataDir,
              cwd: worktrees[i] || undefined,
              env: childSpawnEnv(parentProfile, !!expertList[i]?.readonly),
            },
          }));
          let spawned = [];
          if (typeof L?.spawnAgents === "function") {
            spawned = (await L.spawnAgents(specs)) || [];
          } else {
            for (const s of specs) {
              try { L?.spawnAgent?.(s.name, s.opts); spawned.push({ ok: true, name: s.name }); }
              catch (e) { spawned.push({ ok: false, name: s.name, error: e.message }); }
            }
          }
          const spawnFailed = new Map(); // name -> 原因 (配额拒绝/spawn 异常)
          for (const r of (Array.isArray(spawned) ? spawned : [])) {
            if (r && r.ok === false) spawnFailed.set(String(r.name), r.error || "spawn_failed");
          }
          // 生命周期: 繁衍计数 (ANS: reproducing) —— 只数真正 spawn 成功的
          const liveCount = names.filter((n) => !spawnFailed.has(n)).length;
          if (agent.lifecycle && liveCount > 0) agent.lifecycle.reproduce(liveCount);

          // 委派工单 begin/fail: spawn 失败的子任务当场收口, 成功的开指派 (worker=worker 名)
          const assignments = new Array(names.length).fill(null);
          for (let i = 0; i < names.length; i++) {
            const t = tickets[i];
            if (!t || t.deduped) continue;
            const err = spawnFailed.get(names[i]);
            if (err) { try { work.fail(t.id, new Error(err), { failureKind: "spawn_failed" }); } catch { /* 账本不阻断 */ } }
            else { try { assignments[i] = work.begin(t.id, { worker: names[i], sessionKey }); } catch { /* 账本不阻断 */ } }
          }

          // 分派事件: 每个 Worker 一条 (工单/指派/角色), 与 ticket_assigned 互补 ——
          //   后者记"账本状态变了", 这里记"Router 做了分派决定"。正文不入链。
          for (let i = 0; i < names.length; i++) {
            const t = tickets[i];
            if (!t || t.deduped) continue;
            emitRouterEvent(agent, ROUTER_EVENT.DISPATCH, {
              ticketId: t.id,
              assignmentId: assignments[i]?.id || null,
              worker: names[i],
              sessionKey,
              origin: "delegate",
              route: ROUTE_KIND.WORKER,
              role: effRoles[i],
              expert: expertList[i]?.id || null,
              memoryInjected: memoryInject,
            });
          }

          // 并行派发, 全部等结果 (各自独立超时)
          // 全局上下文 (2026-11-05): 开启 delegate_memory_inject 后, Router 把跨会话记忆与
          //   同角色共享板的近期事实作为 [全局上下文] 前缀随分派注入 —— Worker 不必重问
          //   "Session X 里有没有 Y"。检索失败只退回裸任务文本, 绝不阻断派发。
          const settled = await Promise.all(tasks.map(async (task, i) => {
            const t = tickets[i];
            const asg = assignments[i];
            const startedAt = Date.now();
            const ticketId = t && !t.deduped ? t.id : null;
            const assignmentId = asg?.id || null;
            try {
              const spawnErr = spawnFailed.get(names[i]);
              if (spawnErr) throw new Error(`worker 启动失败: ${spawnErr}`);
              let brief = { text: "", memoryHits: 0, boardHits: 0 };
              if (memoryInject) {
                brief = await buildDelegationBrief(agent, task, {
                  board: shareBoard ? board : null, role: effRoles[i],
                });
              }
              const message = brief.text ? `${brief.text}[任务] ${task}` : task;
              const reply = await withTimeout(
                L.send(names[i], {
                  type: "chat", message, perspective: effPersps[i],
                  // Step 3 信封回传: worker 原样带回这两个 ID, Router 侧据此归组汇报。
                  ticketId, assignmentId,
                }, {
                  timeout: DELEGATE_TIMEOUT_MS + 5000,
                  onProgress: (ev) => {
                    if (!t || t.deduped || !work || typeof work.progress !== "function") return;
                    const patch = {};
                    if (Number.isFinite(ev?.round)) patch.rounds = ev.round + 1;
                    if (Number.isFinite(ev?.steps)) patch.steps = ev.steps;
                    if (ev?.lastTool) patch.lastTool = ev.lastTool;
                    if (!Object.keys(patch).length) return;
                    try { work.progress(t.id, patch); } catch { /* 观测不阻断派发 */ }
                  },
                }),
                DELEGATE_TIMEOUT_MS,
                `子任务${i + 1}`
              );
              // 2026-11-01 (二期⑤): worker 回包带结构化汇报信封 (旧 worker 无该字段 = null)
              return {
                ok: true,
                reply: reply.reply || "(子 agent 无回复)",
                envelope: reply.envelope || null,
                ticketId, assignmentId, worker: names[i],
                durationMs: Date.now() - startedAt,
                memoryHits: brief.memoryHits, boardHits: brief.boardHits,
              };
            } catch (e) {
              return {
                ok: false,
                reply: `[子任务${i + 1}失败] ${e.message}`,
                error: e, envelope: null,
                ticketId, assignmentId, worker: names[i],
                durationMs: Date.now() - startedAt,
              };
            }
          }));

          // Worker 汇报事件 (先于账本收口): 结构化信封 → 白名单事实, 与工单终态正交。
          //   超时/异常时 ok=false, 不采信子进程自称的 status。
          for (let i = 0; i < settled.length; i++) {
            const s = settled[i];
            emitRouterEvent(agent, ROUTER_EVENT.REPORT, {
              ...normalizeWorkerReport({
                ok: s.ok,
                envelope: s.envelope,
                worker: s.worker,
                ticketId: s.ticketId,
                assignmentId: s.assignmentId,
                durationMs: s.durationMs,
                errorKind: s.ok ? null : "delegate_error",
              }),
              memoryHits: s.memoryHits || 0,
              boardHits: s.boardHits || 0,
            });
          }

          // 委派工单收口: 成功/失败按 settled 事实落账 (迟到的失败不覆盖终态, service 已挡)
          for (let i = 0; i < settled.length; i++) {
            const t = tickets[i];
            if (!t || t.deduped) continue;
            const s = settled[i];
            if (s.ok) { try { work.complete(t.id, { result: s.reply, envelope: s.envelope }); } catch { /* 账本不阻断 */ } }
            else { try { work.fail(t.id, s.error, { failureKind: "delegate_error" }); } catch { /* 账本不阻断 */ } }
          }
          // worktree 收口: 收集每个隔离目录的变更统计 + 补丁, 再删除工作区。
          //   失败/超时的子任务也收集 —— 半成品同样是用户需要看见的事实。
          if (isolation === "worktree") {
            for (let i = 0; i < settled.length; i++) {
              const wt = worktrees[i];
              if (!wt) continue;
              try {
                const ch = collectWorktreeChanges(agent.root, wt);
                settled[i].worktreeNote = ch.stat
                  ? `\n[worktree 隔离] ${ch.stat}; 补丁已保存 ${ch.patchPath} (git apply --3way "${ch.patchPath}" 合入)`
                  : "\n[worktree 隔离] 无文件变更";
              } catch (e) {
                settled[i].worktreeNote = `\n[worktree 隔离] 变更收集失败: ${e.message}`;
              }
            }
          }
          const results = settled.map((s) => s.reply + (s.worktreeNote || ""));
          // 汇报信封 → 模型可读摘要 (轮次/步数/工具名): 主 agent 引用 worker 执行证据用
          // 2026-11-05: 附工单号 —— 委派在 /work 账本可查 (收口 ②)
          const envelopeNote = (s) => {
            const e = s.envelope;
            if (!e) return "";
            const tools = Array.isArray(e.tools) && e.tools.length ? e.tools.join(",") : "无";
            const tid = s.ticketId ? ` 工单=${s.ticketId}` : "";
            return `\n[汇报信封] 状态=${e.status || "?"} 轮次=${e.rounds ?? "?"} 工具步=${e.steps ?? 0} 用具=${tools}${tid}`;
          };

          // share_board: 每个子任务结论自动上板 (成功/失败都记, 状态区分)
          if (shareBoard) {
            settled.forEach((s, i) => {
              publishToBoard(board, { from: names[i], topic: boardTopic, task: tasks[i], reply: s.reply, status: s.ok ? "完成" : "失败" });
            });
          }

          // 结论回写全局记忆 (2026-11-05): 共享板是 7 天 TTL 的临时协作区, worker 结论此前
          //   随进程回收即散; 成功结论落 FactStore 才能被后续 Router/Worker 跨会话检索。
          //   只取短摘要 + dedupe, source=fork-merge (model-inferred 分级); 可用配置关闭。
          if (agent?.config?.agent?.delegate_memory_writeback !== false && agent?.facts
            && typeof agent.facts.add === "function") {
            for (let i = 0; i < settled.length; i++) {
              const s = settled[i];
              if (!s.ok) continue;
              const text = String(s.reply || "").replace(/\s+/g, " ").trim();
              if (text.length < 12) continue;
              try {
                agent.facts.add(`[worker:${effRoles[i] || names[i]}] ${text.slice(0, 280)}`, {
                  source: "fork-merge", type: "general", importance: 0.35, dedupe: true,
                });
              } catch { /* 记忆写回失败不影响派发结果 */ }
            }
          }

          // 单任务: 保持旧行为, 直接返回子 agent 回复 (附汇报信封摘要, 模型可引用执行证据)
          if (tasks.length === 1) return results[0] + envelopeNote(settled[0]);

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
          // worktree 清理: 无论成功/失败/异常都删除隔离目录 (补丁已另存 data/worktrees/*.patch)
          for (const wt of worktrees) {
            if (wt) { try { removeWorktree(agent.root, wt); } catch { /* 清理失败不掩盖主结果 */ } }
          }
          // 2026-10-24: SubagentStop 钩子接线 —— 此前 HOOK_EVENTS 里的该事件全仓无 emit 点,
          //   外部钩子永远收不到"子代理结束"。emit 失败不掩盖真实结果。
          try {
            for (const n of names) await agent.hooks?.emit?.("SubagentStop", { agent: n, tools: "spawn_agent" });
          } catch { /* 钩子异常不阻断回收 */ }
        }
      } catch (e) {
        return `[工具错误] spawn_agent: ${e.message}`;
      }
    },
  });
}

// ---- 重导出 (2026-11-03 拆分): 调用方 import 路径与名称逐字不变 ----
// 纯转发 (本文件不直接使用): SDD review 纯函数 + 仲裁输入/仲裁
export { severityLabel, parseReviewFindings, needsFix, buildReviewPrompt, buildFixPrompt } from "./delegate-review.js";
export { buildArbitrationInput, arbitrate } from "./delegate-team.js";
// 本文件直接使用 (上面已 import), 再导出保持旧入口
export { DELEGATE_TIMEOUT_MS, resolveExpertFor, runTeam, runSupervisorLoop, arbitrateWithBoard, publishToBoard };
