// src/agent/commands.js - 斜杠命令执行 (从 index.js 拆出, mixin 挂回 prototype)
import fs from "node:fs";
import path from "node:path";

export const commandsMethods = {
// 2026-10-24 (R3): 斜杠命令全量接线 —— 此前 13 条内置命令只有 /plan /do 被 chat 消费,
//   其余 11 条的意图对象产出后无人执行 (dead dispatch, 审计实锤)。本方法是"集成层":
//   registry 产意图 → agent 落地。返回 null = 非命令输入, 交回 LLM 主链;
//   返回字符串 = 命令结果, 直接作为回复 (不进 LLM, 不落库 —— 控制面操作不污染对话历史)。
async _executeCommand(userMsg, sessionKey) {
  if (!this.commands || typeof this.commands.parse !== "function") return null;
  const parsed = this.commands.parse(userMsg);
  if (!parsed) return null;
  const cmd = this.commands.get(parsed.cmd);
  if (!cmd) {
    return `未知命令: /${parsed.cmd}。可用: ${this.commands.list().map((c) => "/" + c.name).join("  ")}`;
  }
  let intent;
  try { intent = this.commands.execute(userMsg, { sessionKey }); } catch (e) {
    return `命令执行失败: ${e.message}`;
  }
  // /plan /do 由 _consumePlanCommand 在上游处理, 这里放行
  if (intent && intent.type === "intent"
    && (intent.action === "enter_plan_mode" || intent.action === "exit_plan_mode")) return null;
  if (!intent) return null;
  if (intent.type === "message") return String(intent.content || "");
  if (intent.type === "error") return String(intent.message || "命令失败");
  if (intent.type === "prompt") {
    // 用户命令 (.ppx/commands/*.md) = prompt 模板, $ARGUMENTS 填参后走 LLM 主链
    const filled = String(intent.template || "").replace(/\$ARGUMENTS/g, parsed.args || "").trim();
    return this.chat(filled, { sessionKey });
  }
  if (intent.type !== "intent") return null;

  const sk = sessionKey || "default";
  switch (intent.action) {
    case "new_session":
      this.resetSession(sk);
      // (R5) 清掉指向该会话的重定向 (重置即回到原始命名空间)
      for (const [k, v] of this._sessionRedirect || []) if (v === sk) this._sessionRedirect.delete(k);
      return `会话 ${sk} 已重置, 全新开始。`;
    case "rewind": {
      const r = this.rewindSession(sk, intent.turns);
      if (!r.ok) return `回退失败: ${r.reason}`;
      return `已回退最近 ${r.droppedTurns} 轮对话 → 新分支 ${r.newKey}。后续对话自动在分支上继续; 原会话保留可审计。`
        + `\n(注: 已写入的长期记忆不受回卷影响, 需要时用 memory_forget 管理。)`;
    }
    case "resume_session": {
      // (R5) 重定向语义: 直接把对话流切到目标会话 (原会话完整保留, 比 R3 的拷贝合并更干净)
      if (!intent.sessionId) {
        const recent = (this.sessionStore.list() || [])
          .filter((s) => !s.archived && s.key !== sk).slice(0, 8);
        return recent.length
          ? `最近会话:\n${recent.map((s) => `- ${s.key} (${s.count || 0} 条事件)`).join("\n")}\n用 /resume <会话名> 继续。`
          : "暂无其他历史会话。";
      }
      if (!this.sessionStore.has(intent.sessionId)) return `会话不存在: ${intent.sessionId}`;
      if (intent.sessionId === sk) return "当前已在该会话。";
      const map = this._sessionRedirect || (this._sessionRedirect = new Map());
      for (const [k, v] of map) if (v === sk) map.set(k, intent.sessionId);
      map.set(sk, intent.sessionId);
      return `会话已切换 → ${intent.sessionId} (${this.sessionStore.count(intent.sessionId)} 条事件)。后续对话在此继续, 原会话保留。`;
    }
    case "compact": {
      const r = await this._maybeCompact(sk);
      if (r && r.ok) return `已压缩会话 ${sk} (method=${r.method}, upToSeq=${r.upToSeq})。`;
      return "当前未达压缩阈值 (历史 token ≤ 1.5× 预算), 无需压缩。";
    }
    case "review": {
      if (!this.tools || !this.tools.has("review_code")) return "review_code 工具未装配。";
      return this.tools.call("review_code", { path: intent.target || "." }, { agent: this });
    }
    case "init_project": {
      // 2026-10-31: 注入实现已落地 (src/memory/project-md.js), 文案不再说谎;
      //   已有 AGENTS.md (codex/cursor 生态标准) 时不再重复创建 PPX.md。
      const agentsPath = path.join(this.root, "AGENTS.md");
      const p = path.join(this.root, "PPX.md");
      const haveAgents = fs.existsSync(agentsPath);
      const havePpx = fs.existsSync(p);
      if (haveAgents || havePpx) {
        const which = [haveAgents && "AGENTS.md", havePpx && "PPX.md"].filter(Boolean).join(" + ");
        return `项目指令已存在 (${which}) — 每次对话自动注入, 继续沿用。`;
      }
      fs.writeFileSync(p, [
        "# PPX.md — 项目记忆 (每次对话自动注入)",
        "",
        "## 构建与验证",
        "- 测试: `npm test` · 快检: `npm run verify`",
        "",
        "## 约定",
        "<!-- 在这里写下: 架构约定 / 代码风格 / 禁止事项 / 常用命令 -->",
        "",
      ].join("\n"));
      return `已创建 PPX.md (${p}) —— 写入项目约定后, 每次对话自动注入 (也兼容 AGENTS.md, codex/cursor 生态标准文件)。`;
    }
    case "set_model": {
      const providers = this.allProviders || [];
      if (!intent.model) {
        return providers.length
          ? `可用模型:\n${providers.map((c) => `- ${c.model}${c === this.llm ? " (当前)" : ""}`).join("\n")}\n用 /model <名称> 切换。`
          : "无可用 provider (未配置或全部不可达)。";
      }
      const hit = providers.find((c) => c.model === intent.model || c.providerId === intent.model);
      if (!hit) return `未找到模型/provider: ${intent.model}。可用: ${providers.map((c) => c.model).join(", ") || "(无)"}`;
      this.llm = hit;
      return `会话内主模型已切换 → ${hit.model} (进程级, 不写配置文件; 持久切换请用设置界面)。`;
    }
    case "show_status": {
      const lines = [
        `模型: ${this.llm?.model || "(未配置)"}${(this.allProviders || []).length > 1 ? ` · 备选 ${this.allProviders.length - 1} 个` : ""}`,
        // (R17) 生命周期摘要化 —— 此前整段 JSON.stringify 直出, /status 里塞着
        //   bornAt 时间戳/ageMs 毫秒/recent 数组, 用户视角是噪音。
        (() => {
          const st = this.lifecycleStatus?.() || {};
          const bits = [`阶段 ${st.stage || "-"}`];
          if (st.chats != null) bits.push(`${st.chats} 次对话`);
          if (st.evolved) bits.push(`进化 ${st.evolved} 次`);
          return `生命周期: ${bits.join(" · ")}`;
        })(),
        `使用: ${this.usageStats.calls} 次调用 / ${this.usageStats.tokens} tokens / $${Number(this.usageStats.cost).toFixed(6)}`,
        `记忆: L1 事实 ${this.facts?.count?.() ?? "?"} 条 · 会话 ${this.sessionStore?.count?.(sk) ?? 0} 条事件`,
        `计划模式: ${this.isPlanMode(sk) ? "开 (/do 退出)" : "关"}`,
        `审计链: ${this.audit ? (this.audit.stats?.()?.detail || "就绪") : "未装配"}`,
        `自愈: ${this.health ? `${(this.health.fixes || []).length} 项修复记录` : "未装配"}`,
      ];
      return lines.join("\n");
    }
    case "memory": {
      if (String(intent.sub || "").toLowerCase() === "clear") {
        return "批量清空记忆请走治理通道: memory_forget (软删可回滚) / memory_clear_layer (按层)。斜杠命令不做不可逆删除。";
      }
      return `记忆概览: L1 事实 ${this.facts?.count?.() ?? "?"} 条。检索用 memory_search, 遗忘用 memory_forget (可回滚)。`;
    }
    case "bg_list": {
      // 异步 ReAct (二期④): /bg 清单 —— 观测面 (发起走 channels async_reply 受理分支)
      // 2026-11-01 (三期): 附长驻话题 worker 清单 (驻派/直通状态)
      const workers = this.threadWorkers();
      const tasks = this.bgTasks();
      const wLines = workers.length
        ? `驻派话题 worker (${workers.length}):\n${workers.map((w) => `- ${w.worker} 话题=${w.threadKey} 转发=${w.forwards} 次`).join("\n")}\n撤驻: /bg detach <话题键>\n`
        : "";
      if (!tasks.length && !workers.length) return "暂无后台任务与驻派 worker (IM 通道开 async_reply / threadDelegate 发起)。";
      return wLines + `后台任务 (${tasks.length}):\n${tasks.slice(0, 10).map((t) => {
        const dur = t.endedAt ? `${Math.round((t.endedAt - t.startedAt) / 1000)}s` : `${Math.round((Date.now() - t.startedAt) / 1000)}s…`;
        return `- ${t.id} [${t.status}] ${dur} 会话=${t.sessionKey} · ${t.replyPreview || t.error || t.text}`;
      }).join("\n")}\n取消: /bg cancel <id>`;
    }
    case "bg_cancel": {
      const ok = this.bgCancel(String(intent.taskId || ""));
      return ok ? `已请求取消 ${intent.taskId} (中断信号已发, 当前轮收口后生效)。` : `未找到运行中的后台任务: ${intent.taskId} (/bg 查看)。`;
    }
    case "bg_detach": {
      const ok = await this.threadDetach(String(intent.taskId || ""));
      return ok ? `已撤驻话题 ${intent.taskId} (worker 进程已回收, 消息回到主 agent 处理)。` : `未找到驻派话题: ${intent.taskId} (/bg 查看)。`;
    }
    case "work_list": {
      // 工单账本 (三期第二批): 观测面 —— 准入/执行/失败/中断跨重启可查
      if (!this.work) return "工单账本未启用 (config.agent.work_graph.enabled=false)。";
      const filterRaw = String(intent.filter || "").toLowerCase();
      const filter = ["failed", "done", "working", "admitted", "waiting", "cancelled"].includes(filterRaw)
        ? filterRaw
        : (filterRaw === "active" ? ["admitted", "working", "waiting"] : ["admitted", "working", "waiting", "failed"]);
      const { tickets, stats } = this.workList({ status: filter, limit: 15 });
      const c = stats?.counts || {};
      const head = `工单账本: 总计 ${stats?.total ?? 0} · 活跃 ${stats?.active ?? 0} (排队 ${c.admitted || 0} / 执行 ${c.working || 0} / 等待 ${c.waiting || 0}) · 完成 ${c.done || 0} · 失败 ${c.failed || 0}${stats?.interrupted ? ` (中断 ${stats.interrupted})` : ""}`;
      if (!tickets.length) return `${head}\n没有匹配的工单。${stats?.interrupted ? "\n重跑中断工单: /work requeue <id>" : ""}`;
      const lines = tickets.map((t) => {
        const dur = t.endedAt ? `${Math.round((t.endedAt - t.createdAt) / 1000)}s` : `${Math.round((Date.now() - t.createdAt) / 1000)}s…`;
        return `- \`${t.id}\` [${t.status}] ${t.source || "-"}/${t.from || "-"} · ${t.textPreview || t.resultPreview || t.error || ""} (${dur})`;
      });
      return `${head}\n${lines.join("\n")}\n详情: /work show <id> · 取消: /work cancel <id> · 重跑: /work requeue <id>`;
    }
    case "work_show": {
      if (!this.work) return "工单账本未启用 (config.agent.work_graph.enabled=false)。";
      const got = this.workGet(String(intent.ticketId || ""));
      if (!got) return `未找到工单: ${intent.ticketId}`;
      const t = got.ticket;
      const fmt = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "-");
      const lines = [
        `工单 \`${t.id}\` [${t.status}] ${t.source || "-"}/${t.from || "-"} 会话=${t.sessionKey || "-"}`,
        `创建 ${fmt(t.createdAt)} · 开始 ${fmt(t.startedAt)} · 结束 ${fmt(t.endedAt)} · 尝试 ${t.attempts || 0}${t.failureKind ? ` · 失败类型=${t.failureKind}` : ""}`,
        `文本: ${t.text || "(空)"}`,
      ];
      if (t.resultPreview) lines.push(`结果: ${t.resultPreview}`);
      if (t.error) lines.push(`错误: ${t.error}`);
      if (got.assignments.length) {
        lines.push(`指派 (${got.assignments.length}):`);
        for (const a of got.assignments) {
          lines.push(`- \`${a.id}\` ${a.worker} [${a.status}] 轮次=${a.rounds || 0} 工具=${(a.tools || []).join(",") || "-"}${a.error ? ` · ${a.error}` : ""}`);
        }
      }
      return lines.join("\n");
    }
    case "work_cancel": {
      const r = this.workCancel(String(intent.ticketId || ""), "user_cancel");
      if (!r.ok) {
        const why = { workgraph_disabled: "工单账本未启用", not_found: "未找到工单", already_final: "工单已终态" }[r.reason] || r.reason;
        return `取消失败: ${why} (${intent.ticketId})。`;
      }
      return `已取消工单 \`${r.ticket.id}\` (联动中断对应后台任务)。`;
    }
    case "work_requeue": {
      const r = this.workRequeue(String(intent.ticketId || ""));
      if (!r.ok) {
        const why = { workgraph_disabled: "工单账本未启用", not_found: "未找到工单", no_text: "工单没有可重跑的文本", not_requeueable: "只有失败/取消的工单可重跑 (成功工单不重放, 避免重复副作用)" }[r.reason] || r.reason;
        return `重跑失败: ${why} (${intent.ticketId})。`;
      }
      return `已重跑工单 \`${r.ticket?.id || intent.ticketId}\` (后台任务 ${r.bgTaskId}, 结果将回投来源通道/原话题)。`;
    }
    case "list_skills": {
      const list = this.skills?.list?.() || [];
      return list.length
        ? `可用技能 (${list.length}):\n${list.map((s) => `- ${s.name || s.id}${s.description ? ` — ${String(s.description).slice(0, 60)}` : ""}`).join("\n")}`
        : "暂无技能。用 create_skill 创建, 或 refineSkill 从成功轨迹自动沉淀。";
    }
    case "agents": {
      if (String(intent.sub || "list") === "spawn") {
        return "派生子 agent 请使用 spawn_agent 工具 (支持多任务并行 / 差异化视角 / 仲裁聚合 / SDD 审查循环)。";
      }
      const list = this._legion?.list?.() || [];
      return list.length
        ? `军团在编 (${list.length}): ${list.map((a) => a.name).join(", ")}`
        : "军团未激活 (spawn_agent 首次调用时创建)。";
    }
    case "goal_board": {
      const sub = String(intent.sub || "list");
      if (sub === "add" || sub === "update") {
        return `${sub} 需要参数 (title/status/...), 请直接使用 goal_board 工具。`;
      }
      if (!this.tools || !this.tools.has("goal_board")) return "goal_board 工具未装配。";
      return this.tools.call("goal_board", { action: "list" }, { agent: this });
    }
    case "task_board": {
      // (R17) /task 命令落地: 侧栏提示"发送 /task 创建"此前指向不存在的命令。
      //   与 HTTP /api/tasks、MCP ppx.task.* 共享同一份 TaskBoard 落盘 (data/tasks.json)。
      const tb = this.getTaskBoard();
      const sub = String(intent.sub || "list");
      if (sub === "add") {
        const t = tb.create({ title: String(intent.arg || "未命名任务").slice(0, 120) });
        return `已创建任务 **${t.title}** (${t.id})。侧栏任务面板可见; /task done ${t.id} 完结, /task del ${t.id} 删除。`;
      }
      if (sub === "done") {
        const t = tb.complete(String(intent.arg || ""));
        return `任务 **${t.title}** (${t.id}) 已完结。`;
      }
      if (sub === "del") {
        const r = tb.delete({ id: String(intent.arg || "") });
        if (!r.ok) return `任务不存在: ${intent.arg}`;
        return `任务 ${intent.arg} 已删除。`;
      }
      const { tasks, counts } = tb.list();
      if (!tasks.length) return "任务面板为空。用法: /task add <标题> · /task · /task done <id> · /task del <id>";
      const lines = [`## 任务面板 (${counts.todo} 待办 · ${counts.running} 进行 · ${counts.done} 完成${counts.failed ? ` · ${counts.failed} 失败` : ""})`];
      for (const t of tasks.slice(0, 15)) {
        const step = t.steps.length ? ` — 步骤 ${t.steps.filter((x) => x.status === "done").length}/${t.steps.length}` : "";
        lines.push(`- [${t.status === "done" ? "x" : " "}] \`${t.id}\` **${t.title}** (${t.status})${step}`);
      }
      return lines.join("\n");
    }
    default:
      return null;
  }
}
};
