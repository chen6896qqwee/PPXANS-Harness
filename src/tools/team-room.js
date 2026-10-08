// src/tools/team-room.js - 团队房间工具 (2026-10-07 吸收自 TencentCloud/Octop)
//
// 把 room.js 的常驻团队会话接成 agent 可自主使用的工具。
//   team_room_open / say / dispatch / status / history / manage / close
//
// 关键接线 (这一层才让房间"真的能干活"):
//   · 成员的 executor = 受并发治理的 Legion 子进程 (每个成员一个常驻 worker, 名字稳定 → 可复用)
//   · 成员的 perspective = 专家包渲染出来的角色人格块 (成员 id 可以是专家包 id)
//   · 只读成员 → 子进程挂 PPX_AGENT_READONLY (经权限交集, 只准变窄)
//   · 房间落盘 data/rooms/<id>.json (在途任务不落盘 —— 与 Octop 一致: 重启丢在途, 锁消失)
//
// 与 spawn_agent 的区别 (为什么两个都要):
//   spawn_agent 是**一次性委派**: 起了用完就回收, 同步等结果。
//   team_room   是**常驻班组**: 成员进程复用、有历史时间线、可反复派工、可中途观察。
//   反复派同一批角色的场景 (比如"这个项目我每天让研发班组过一遍") 用房间省掉反复冷启动。

import path from "node:path";
import fs from "node:fs";
import { TeamRoom, INBOX_STATUS, SPEAKER } from "../orchestrator/room.js";
import { getGovernor } from "../orchestrator/governor.js";
import { resolveExpert, HIGH_RISK_DOMAINS } from "../orchestrator/experts.js";
import { resolveTeam } from "../orchestrator/teams.js";
import { roomKey } from "../orchestrator/session-key.js";
import { ensureDir, readJson } from "../utils/store.js";
import { debug } from "../utils/logger.js";

const DEFAULT_DISPATCH_TIMEOUT_MS = 180000;

// ---- 成员规格解析: 支持 专家包 id / EXPERTS id / 班组名 ----
export function resolveMemberSpec(agent, key) {
  const raw = String(key || "").trim();
  if (!raw) return null;

  // 1) 专家包 (专家库/市场)
  const packs = agent?.expertPacks;
  const pack = packs && typeof packs.resolve === "function" ? packs.resolve(raw) : null;
  if (pack) {
    const persona = packs.personaOf(pack.id, { agentName: agent?.config?.agent?.name || "皮皮虾", userDisplay: agent?.userName || "兄弟", withAgents: true });
    return {
      id: pack.id, label: pack.label, readonly: !!pack.readonly, requiresHuman: !!pack.requiresHuman,
      domain: pack.domain, perspective: persona || pack.perspective, source: "pack",
    };
  }
  // 2) 内置 EXPERTS 名册
  const e = resolveExpert(raw);
  if (e) {
    return {
      id: raw.toLowerCase().replace(/[^\w\u4e00-\u9fff-]/g, "-").slice(0, 40),
      label: e.name, readonly: !!e.readonly, requiresHuman: !!e.requiresHuman,
      domain: e.domain || "misc", perspective: e.perspective, source: "experts",
    };
  }
  // 3) 班组名 → 展开成多名成员 (调用方负责展开)
  return { __team: resolveTeam(raw) };
}

// 把 members 参数展开: 班组名展开为其成员, 其余按单个专家解析
export function expandMembers(agent, list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const spec = resolveMemberSpec(agent, item);
    if (!spec) continue;
    if (spec.__team) {
      for (const mid of spec.__team.members) {
        const m = resolveMemberSpec(agent, mid);
        if (m && !m.__team && !seen.has(m.id)) { seen.add(m.id); out.push({ ...m, team: spec.__team.id }); }
      }
      continue;
    }
    if (!seen.has(spec.id)) { seen.add(spec.id); out.push(spec); }
  }
  return out;
}

// ---- 成员 executor: 受并发治理的 Legion 常驻 worker ----
export function makeLegionExecutor(agent, { timeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS } = {}) {
  return async (memberId, message, ctx) => {
    const room = ctx?.room;
    const member = room?.findMember(memberId);
    const L = agent._legion;
    if (!L) throw new Error("军团未装配 (agent._legion 为空)");
    // 成员进程名稳定 (房间+成员) → 复用而非每次冷启动
    const name = `${room.id}_${memberId}`.replace(/[^\w\u4e00-\u9fff-]/g, "_").slice(0, 60);
    if (!L.agents || !L.agents.has(name)) {
      const opts = {
        dataDir: path.join(agent.dataDir, "rooms", room.id, memberId),
        globalDataDir: agent.globalDataDir,
        env: member?.readonly ? { PPX_AGENT_READONLY: "1" } : {},
      };
      if (typeof L.spawnAgents === "function") await L.spawnAgents([{ name, opts }]);
      else L.spawnAgent(name, opts);
    }
    const r = await L.send(name, { type: "chat", message, perspective: ctx?.perspective || null }, { timeout: timeoutMs + 5000 });
    return r?.reply || "(成员无回复)";
  };
}

