// src/orchestrator/room.js - 团队房间运行时 (2026-10-07 吸收自 TencentCloud/Octop)
//
// 吸收来源: Octop 的 `docs/expert-teams.md` + `docs/agent-interop-mailbox.md`。
//   Octop 把"多 Agent 协作"落成一个具体形态, 而不是一句口号:
//
//     主持人 (kind=team) ── 只调度, 不干活 ── 轻量工具集 (agent_list / ask_agent / 记忆 / 时间)
//        │  user 永远只跟主持人说话
//        ├─ 异步派工 → 成员 A ── 各写各的工作区, 完成后**回叫主持人**
//        ├─ 异步派工 → 成员 B
//        └─ 房间时间线 (真群聊上墙, 每条消息带 speaker_agent_id)
//
//   三条契约是它的精髓, 本模块逐一复刻:
//     ① **异步派工 + 回叫闭环**: 派工发完即返回 (不阻塞主持人), 成员完成后由平台
//        用 `compose_followup` 组合提示词叫醒主持人做收口判断 —— 不是成员自己去找主持人。
//     ② **按 callee 并发**: 同一成员串行 (避免同一工作区被并发写), 不同成员并行。
//     ③ **在途派工账本**: 有在途任务的成员不能被移出编制 (否则结果无处落地)。
//
// 与 PPX 已有 `teams.js` 的关系 (互补, 不替代):
//   `teams.js` 是**编制模板** (班组名册: 成员 + 拓扑), 一次 spawn_agent 内同步收敛。
//   `room.js`  是**常驻会话**: 房间有生命周期、有历史时间线、成员可反复被派工、可中途观察。
//   两者共用同一套专家名册/班组定义, 差别在"一次性委派" vs "持续坐班"。
//
// 设计取舍 (为什么是纯数据 + 可注入 executor):
//   房间的正确性全在**状态机与并发契约**上 —— 谁在跑、谁在排队、回叫有没有丢、移人有没有
//   被拦住。这些与"真实子进程怎么起"无关。把 executor 注入进来 (生产接 Legion, 测试接桩),
//   零依赖且可确定性验证; 把 LLM/子进程耦合进来就再也测不干净了。

import { info, warn, debug } from "../utils/logger.js";
import { readJson, writeJson, ensureDir } from "../utils/store.js";
import path from "node:path";

export const INBOX_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  REPLYING: "replying",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const TERMINAL = new Set([INBOX_STATUS.DONE, INBOX_STATUS.FAILED, INBOX_STATUS.CANCELLED]);

// 说话人种类 (上墙消息的 speaker 标识; Octop 用 agent / agent_id 做同一件事)
export const SPEAKER = Object.freeze({ USER: "user", HOST: "host", MEMBER: "member", SYSTEM: "system" });

