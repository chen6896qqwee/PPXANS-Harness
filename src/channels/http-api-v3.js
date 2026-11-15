// src/channels/http-api-v3.js - v3.0 API: 命令/审批/看板/审查/权限 (从 http.js 拆出, mixin 挂回 prototype)
import path from "node:path";

import { applyPermissionUpdate } from "../permissions/index.js";
import { createTaskBoard } from "../mcp/tasks.js";
import { runReview } from "../verify/review.js";
import { searchWorkspace, writeWorkspaceFile } from "./workspace.js";
import { publicErrorMessage } from "./http-shared.js";
import { noteCatch } from "../utils/catch-log.js";

export const apiV3HttpMethods = {
// 任务面板 (HTTP /api/tasks) 用的 TaskBoard: 懒建 + 复用同一份实例 (与 MCP 工具共享落盘文件)
_taskBoard(agent) {
  // (R17) 与 /task 命令共享 agent 级实例 —— 此前 HTTP/MCP 各自懒建,
  // 落盘同文件但内存双份 (操作互相覆盖); 现在三方 (命令/REST/MCP) 同源。
  if (typeof agent.getTaskBoard === "function") return agent.getTaskBoard();
  if (!this._taskBoardInst) this._taskBoardInst = createTaskBoard(path.resolve(agent.root));
  return this._taskBoardInst;
},

// ---- v3.0 API (codex 对齐): 命令/审批/看板/审查/权限热更新 ----
// 全部端点失败时静默 404 (前端优雅降级隐藏对应能力)
async _apiV3(req, res, reqPath, get) {
  const agent = this.agent;
  // GET /api/commands — 斜杠命令清单 (claude-code 命令模型)
  if (get && reqPath === "/api/commands") {
    const cmds = agent.commands?.list ? agent.commands.list(true) : [];
    this._json(res, 200, { commands: cmds.map((c) => ({ name: c.name, description: c.description || "", argumentHint: c.argumentHint || "" })) });
    return true;
  }
  // GET /api/approvals/pending — 待审批清单 (codex approval flow)
  // 2026-11-06 (评估 P1-6): 可选 ?sessionKey= 过滤 (多会话各看各的审批); 返回已脱敏
  if (get && reqPath === "/api/approvals/pending") {
    const u = new URL(req.url, "http://127.0.0.1");
    const sk = u.searchParams.get("sessionKey");
    this._json(res, 200, { approvals: agent.pendingApprovals ? agent.pendingApprovals(sk || null) : [] });
    return true;
  }
  // GET /api/approvals/rules — 已永久允许的命令 (设置页可撤销)
  if (get && reqPath === "/api/approvals/rules") {
    this._json(res, 200, { rules: agent.rememberedApprovals ? agent.rememberedApprovals() : [] });
    return true;
  }
  // POST /api/approvals/rules/forget { key } — 撤销一条永久允许
  // 必须排在 POST /api/approvals/:id 之前: 否则 "rules/forget" 会被当成审批 id。
  if (req.method === "POST" && reqPath === "/api/approvals/rules/forget") {
    const body = await this._readBody(req, res);
    if (body === null) return true;
    let key = "";
    try { key = String(JSON.parse(body || "{}").key || ""); } catch { /* 坏 JSON 按缺参处理 */ }
    if (!key) { this._json(res, 400, { ok: false, error: "key 必填" }); return true; }
    const ok = agent.forgetApproval ? agent.forgetApproval(key) : false;
    this._json(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: "该规则不存在或已撤销" });
    return true;
  }
  // POST /api/approvals/:id — 审批裁决 { decision: "approve" | "always" | "prefix" | "persist" | "deny" }
  if (req.method === "POST" && reqPath.startsWith("/api/approvals/")) {
    const id = reqPath.slice("/api/approvals/".length);
    const body = await this._readBody(req, res);
    if (body === null) return true;
    let decision = "deny";
    let bodySk = null;
    try { const b = JSON.parse(body || "{}") || {}; decision = b.decision || "deny"; bodySk = b.sessionKey ?? null; } catch {}
    // 2026-11-06 (评估 P1-6): 调用方随裁决带上 sessionKey 时做归属校验 (防跨会话抢答)
    const ok = agent.resolveApproval ? agent.resolveApproval(id, decision, bodySk) : false;
    if (!ok) {
      this._json(res, 404, { ok: false, error: "该审批已结束或已超时 (可能已在终端或另一窗口裁决)" });
      return true;
    }
    this._json(res, 200, { ok });
    return true;
  }
  // GET /api/questions/pending — 待回答的提问 (ask_user 回合内提问)
  if (get && reqPath === "/api/questions/pending") {
    this._json(res, 200, { questions: agent.pendingQuestions ? agent.pendingQuestions() : [] });
    return true;
  }
  // POST /api/questions/:id — { answers: [{ id, selected[], custom? }] } 或 { cancel: true }
  if (req.method === "POST" && reqPath.startsWith("/api/questions/")) {
    const id = reqPath.slice("/api/questions/".length);
    const body = await this._readBody(req, res);
    if (body === null) return true;
    let payload = {};
    try { payload = JSON.parse(body || "{}") || {}; } catch {}
    const ok = agent.resolveQuestion ? agent.resolveQuestion(id, payload) : false;
    this._json(res, ok ? 200 : 404, { ok });
    return true;
  }
  // GET /api/goalboard — 目标看板 (OMH goal board)
  if (get && reqPath === "/api/goalboard") {
    const board = agent.goalBoard;
    if (!board) { this._json(res, 200, { goals: [] }); return true; }
    const goals = board.list ? board.list() : [];
    this._json(res, 200, { goals, text: board.render ? board.render() : "" });
    return true;
  }
  // GET /api/review/latest — 最近一次审查报告 (OCR 分级流水线)
  if (get && reqPath === "/api/review/latest") {
    this._json(res, 200, agent._lastReview || { issues: [], report: null });
    return true;
  }
  // POST /api/review/run — 审查按钮打真 API (与 review_code 工具同一 runReview 收口)
  if (req.method === "POST" && reqPath === "/api/review/run") {
    const body = await this._readBody(req, res);
    if (body === null) return true;
    try {
      const p = JSON.parse(body || "{}");
      const out = runReview({ files: Array.isArray(p.files) ? p.files : [], diff: p.diff || null });
      agent._lastReview = { issues: out.issues, report: out.report, ts: Date.now() };
      this._json(res, 200, { ok: true, total: out.issues.length, issues: out.issues, report: out.report });
    } catch (e) {
      this._fail(res, e);
    }
    return true;
  }
  // POST /api/goalboard — 目标看板可写 { op: "add" | "update", ... } (与 goal_board 工具同一 store)
  if (req.method === "POST" && reqPath === "/api/goalboard") {
    const body = await this._readBody(req, res);
    if (body === null) return true;
    const board = agent.goalBoard;
    if (!board) { this._json(res, 503, { ok: false, error: "目标看板未装配" }); return true; }
    try {
      const p = JSON.parse(body || "{}");
      let goal = null;
      if (p.op === "add") goal = board.addGoal({ id: p.id, title: p.title, priority: p.priority, status: p.status, budget: p.budget, spent: p.spent, nextReviewAt: p.next_review_at ?? p.nextReviewAt });
      else if (p.op === "update") goal = board.updateGoal(p.id, { title: p.title, priority: p.priority, status: p.status, budget: p.budget, spent: p.spent, nextReviewAt: p.next_review_at ?? p.nextReviewAt });
      else { this._json(res, 400, { ok: false, error: `未知 op: ${p.op}` }); return true; }
      if (!goal) { this._json(res, 404, { ok: false, error: "目标不存在" }); return true; }
      this._json(res, 200, { ok: true, goal, goals: board.list() });
    } catch (e) {
      this._json(res, 400, { ok: false, error: publicErrorMessage(e) }); // 非法优先级/状态 → 4xx (store 层校验)
    }
    return true;
  }
  // GET /api/tasks — 任务面板只读列表 (复用 MCP 同一份 TaskBoard)
  if (get && reqPath === "/api/tasks") {
    try {
      const { tasks, counts } = this._taskBoard(agent).list();
      this._json(res, 200, { ok: true, tasks, counts });
    } catch (e) { this._fail(res, e); }
    return true;
  }
  // POST /api/tasks — 任务面板写 { op: create | step | update | complete | delete, ... }
  if (req.method === "POST" && reqPath === "/api/tasks") {
    // readonly 对称 (2026-11-14, 双轨收敛轮): 审查者不得经 REST 写任务面板 (MCP admin 早有检查)
    if (agent.readonly === true) {
      this._json(res, 403, { ok: false, error: "只读模式 (审查者) 不允许修改任务面板" });
      return true;
    }
    const body = await this._readBody(req, res);
    if (body === null) return true;
    const board = this._taskBoard(agent);
    try {
      const p = JSON.parse(body || "{}");
      let task = null;
      switch (p.op) {
        case "create": task = board.create({ title: p.title, description: p.description, steps: p.steps }); break;
        case "step": board.step({ id: p.id, index: p.index, status: p.status, detail: p.detail }); task = board.get(p.id); break;
        case "update": task = board.update({ id: p.id, status: p.status, title: p.title, description: p.description }); break;
        case "complete": task = board.complete(p.id, p.result); break;
        case "delete": board.delete({ id: p.id }); {
          const l = board.list();
          this._json(res, 200, { ok: true, task: null, tasks: l.tasks, counts: l.counts });
          return true;
        }
        default: this._json(res, 400, { ok: false, error: `未知 op: ${p.op}` }); return true;
      }
      const l = board.list();
      this._json(res, 200, { ok: true, task, tasks: l.tasks, counts: l.counts });
    } catch (e) {
      this._json(res, 400, { ok: false, error: publicErrorMessage(e) });
    }
    return true;
  }
  // GET /api/tickets — 工单账本 (2026-11-02 三期第二批): ?id= 单张 / ?status=a,b&limit=N 列表
  if (get && reqPath === "/api/tickets") {
    const u = new URL(req.url, "http://127.0.0.1");
    const id = u.searchParams.get("id");
    if (id) {
      const got = agent.workGet?.(id);
      this._json(res, got ? 200 : 404, got ? { ok: true, ...got } : { ok: false, error: "工单不存在" });
      return true;
    }
    const status = u.searchParams.get("status");
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit")) || 30));
    const out = agent.workList ? agent.workList({ status: status ? status.split(",").map((s) => s.trim()).filter(Boolean) : undefined, limit }) : { tickets: [], counts: {}, enabled: false };
    // 外部看门狗 (?assignments=1): 在途进度 (rounds/steps/tools) 只存在指派上, 工单列表
    //   本身不带。显式请求才附加, 默认响应逐字不变。
    if (u.searchParams.get("assignments") === "1" && Array.isArray(out.tickets)) {
      out.tickets = out.tickets.map((t) => {
        let a = null;
        try { a = t.assignmentId ? agent.workStore?.getAssignment?.(t.assignmentId) : null; }
        catch (e) { noteCatch("src/channels/http-api-v3.js#tickets", e); a = null; }
        if (!a) return t;
        return {
          ...t,
          assignment: {
            id: a.id, status: a.status, worker: a.worker, sessionKey: a.sessionKey,
            rounds: a.rounds, steps: a.steps, tools: a.tools, lastTool: a.lastTool,
            startedAt: a.startedAt, updatedAt: a.updatedAt, replaySafe: a.replaySafe,
          },
        };
      });
    }
    this._json(res, 200, { ok: true, ...out });
    return true;
  }
  // POST /api/tickets — { op: "cancel" | "requeue", id, reason? }
  if (req.method === "POST" && reqPath === "/api/tickets") {
    const body = await this._readBody(req, res);
    if (body === null) return true;
    try {
      const p = JSON.parse(body || "{}");
      const id = String(p.id || "");
      if (!id) { this._json(res, 400, { ok: false, error: "缺少 id" }); return true; }
      if (p.op === "cancel") {
        const r = agent.workCancel?.(id, String(p.reason || "api_cancel")) || { ok: false, reason: "workgraph_disabled" };
        this._json(res, r.ok ? 200 : 400, { ok: !!r.ok, ...r });
        return true;
      }
      if (p.op === "requeue") {
        const r = agent.workRequeue?.(id) || { ok: false, reason: "workgraph_disabled" };
        this._json(res, r.ok ? 200 : 400, { ok: !!r.ok, ...r });
        return true;
      }
      this._json(res, 400, { ok: false, error: `未知 op: ${p.op}` });
    } catch (e) {
      this._json(res, 400, { ok: false, error: publicErrorMessage(e) });
    }
    return true;
  }
  // POST /api/workspace/write — 写工作区文件 (Web UI 落盘; 越界路径 → 4xx)
  if (req.method === "POST" && reqPath === "/api/workspace/write") {
    const body = await this._readBody(req, res);
    if (body === null) return true;
    try {
      const p = JSON.parse(body || "{}");
      const out = writeWorkspaceFile(path.resolve(agent.root), p.path, p.content);
      this._json(res, 200, { ok: true, ...out });
    } catch (e) {
      this._json(res, 400, { ok: false, error: publicErrorMessage(e) });
    }
    return true;
  }
  // GET /api/workspace/search — 工作区文件/内容搜索 (Web UI 文件定位)
  if (get && reqPath === "/api/workspace/search") {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      const out = searchWorkspace(path.resolve(agent.root), u.searchParams.get("q") || "");
      this._json(res, 200, { ok: true, ...out });
    } catch (e) {
      this._fail(res, e);
    }
    return true;
  }
  // GET /api/permissions — 读取当前权限状态 (2026-10-09 补)
  // 此前只有 POST(写), 前端设置面板想显示"当前审批模式/沙箱"只能去 /api/bootstrap 里找,
  // 而 bootstrap 根本没有这两个字段 → 下拉框恒空。补一个 GET 让读取有正规来源。
  if (req.method === "GET" && reqPath === "/api/permissions") {
    if (!agent.permissions) { this._json(res, 200, { ok: false, reason: "权限引擎未装配" }); return true; }
    this._json(res, 200, {
      ok: true,
      approvalMode: agent.permissions.approvalMode,
      sandbox: agent.permissions.sandbox,
      networkAccess: agent.permissions.networkAccess,
      planEnabled: agent.permissions.planEnabled,
      planSessions: agent.planModeSessions(),
      // 2026-11-08: 把"可访问范围"一并告诉前端。档位名 (workspace-write) 抽象,
      //   用户看不到边界在哪, 于是出现"选了完全权限却仍写不了桌面"的困惑。
      workspaceRoot: agent.root || null,
      workspaceAllow: Array.isArray(agent.config?.agent?.workspace_allow) ? agent.config.agent.workspace_allow : [],
    });
    return true;
  }

  // POST /api/permissions — 权限热更新 { approvalMode?, sandbox?, networkAccess?, planEnabled?, sessionKey? }
  // 2026-11-03 用户拍板: 拆掉"放宽需二次确认"的确认码双门 (2026-10-31 引入)。单人本机工具,
  //   6 位确认码 (出码→系统通知→手输) 每次提权都要走一遍, 挡住的多数时候是主人自己。
  //   现在所有变更校验后**即时生效**; 提权仍留痕: detectEscalations 命中时发 tracer 事件,
  //   审计哈希链里查得到"谁在什么时候把权限放宽到了哪"。
  //   值合法性 fail-closed 不变; 生效只动内存引擎, 不写配置文件 (重启还原)。
  if (req.method === "POST" && reqPath === "/api/permissions") {
    const body = await this._readBody(req, res);
    if (body === null) return true;
    if (!agent.permissions) { this._json(res, 200, { ok: false, reason: "权限引擎未装配" }); return true; }
    let cfg = {};
    try { cfg = JSON.parse(body || "{}"); } catch {}

    // 2026-11-14 (战役遗留项 #8): 校验/提权留痕/落字段收敛到 permissions.applyPermissionUpdate
    //   —— 与 /api/bot.manage action=permission 同一实现; 值非法 throw → 400 (文案不变)。
    //   提权不再拦截, 但必须留下可追责痕迹 (哈希链 + 通知; 2026-11-13 评测 P1-3)。
    try {
      // 评测-II P1-1: dir 显式传 agent.dataDir —— 提权 flag 落在本 agent 的数据目录,
      //   不再依赖 markEscalation 的 cwd 兜底 (嵌入环境 cwd ≠ 数据目录时会写错位置)。
      applyPermissionUpdate(agent.permissions, cfg, { agent, source: "http", dir: agent.dataDir });
    } catch (e) {
      this._json(res, 400, { ok: false, error: e.message });
      return true;
    }

    // 即时生效 (plan 模式: 带 sessionKey 只动会话态, 不带则动引擎级兜底开关 —— 会话级
    //   开关不属于引擎三字段, 留在本入口)
    if (cfg.planEnabled != null) {
      if (cfg.sessionKey) agent.setPlanMode(cfg.sessionKey, !!cfg.planEnabled);
      else agent.permissions.planEnabled = !!cfg.planEnabled;
    }
    this._json(res, 200, {
      ok: true,
      approvalMode: agent.permissions.approvalMode,
      sandbox: agent.permissions.sandbox,
      networkAccess: agent.permissions.networkAccess,
      planEnabled: agent.permissions.planEnabled,
      planSessions: agent.planModeSessions(),
      // 2026-11-08: 把"可访问范围"一并告诉前端。档位名 (workspace-write) 抽象,
      //   用户看不到边界在哪, 于是出现"选了完全权限却仍写不了桌面"的困惑。
      workspaceRoot: agent.root || null,
      workspaceAllow: Array.isArray(agent.config?.agent?.workspace_allow) ? agent.config.agent.workspace_allow : [],
    });
    return true;
  }
  // GET /api/health/summary — 运行健康聚合 (轨迹成功率/失败/心跳/工具可用性/待审批/用量)
  // 数据源均为现成 (traces.stats + usageStats + lifecycle + tools), 供 Web hero 状态条直读。
  if (get && reqPath === "/api/health/summary") {
    const t = agent.traces && typeof agent.traces.stats === "function" ? agent.traces.stats() : {};
    const u = agent.usageStats || {};
    const tools = agent.tools && typeof agent.tools.listDetailed === "function" ? agent.tools.listDetailed() : [];
    const lc = agent.lifecycleStatus ? agent.lifecycleStatus() : {};
    this._json(res, 200, {
      ok: true,
      uptime_ms: Math.round(process.uptime() * 1000),
      heartbeat_at: new Date().toISOString(),
      traces: { count: t.count || 0, failed: t.failed || 0, failRate: t.failRate || "0%", slowTools: t.slowTools || [] },
      usage: {
        calls: u.calls || 0, tokens: u.tokens || 0, cost: u.cost || 0,
        // 未定价模型数: cost 不含它们, 汇总口径要能看出"金额是低估的"
        unpriced: Object.keys((u.unpriced && typeof u.unpriced === "object") ? u.unpriced : {}).length,
      },
      tools: { total: tools.length, enabled: tools.filter((x) => x.enabled).length },
      pending_approvals: agent.pendingApprovals ? agent.pendingApprovals().length : 0,
      pending_questions: agent.pendingQuestions ? agent.pendingQuestions().length : 0,
      lifecycle: lc,
      policy_guard: agent.tools && typeof agent.tools.policyStatus === "function"
        ? agent.tools.policyStatus().filter((s) => s.state && s.state !== "closed") : [],
    });
    return true;
  }
  // GET /api/verify/records — 验收记录: 已验证账本 (Auditor) + 最近任务执行证据 (命令/退出码/耗时)
  // 兑现「执行/验证分离」的可观测: 用户能翻到"测试到底跑没跑、退出码多少、耗时多少"。
  if (get && reqPath === "/api/verify/records") {
    const auditor = agent.auditor;
    const aStats = auditor && typeof auditor.stats === "function" ? auditor.stats() : { total: 0, byKind: {} };
    const ledger = auditor && Array.isArray(auditor.ledger) ? auditor.ledger.slice(-20) : [];
    const traces = agent.traces && typeof agent.traces.read === "function" ? agent.traces.read(undefined, 200) : [];
    const executions = (Array.isArray(traces) ? traces : [])
      .filter((t) => t && /run_command|test|apply_patch|write_file|code_act|review_code/.test(String(t.tool || "")))
      .slice(-40)
      .map((t) => ({
        tool: t.tool, ok: !!t.ok, durationMs: t.durationMs || 0, ts: t.ts || null,
        args: String(t.args || "").slice(0, 160), error: t.error ? String(t.error).slice(0, 160) : null,
      }));
    this._json(res, 200, { ok: true, verification: { total: aStats.total, byKind: aStats.byKind, ledger }, executions });
    return true;
  }
  // GET /api/evolve/status — 自我进化可观测: 进化引擎状态 + 已验证账本 + playbook 现状 (只读)
  // 让「证据不够不出提案」的进化过程不再黑盒 (对照 TheOne 自我进化入口)。
  if (get && reqPath === "/api/evolve/status") {
    const ev = agent.evolve;
    const pb = agent.playbook ? agent.playbook.playbook : null;
    const bullets = pb && Array.isArray(pb.bullets) ? pb.bullets.slice(0, 30).map((b) => ({
      id: b.id, kind: b.kind, content: b.content, counters: b.counters || {}, createdAt: b.createdAt,
    })) : [];
    const auditor = agent.auditor;
    // 2026-10-30: 补 EvolutionLoop (每日编排/代码迭代) 视图 —— 此前只报行为层,
    //   夜间循环跑了什么/闸门状态/适应度规模 全是黑盒
    const loop = agent._evolutionLoop;
    const loopCfg = agent.config?.agent?.evolution_loop || {};
    const iterCfg = agent.config?.agent?.self_iteration || {};
    this._json(res, 200, {
      ok: true,
      evolve: ev ? { enabled: ev.enabled, everyCalls: ev.everyCalls, calls: ev._calls, lastAt: ev._lastAt, minIntervalMs: ev.minIntervalMs } : null,
      evolution_loop: loop ? {
        enabled: !!loopCfg.enabled,
        cron: loopCfg.cron || "03:30",
        running: !!loop.running,
        lastRunAt: loop.lastRunAt || 0,
        rotationCursor: loop._rot || 0,
        fitnessFiles: Array.isArray(iterCfg.target_files) ? iterCfg.target_files.length : 0,
        mode: iterCfg.mode === "apply" ? "apply" : "propose",
        self_code_mode: agent.config?.agent?.self_code?.mode || "propose",
        journal: typeof loop.journalTail === "function" ? loop.journalTail(5) : [],
      } : null,
      verified: auditor && typeof auditor.stats === "function" ? auditor.stats() : { total: 0, byKind: {} },
      playbook: { version: pb ? pb.version : null, total: pb && Array.isArray(pb.bullets) ? pb.bullets.length : 0, bullets },
      experience: agent.experience ? { lessons: (agent.experience.lessons || []).length } : {},
    });
    return true;
  }
  return false;
}
};