// ---- 房间注册表 (挂在 agent 上, 跨工具调用复用) ----
function roomRegistry(agent) {
  if (!agent._rooms) agent._rooms = new Map();
  return agent._rooms;
}

function roomFileOf(agent, roomId) {
  return path.join(agent.dataDir, "rooms", `${roomId}.json`);
}

export function registerTeamRoomTools(catalog, { getAgent = () => null } = {}) {
  const agentOf = (ctx) => (ctx && ctx.agent) || getAgent();

  const roomOf = (agent, id) => {
    const reg = roomRegistry(agent);
    const rid = String(id || "").trim();
    if (rid && reg.has(rid)) return reg.get(rid);
    if (!rid) return null;
    // 尝试从磁盘恢复 (跨进程续跑)
    const file = roomFileOf(agent, rid);
    if (!fs.existsSync(file)) return null;
    const room = TeamRoom.restore(file, { executor: makeLegionExecutor(agent) });
    if (room) reg.set(rid, room);
    return room;
  };

  // ---- 1. 开房间 ----
  catalog.register({
    name: "team_room_open",
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "subprocess" },
    category: "orchestration",
    power: "agent",
    description: "开一个常驻团队房间: 一名主持人 + 至少 2 名成员。成员可写专家包 id / 内置专家 id / 班组名 (班组会展开成其成员)。开完房间后成员进程会被复用, 适合\"这批角色要反复派活\"的场景。房间落盘可跨进程恢复 (在途任务不恢复)。与 spawn_agent 的区别: 那个是一次性委派, 这个是常驻班组。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "房间/团队名" },
        members: { type: "array", items: { type: "string" }, description: "成员列表 (专家包 id / 专家 id / 班组名), 至少 2 个" },
        host: { type: "string", description: "主持人角色 (专家包 id 或专家 id), 缺省用通用主持人" },
        persist: { type: "boolean", description: "是否落盘 (默认 true)" },
      },
      required: ["members"],
    },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      if (!agent) return "[工具错误] team_room_open: 无 agent 上下文";
      const members = expandMembers(agent, args.members);
      if (members.length < 2) {
        return `[工具错误] team_room_open: 需要至少 2 名成员 (成功解析 ${members.length} 名)。成员可写专家包 id、内置专家 id 或班组名(会展开)。用 expert_pack_list / expert_list / team_list 查看可用值。`;
      }
      const hostSpec = args.host ? resolveMemberSpec(agent, args.host) : null;
      const host = (hostSpec && !hostSpec.__team)
        ? { id: hostSpec.id, label: hostSpec.label, personaMbti: hostSpec.personaMbti || null }
        : { id: "host", label: `${args.name || "团队"}主持人` };
      const id = String(args.name || "room").replace(/[^\w\u4e00-\u9fff-]/g, "-").slice(0, 40) + "_" + Math.random().toString(36).slice(2, 6);
      const persist = args.persist !== false;
      const room = new TeamRoom({
        id, name: String(args.name || "团队"), host,
        members: members.map((m) => ({ id: m.id, label: m.label, readonly: m.readonly })),
        executor: makeLegionExecutor(agent),
        hostExecutor: makeHostExecutor(agent),
        file: persist ? roomFileOf(agent, id) : null,
      });
      roomRegistry(agent).set(id, room);
      const highRisk = members.filter((m) => m.requiresHuman || HIGH_RISK_DOMAINS.includes(m.domain));
      const lines = [
        `房间已开: ${room.name}`,
        `room_id: ${id}`,
        `主持人: ${host.label}`,
        `成员 (${members.length}): ${members.map((m) => `${m.label}${m.readonly ? "(只读)" : ""}${m.requiresHuman ? "(需人工复核)" : ""}`).join(" / ")}`,
        persist ? `落盘: ${roomFileOf(agent, id)}` : "未落盘 (进程内)",
      ];
      if (highRisk.length) lines.push(`⚠ 含高风险域成员 (${highRisk.map((m) => m.label).join("、")}) —— 其产出只能作为人类决策的输入。`);
      lines.push("", "下一步: team_room_dispatch 派工, team_room_status 看进度, team_room_history 读上墙记录。");
      return lines.join("\n");
    },
  });

  // ---- 2. 用户对主持人说话 ----
  catalog.register({
    name: "team_room_say",
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "subprocess+llm" },
    category: "orchestration",
    power: "agent",
    description: "在房间里对主持人说话 (用户永远只跟主持人说话)。主持人会做调度决策或给结论。派工请用 team_room_dispatch。",
    parameters: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "房间 id" },
        text: { type: "string", description: "要说的话" },
      },
      required: ["room_id", "text"],
    },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      const room = roomOf(agent, args.room_id);
      if (!room) return `[工具错误] team_room_say: 房间不存在 ${args.room_id}`;
      const { reply } = await room.say(args.text);
      return `【主持人 ${room.host.label}】\n${reply}`;
    },
  });

  // ---- 3. 派工 ----
  catalog.register({
    name: "team_room_dispatch",
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "subprocess+llm" },
    category: "orchestration",
    power: "agent",
    description: "给房间成员派工。默认**异步**: 发完即返回, 成员完成后自动上墙并回叫主持人收口 (不阻塞)。同一成员的任务自动串行 (避免同工作区并发写), 不同成员并行。wait=true 则等到这条任务完成并直接返回产出。",
    parameters: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "房间 id" },
        member: { type: "string", description: "成员 id 或中文名 (用 team_room_status 查)" },
        task: { type: "string", description: "任务描述 (成员看不到房间历史, 要写全上下文)" },
        wait: { type: "boolean", description: "true = 等这条完成再返回 (默认 false 异步)" },
        timeout_ms: { type: "number", description: "单条派工超时 (毫秒)" },
      },
      required: ["room_id", "member", "task"],
    },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      const room = roomOf(agent, args.room_id);
      if (!room) return `[工具错误] team_room_dispatch: 房间不存在 ${args.room_id}`;
      // member 支持 id 或中文名
      let m = room.findMember(args.member);
      if (!m) m = room.members.find((x) => String(x.label || "").includes(String(args.member)) || String(args.member).includes(x.label || "\u0000"));
      if (!m) return `[工具错误] team_room_dispatch: 成员不存在 ${args.member}。当前成员: ${room.members.map((x) => `${x.id}(${x.label})`).join(", ")}`;
      const r = room.dispatch(m.id, args.task, { timeoutMs: Number(args.timeout_ms) || 0 });
      if (!r.ok) return `[工具错误] team_room_dispatch: ${r.reason}`;
      const head = `已派工 → ${m.label} (job ${r.jobId})`;
      if (args.wait !== true) {
        return `${head}\n异步执行中。成员完成后会自动上墙并回叫主持人。用 team_room_status 看进度, team_room_history 读产出。`;
      }
      // 等这一条落地 (轮询 job 状态; 房间内其它成员的任务并行不受影响)
      const timeout = Number(args.timeout_ms) || DEFAULT_DISPATCH_TIMEOUT_MS;
      const done = await waitForJob(room, r.jobId, timeout);
      if (!done) return `${head}\n⚠ 等待超时 (${timeout}ms), 任务仍在跑。用 team_room_status 查。`;
      const job = room.listJobs({ limit: 200 }).find((j) => j.id === r.jobId);
      if (!job) return `${head}\n⚠ 任务记录已不可见 (房间可能被关闭)`;
      if (job.status === INBOX_STATUS.DONE) {
        const post = room.timeline.filter((e) => e.jobId === r.jobId && e.speaker === SPEAKER.MEMBER).pop();
        return `${head}\n状态: 完成\n\n【${m.label} 产出】\n${post?.text || "(空)"}`;
      }
      return `${head}\n状态: ${job.status}${job.error ? ` — ${job.error}` : ""}`;
    },
  });

  // ---- 4. 状态 ----
  catalog.register({
    name: "team_room_status",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "orchestration",
    power: "user",
    idempotent: true,
    description: "看房间状态: 成员与各自在途任务数、派工队列统计 (queued/running/done/failed/cancelled)、时间线长度。room_id 省略时列出所有已知房间。",
    parameters: {
      type: "object",
      properties: { room_id: { type: "string", description: "房间 id (省略则列出全部)" } },
      required: [],
    },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      const reg = roomRegistry(agent);
      if (!args.room_id) {
        const roomsDir = path.join(agent.dataDir, "rooms");
        const onDisk = fs.existsSync(roomsDir) ? fs.readdirSync(roomsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [];
        const ids = [...new Set([...reg.keys(), ...onDisk])];
        if (!ids.length) return "(尚无团队房间。用 team_room_open 开一个)";
        return `已知房间 ${ids.length} 个:\n` + ids.map((id) => {
          const live = reg.get(id);
          return live ? `- ${id} — 内存中, ${live.status().members.length} 成员, 在途 ${live.status().jobs.inFlight}` : `- ${id} — 仅磁盘快照 (未加载)`;
        }).join("\n");
      }
      const room = roomOf(agent, args.room_id);
      if (!room) return `[工具错误] team_room_status: 房间不存在 ${args.room_id}`;
      const st = room.status();
      const lines = [
        `房间 ${st.name} (${st.roomId}) ${st.closed ? "[已关闭]" : ""}`,
        `主持人: ${st.host.label} (${st.host.id})`,
        `成员 (${st.members.length}):`,
        ...st.members.map((m) => `  - ${m.id} ${m.label}${m.readonly ? " [只读]" : ""}${m.inFlight ? ` — 在途 ${m.inFlight}` : ""}`),
        `派工统计: 总 ${st.jobs.total} / 排队 ${st.jobs.queued} / 执行 ${st.jobs.running} / ${st.jobs.replying} 回写中 / 完成 ${st.jobs.done} / 失败 ${st.jobs.failed} / 取消 ${st.jobs.cancelled}`,
        `在途账本: ${st.jobs.inFlight}`,
        `时间线: ${st.timelineLength} 条`,
      ];
      if (st.jobs.inFlight) {
        lines.push("在途任务:");
        for (const j of room.tracker.list()) lines.push(`  - ${j.id} → ${j.targetLabel}: ${String(j.message).slice(0, 60)}`);
      }
      return lines.join("\n");
    },
  });

  // ---- 5. 上墙记录 ----
  catalog.register({
    name: "team_room_history",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "orchestration",
    power: "user",
    idempotent: true,
    description: "读房间的上墙时间线 (真群聊记录, 每条带说话人)。since 传上次拿到的时间戳可做增量拉取。",
    parameters: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "房间 id" },
        since: { type: "number", description: "只取这个时间戳之后的消息 (毫秒)" },
        limit: { type: "number", description: "最多返回条数 (默认全部)" },
      },
      required: ["room_id"],
    },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      const room = roomOf(agent, args.room_id);
      if (!room) return `[工具错误] team_room_history: 房间不存在 ${args.room_id}`;
      const list = room.history({ since: Number(args.since) || 0, limit: Number(args.limit) || 0 });
      if (!list.length) return "(时间线为空, 或 since 之后无新消息)";
      return list.map((e) => {
        const t = new Date(e.ts).toISOString().slice(11, 19);
        const who = e.speaker === SPEAKER.USER ? "用户" : e.speakerLabel || e.speaker;
        return `[${t}] ${who}: ${String(e.text || "").slice(0, 400)}`;
      }).join("\n");
    },
  });

  // ---- 6. 编制管理 ----
  catalog.register({
    name: "team_room_manage",
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "subprocess" },
    category: "orchestration",
    power: "agent",
    description: "管理房间编制与在途任务: add_member 加成员 / remove_member 移出成员 (有在途派工时会拒绝, 除非 force) / cancel_job 取消某条件 / list_jobs 列派工记录。",
    parameters: {
      type: "object",
      properties: {
        room_id: { type: "string" },
        action: { type: "string", enum: ["add_member", "remove_member", "cancel_job", "list_jobs"] },
        member: { type: "string", description: "add_member / remove_member 的目标 (专家包 id 或专家 id)" },
        job_id: { type: "string", description: "cancel_job 的目标" },
        force: { type: "boolean", description: "remove_member 时强制移出 (会先取消其在途任务)" },
        status: { type: "string", description: "list_jobs 时按状态过滤" },
      },
      required: ["room_id", "action"],
    },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      const room = roomOf(agent, args.room_id);
      if (!room) return `[工具错误] team_room_manage: 房间不存在 ${args.room_id}`;
      switch (args.action) {
        case "add_member": {
          const spec = resolveMemberSpec(agent, args.member);
          if (!spec || spec.__team) return `[工具错误] team_room_manage: 无法解析成员 ${args.member}`;
          const r = room.addMember({ id: spec.id, label: spec.label, readonly: spec.readonly });
          return r.ok ? `已加入成员: ${spec.label} (${spec.id})` : `[工具错误] ${r.reason}`;
        }
        case "remove_member": {
          const m = room.findMember(args.member) || room.members.find((x) => String(x.label || "").includes(String(args.member || "")));
          if (!m) return `[工具错误] team_room_manage: 成员不存在 ${args.member}`;
          const r = room.removeMember(m.id, { force: args.force === true });
          return r.ok ? `已移出成员: ${m.label}` : `[工具错误] ${r.reason}`;
        }
        case "cancel_job": {
          const r = room.cancelJob(String(args.job_id || ""), "人工取消");
          return r.ok ? `已取消 ${args.job_id}` : `[工具错误] ${r.reason}`;
        }
        case "list_jobs": {
          const jobs = room.listJobs({ status: args.status || null, limit: 30 });
          if (!jobs.length) return "(无派工记录)";
          return jobs.map((j) => {
            const t = new Date(j.createdAt).toISOString().slice(11, 19);
            return `[${t}] ${j.id} → ${j.targetLabel} [${j.status}]${j.error ? ` — ${j.error}` : ""}\n    ${String(j.message).slice(0, 120)}`;
          }).join("\n");
        }
        default:
          return `[工具错误] team_room_manage: 未知 action ${args.action}`;
      }
    },
  });

  // ---- 7. 关房间 ----
  catalog.register({
    name: "team_room_close",
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "subprocess" },
    category: "orchestration",
    power: "agent",
    description: "关闭房间: 取消全部在途任务、落盘最终快照、回收成员子进程。房间关闭后其成员进程被释放 (回到并发额度池)。",
    parameters: {
      type: "object",
      properties: {
        room_id: { type: "string" },
        keep_workers: { type: "boolean", description: "true 时只关房间不回收成员进程 (默认 false 一并回收)" },
      },
      required: ["room_id"],
    },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      const room = roomOf(agent, args.room_id);
      if (!room) return `[工具错误] team_room_close: 房间不存在 ${args.room_id}`;
      const before = room.status();
      room.close();
      let killed = 0;
      if (args.keep_workers !== true && agent._legion && typeof agent._legion.killAgent === "function") {
        for (const m of before.members) {
          const name = `${room.id}_${m.id}`.replace(/[^\w\u4e00-\u9fff-]/g, "_").slice(0, 60);
          try { if (await agent._legion.killAgent(name)) killed += 1; } catch (e) { debug(`[team-room] 回收成员进程失败 (已忽略): ${e && e.message ? e.message : e}`); }
        }
      }
      roomRegistry(agent).delete(room.id);
      return `房间已关闭: ${room.name} (${room.id})\n取消在途 ${before.jobs.inFlight} 条; 回收成员进程 ${killed} 个; 时间线 ${before.timelineLength} 条已落盘。`;
    },
  });

  return catalog;
}