let SEQ = 0;
function newId(prefix) {
  SEQ = (SEQ + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}_${SEQ.toString(36)}`;
}

// ---- 默认 TeamProcessor (Octop 的 compose_followup 默认实现) ----
// 组合「成员结果 → 给主持人的提示词」。要点照抄 Octop:
//   要求主持人判收工、不复述成员已上墙的正文 (正文已经在时间线上, 复述等于刷屏)。
export function composeFollowup(msg, resultText) {
  const body = String(resultText || "").trim() || "(成员无回复)";
  return [
    `【成员回报】${msg.targetLabel || msg.targetAgentId} 已完成你派的任务。`,
    `【原任务】${String(msg.message || "").slice(0, 800)}`,
    `【成员产出】`,
    body.slice(0, 6000),
    "",
    "请只做三件事: ①判断这条产出是否满足任务要求; ②若不满足, 说清缺什么并决定是否重派; ③若整体已收工, 给用户一句最终结论。",
    "不要再复述成员的正文 (它已经上墙给用户看过了)。",
  ].join("\n");
}

// ---- 在途派工账本 (Octop TeamJobTracker) ----
// 按 job id 幂等记账: enqueue 开始, 任一结束路径 (成功/失败/取消) 都释放。
// 为什么要幂等: 回叫回调与超时兜底可能同时到达, 不幂等就会重复释放 → 编制被误判为空闲。
export class TeamJobTracker {
  constructor() { this.jobs = new Map(); }
  open(job) { this.jobs.set(job.id, { ...job, openedAt: Date.now() }); return job.id; }
  close(id, { status = INBOX_STATUS.DONE, error = null } = {}) {
    const j = this.jobs.get(id);
    if (!j) return false; // 幂等: 重复释放直接忽略
    this.jobs.delete(id);
    j.closedAt = Date.now();
    j.status = status;
    j.error = error;
    return true;
  }
  has(id) { return this.jobs.has(id); }
  // 某成员是否有在途派工 (移出编制前的守卫)
  busyWith(memberId) { return [...this.jobs.values()].filter((j) => j.targetAgentId === memberId); }
  isBusy(memberId) { return this.busyWith(memberId).length > 0; }
  pendingFor(targetAgentId) { return [...this.jobs.values()].filter((j) => !targetAgentId || j.targetAgentId === targetAgentId); }
  get size() { return this.jobs.size; }
  list() { return [...this.jobs.values()]; }
}

/**
 * 团队房间。
 * opts:
 *   id / name
 *   host    { id, label, personaMbti? }         主持人 (kind=team 的特殊专家, 只调度)
 *   members [{ id, label, readonly? }]          成员 (普通专家)
 *   executor(memberId, message, ctx) -> Promise<string>   真实执行体 (生产接 Legion, 测试接桩)
 *   hostExecutor(message, ctx) -> Promise<string>         主持人自身的回复 (可缺省 → 规则兜底)
 *   processor { composeFollowup?, onReply? }              回叫协议 (Octop TeamProcessor)
 *   file     可选: 落盘路径 (快照 + 时间线)
 */
export class TeamRoom {
  constructor({ id = null, name = "团队", host = null, members = [], executor = null, hostExecutor = null, processor = null, file = null, timelineLimit = 500 } = {}) {
    if (!host || !host.id) throw new Error("TeamRoom: 缺主持人 (host.id)");
    if (!Array.isArray(members) || members.length < 2) throw new Error("TeamRoom: 至少需要 2 名成员 (不含主持人)");
    const ids = new Set([host.id]);
    for (const m of members) {
      if (!m || !m.id) throw new Error("TeamRoom: 成员缺 id");
      if (ids.has(m.id)) throw new Error(`TeamRoom: 重复 id: ${m.id}`);
      ids.add(m.id);
    }
    this.id = id || newId("room");
    this.name = String(name || "团队");
    this.host = { ...host, kind: "host" };
    this.members = members.map((m) => ({ readonly: false, ...m, kind: "member" }));
    this.executor = executor;
    this.hostExecutor = hostExecutor;
    this.processor = {
      composeFollowup: processor?.composeFollowup || composeFollowup,
      onReply: processor?.onReply || null,
    };
    this.tracker = new TeamJobTracker();
    this.inbox = new Map();       // jobId -> InboxMessage
    this.timeline = [];           // 上墙 [{ ts, speaker, speakerId, speakerLabel, text, kind, jobId? }]
    this.timelineLimit = Math.max(50, Number(timelineLimit) || 500);
    this.file = file || null;
    this.closed = false;
    this._chains = new Map();     // memberId -> Promise (同成员串行队列)
    this.createdAt = Date.now();
    this._post({ speaker: SPEAKER.SYSTEM, speakerId: "system", speakerLabel: "系统", text: `房间已创建：${this.name}（主持人 ${this.host.label || this.host.id}，成员 ${this.members.length} 名）`, kind: "lifecycle" });
    this.persist();
  }

  // ---- 编制 ----
  get memberIds() { return this.members.map((m) => m.id); }
  findMember(id) { return this.members.find((m) => m.id === id) || null; }
  isHost(id) { return this.host.id === id; }
  // 成员视角可派工对象 (Octop: 成员被派工时 peer 收窄为同事, 不能再异步拉人)
  peersOf(agentId) {
    if (this.isHost(agentId)) return this.memberIds.slice();
    const m = this.findMember(agentId);
    if (!m) return [];
    return this.memberIds.filter((x) => x !== agentId);
  }

  /**
   * 从编制里移出成员。有在途派工时拒绝 —— 否则结果无处落地 (Octop 的 TEAM_MEMBER_BUSY)。
   * 返回 { ok, reason?, inFlight? }
   */
  removeMember(id, { force = false } = {}) {
    const m = this.findMember(id);
    if (!m) return { ok: false, reason: `TEAM_MEMBER_INVALID: 成员不存在 ${id}` };
    const busy = this.tracker.busyWith(id);
    if (busy.length && !force) {
      return { ok: false, reason: `TEAM_MEMBER_BUSY: ${m.label || id} 有 ${busy.length} 个在途派工`, inFlight: busy.map((j) => j.id) };
    }
    if (busy.length && force) for (const j of busy) this.cancelJob(j.id, "成员已移出编制");
    this.members = this.members.filter((x) => x.id !== id);
    this._post({ speaker: SPEAKER.SYSTEM, speakerId: "system", speakerLabel: "系统", text: `成员已移出编制：${m.label || id}`, kind: "lifecycle" });
    this.persist();
    return { ok: true };
  }

  addMember(member) {
    if (!member || !member.id) return { ok: false, reason: "成员缺 id" };
    if (this.findMember(member.id) || this.isHost(member.id)) return { ok: false, reason: `TEAM_MEMBER_INVALID: id 已被占用 ${member.id}` };
    this.members.push({ readonly: false, ...member, kind: "member" });
    this._post({ speaker: SPEAKER.SYSTEM, speakerId: "system", speakerLabel: "系统", text: `成员已加入编制：${member.label || member.id}`, kind: "lifecycle" });
    this.persist();
    return { ok: true };
  }

  // ---- 上墙 (时间线) ----
  _post(entry) {
    const rec = { ts: Date.now(), text: "", kind: "say", ...entry };
    this.timeline.push(rec);
    if (this.timeline.length > this.timelineLimit) this.timeline = this.timeline.slice(-this.timelineLimit);
    return rec;
  }

  // 读时间线 (支持 since 增量拉取, 供 WS / UI 轮询)
  history({ since = 0, limit = 0 } = {}) {
    const list = this.timeline.filter((e) => e.ts > Number(since || 0));
    return limit > 0 ? list.slice(-limit) : list;
  }

  // ---- 用户说话: 永远先到主持人 ----
  // 返回 { reply, speaker }。用户消息与会话回复都上墙。
  async say(text, { from = "user" } = {}) {
    if (this.closed) return { reply: "[房间已关闭]", speaker: SPEAKER.SYSTEM };
    const userText = String(text || "").trim();
    if (!userText) return { reply: "[空消息]", speaker: SPEAKER.SYSTEM };
    this._post({ speaker: from === "user" ? SPEAKER.USER : from, speakerId: from, speakerLabel: from === "user" ? "用户" : from, text: userText, kind: "say" });
    const reply = await this._speak(SYSTEM_HOST_TASK(userText));
    return { reply, speaker: SPEAKER.HOST };
  }

  // 主持人开口 (内部: 统一走 hostExecutor, 缺省用规则兜底)
  async _speak(message, ctx = {}) {
    let reply = "";
    if (typeof this.hostExecutor === "function") {
      try {
        reply = String((await this.hostExecutor(message, { room: this, ...ctx })) || "").trim();
      } catch (e) {
        warn(`[room:${this.id}] 主持人回复失败: ${e.message}`);
        reply = "";
      }
    }
    if (!reply) reply = fallbackHostReply(message, this);
    this._post({ speaker: SPEAKER.HOST, speakerId: this.host.id, speakerLabel: this.host.label || this.host.id, text: reply, kind: "say", jobId: ctx.jobId || null });
    this.persist();
    return reply;
  }

  /**
   * 异步派工 (Octop 的核心契约: 发完即返回)。
   * 返回 { ok, jobId } 或 { ok:false, reason }
   *   同成员串行 / 不同成员并行 —— 由 _chains 实现 (每个成员一条 promise 链)。
   */
  dispatch(memberId, task, { via = null, perspective = null, timeoutMs = 0 } = {}) {
    if (this.closed) return { ok: false, reason: "房间已关闭" };
    const m = this.findMember(memberId);
    if (!m) return { ok: false, reason: `TEAM_MEMBER_INVALID: 成员不存在 ${memberId}` };
    const msg = String(task || "").trim();
    if (!msg) return { ok: false, reason: "任务内容为空" };
    // 派工者默认是主持人; 成员也能派给同事 (Octop: 成员可同步 ask_agent, 但不能异步拉人入群)
    const dispatcher = via || this.host.id;
    const job = {
      id: "job_" + Math.random().toString(36).slice(2, 10),
      targetAgentId: memberId,
      targetLabel: m.label || memberId,
      sourceAgentId: dispatcher,
      message: msg,
      perspective,
      status: INBOX_STATUS.QUEUED,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
    };
    this.inbox.set(job.id, job);
    this.tracker.open(job);
    this._post({ speaker: SPEAKER.SYSTEM, speakerId: "system", speakerLabel: "系统", text: `已请 ${job.targetLabel} 处理，请稍候…`, kind: "dispatch", jobId: job.id });
    this.persist();
    // 入队: 同成员串行, 不同成员并行
    const prev = this._chains.get(memberId) || Promise.resolve();
    const next = prev.then(() => this._runJob(job.id, { timeoutMs })).catch(() => { /* _runJob 内部已兜底 */ });
    this._chains.set(memberId, next);
    return { ok: true, jobId: job.id, target: job.targetLabel };
  }

  async _runJob(jobId, { timeoutMs = 0 } = {}) {
    const job = this.inbox.get(jobId);
    if (!job) return;
    if (TERMINAL.has(job.status)) return; // 已被取消
    if (typeof this.executor !== "function") {
      this._settle(job, { status: INBOX_STATUS.FAILED, error: "房间未接入执行体 (executor)" });
      return;
    }
    job.status = INBOX_STATUS.RUNNING;
    job.updatedAt = Date.now();
    let result = "";
    try {
      const p = this.executor(job.targetAgentId, job.message, {
        room: this, jobId: job.id, perspective: job.perspective, sourceAgentId: job.sourceAgentId,
      });
      result = timeoutMs > 0 ? await raceTimeout(p, timeoutMs, `${job.targetLabel} 派工超时`) : await p;
    } catch (e) {
      this._settle(job, { status: INBOX_STATUS.FAILED, error: e?.message || String(e) });
      return;
    }
    if (TERMINAL.has(job.status)) return; // 期间被取消
    job.status = INBOX_STATUS.REPLYING;
    job.updatedAt = Date.now();
    const text = String(result || "").trim() || "(成员无回复)";
    // 上墙: 成员气泡 (speaker 标识 = 成员)
    this._post({ speaker: SPEAKER.MEMBER, speakerId: job.targetAgentId, speakerLabel: job.targetLabel, text, kind: "reply", jobId: job.id });
    this._settle(job, { status: INBOX_STATUS.DONE, resultText: text });
  }

  // 收口: 回叫主持人 (Octop 的 compose_followup + on_reply 闭环)
  _settle(job, { status, error = null, resultText = "" }) {
    if (TERMINAL.has(job.status) && job.status === status) return;
    job.status = status;
    job.error = error;
    job.updatedAt = Date.now();
    // 账本释放必须幂等 (成功/失败/取消任一先到都要能关)
    this.tracker.close(job.id, { status, error });
    this.persist();
    if (status === INBOX_STATUS.DONE) {
      const followup = this.processor.composeFollowup(job, resultText);
      // 回叫是**异步**的: 不阻塞派工方; 失败只记日志 (回叫丢了不该把成员结果也丢掉)
      this._chainHost(() => this._speak(followup, { jobId: job.id, reason: "followup" }))
        .then((hostReply) => {
          if (typeof this.processor.onReply === "function") {
            return this.processor.onReply({
              inboxId: job.id, status, sourceAgentId: job.sourceAgentId, targetAgentId: job.targetAgentId,
              replyText: hostReply, errorText: null, metadata: { roomId: this.id, targetLabel: job.targetLabel },
            });
          }
          return null;
        })
        .catch((e) => debug(`[room:${this.id}] 回叫处理异常 (已忽略): ${e && e.message ? e.message : e}`));
    } else if (typeof this.processor.onReply === "function") {
      Promise.resolve(this.processor.onReply({
        inboxId: job.id, status, sourceAgentId: job.sourceAgentId, targetAgentId: job.targetAgentId,
        replyText: null, errorText: error, metadata: { roomId: this.id, targetLabel: job.targetLabel },
      })).catch(() => { /* 通知失败不影响状态机 */ });
    }
  }

  // 主持人侧串行 (Octop: "主持人回叫按源 thread_id 串行") —— 避免多条回报同时抢主持人
  _chainHost(fn) {
    const key = "__host__";
    const prev = this._chains.get(key) || Promise.resolve();
    const next = prev.then(fn).catch((e) => { warn(`[room:${this.id}] 主持人回叫失败: ${e.message}`); return ""; });
    this._chains.set(key, next);
    return next;
  }

  cancelJob(jobId, reason = "手动取消") {
    const job = this.inbox.get(jobId);
    if (!job) return { ok: false, reason: "job 不存在" };
    if (TERMINAL.has(job.status)) return { ok: false, reason: `job 已结束 (${job.status})` };
    job.status = INBOX_STATUS.CANCELLED;
    job.error = reason;
    job.updatedAt = Date.now();
    this.tracker.close(jobId, { status: INBOX_STATUS.CANCELLED, error: reason });
    this._post({ speaker: SPEAKER.SYSTEM, speakerId: "system", speakerLabel: "系统", text: `已取消 ${job.targetLabel} 的任务：${reason}`, kind: "system", jobId });
    this.persist();
    return { ok: true };
  }

  // 等待全部在途完成 (收口 / 测试). 返回已结算的 job 列表。
  async drain({ timeoutMs = 0 } = {}) {
    const chains = [...this._chains.values()];
    const all = Promise.all(chains.map((p) => p.catch(() => null)));
    if (timeoutMs > 0) await raceTimeout(all, timeoutMs, "drain 超时").catch(() => null);
    else await all;
    // 链会继续被新任务替换, 循环到真正没有在途为止
    if (this.tracker.size > 0) {
      const more = [...this._chains.values()];
      await Promise.all(more.map((p) => p.catch(() => null)));
    }
    return [...this.inbox.values()].filter((j) => TERMINAL.has(j.status));
  }

  // 状态视图 (供 team_room_status 工具 / UI)
  status() {
    const jobs = [...this.inbox.values()];
    const count = (s) => jobs.filter((j) => j.status === s).length;
    return {
      roomId: this.id,
      name: this.name,
      closed: this.closed,
      host: { id: this.host.id, label: this.host.label || this.host.id },
      members: this.members.map((m) => ({
        id: m.id, label: m.label || m.id, readonly: !!m.readonly,
        inFlight: this.tracker.busyWith(m.id).length,
      })),
      jobs: {
        total: jobs.length,
        queued: count(INBOX_STATUS.QUEUED), running: count(INBOX_STATUS.RUNNING), replying: count(INBOX_STATUS.REPLYING),
        done: count(INBOX_STATUS.DONE), failed: count(INBOX_STATUS.FAILED), cancelled: count(INBOX_STATUS.CANCELLED),
        inFlight: this.tracker.size,
      },
      timelineLength: this.timeline.length,
      createdAt: this.createdAt,
    };
  }

  listJobs({ target = null, status = null, limit = 20 } = {}) {
    let out = [...this.inbox.values()];
    if (target) out = out.filter((j) => j.targetAgentId === target);
    if (status) out = out.filter((j) => j.status === status);
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  // ---- 持久化 (快照; 在途任务不持久化 —— 与 Octop 一致: 重启丢在途, 锁消失可再改编制) ----
  snapshot() {
    return {
      version: 1,
      id: this.id,
      name: this.name,
      host: this.host,
      members: this.members,
      timeline: this.timeline.slice(-this.timelineLimit),
      createdAt: this.createdAt,
      savedAt: Date.now(),
    };
  }

  persist() {
    if (!this.file) return false;
    try {
      ensureDir(path.dirname(this.file));
      writeJson(this.file, this.snapshot());
      return true;
    } catch (e) {
      debug(`[room:${this.id}] 落盘失败 (已忽略): ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  static restore(file, opts = {}) {
    const snap = readJson(file, null);
    if (!snap || !snap.host || !Array.isArray(snap.members)) return null;
    const room = new TeamRoom({ ...opts, id: snap.id, name: snap.name, host: snap.host, members: snap.members, file });
    if (Array.isArray(snap.timeline) && snap.timeline.length) {
      room.timeline = snap.timeline.slice(-room.timelineLimit);
      room._post({ speaker: SPEAKER.SYSTEM, speakerId: "system", speakerLabel: "系统", text: "房间已从快照恢复（在途任务不恢复）", kind: "lifecycle" });
    }
    return room;
  }

  close() {
    for (const j of this.tracker.list()) this.cancelJob(j.id, "房间关闭");
    this.closed = true;
    this.persist();
    info(`[room:${this.id}] 已关闭 (成员 ${this.members.length} 名, 时间线 ${this.timeline.length} 条)`);
    return true;
  }
}

// ---- 主持人缺省回复 (没有 hostExecutor 时的规则兜底) ----
// 刻意做得"像调度者而不像业务专家": 主持人不该抢成员的活, 也不该编内容。
export function fallbackHostReply(message, room) {
  const m = String(message || "");
  if (m.startsWith("【成员回报】")) {
    const name = (m.match(/【成员回报】(\S+)/) || [])[1] || "成员";
    const inflight = room?.tracker?.size || 0;
    if (inflight > 0) return `${name} 的产出已上墙。还有 ${inflight} 条在途，等齐了我一起收口。`;
    return `${name} 的产出已上墙。本轮到此，需要我继续派活直接说。`;
  }
  const names = (room?.members || []).map((x) => x.label || x.id).join("、");
  return `收到。当前成员：${names || "(空)"}。需要谁出手直接点名，我按依赖关系派——能一个人干完的我不凑人头。`;
}

function raceTimeout(p, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label)), ms); });
  return Promise.race([Promise.resolve(p), t]).finally(() => clearTimeout(timer));
}

function SYSTEM_HOST_TASK(text) {
  return `${text}\n\n（你是这个团队的主持人：只调度，不替成员干专业活。需要谁出手就明确派工。）`;
}

export default { TeamRoom, TeamJobTracker, INBOX_STATUS, SPEAKER, composeFollowup, fallbackHostReply };