// ---- 主持人 executor: 用主 agent 的 LLM 做调度决策 (不是子进程 —— 主持人是"轻量协调者") ----
export function makeHostExecutor(agent) {
  return async (message, ctx) => {
    const room = ctx?.room;
    const llm = agent?.auxLLM || agent?.llm;
    if (!llm || typeof llm.chat !== "function") return ""; // 回落 room.fallbackHostReply
    const members = (room?.members || []).map((m) => `${m.label}(${m.id})${m.readonly ? "[只读]" : ""}`).join("、") || "(空)";
    const inflight = room?.tracker?.list?.() || [];
    const inflightText = inflight.length
      ? inflight.map((j) => `- ${j.targetLabel}: ${String(j.message).slice(0, 80)}`).join("\n")
      : "(无)";
    const sys = [
      "你是这个团队的主持人。你的职责**只是调度**, 不替成员干专业活。",
      `团队成员: ${members}`,
      `在途任务:\n${inflightText}`,
      "",
      "规则:",
      "1) 用户的消息永远先到你这里; 需要成员出手就明确说要派给谁、派什么。",
      "2) 成员回报到了就做三件事: 判断是否满足要求 / 不满足就说缺什么 / 整体收工就给一句最终结论。",
      "3) 不要复述成员已经上墙的正文。不要编造成员还没产出的内容。",
      "4) 简短。你在协调不是在做报告。",
    ].join("\n");
    try {
      const r = await llm.chat([{ role: "system", content: sys }, { role: "user", content: String(message).slice(0, 6000) }]);
      return String(r?.content || "").trim();
    } catch (e) {
      debug(`[team-room] 主持人 LLM 调用失败 (回落规则回复): ${e && e.message ? e.message : e}`);
      return "";
    }
  };
}

async function waitForJob(room, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = room.inbox.get(jobId);
    if (!j) return false;
    if ([INBOX_STATUS.DONE, INBOX_STATUS.FAILED, INBOX_STATUS.CANCELLED].includes(j.status)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export { roomKey };
export default { registerTeamRoomTools, makeLegionExecutor, makeHostExecutor, resolveMemberSpec, expandMembers };
