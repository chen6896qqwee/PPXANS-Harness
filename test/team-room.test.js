// test/team-room.test.js - 团队房间运行时 + 会话键 scheme (2026-10-07 吸收自 TencentCloud/Octop)
// 钉住 Octop 的三条核心契约:
//   ① **异步派工 + 回叫闭环**: dispatch 发完即返回; 成员完成 → 上墙 → 用 compose_followup
//      叫醒主持人 → 主持人收口 → on_reply 通知宿主 (不是成员自己去找主持人)
//   ② **按 callee 并发**: 同一成员串行 (同工作区不并发写), 不同成员并行
//   ③ **在途派工账本**: 有在途任务的成员不能被移出编制 (TEAM_MEMBER_BUSY)
// 外加: 房间时间线带 speaker / 状态机六态 / 快照恢复 / 关闭取消在途 / 会话键四段编码
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TeamRoom, TeamJobTracker, INBOX_STATUS, SPEAKER, composeFollowup } from "../src/orchestrator/room.js";
import { sessionKeyFor, parseSessionKey, isSessionKey, normalizeSessionKey, withScope, roomKey, parseRoomKey } from "../src/orchestrator/session-key.js";
import { PPXAgent } from "../src/agent/index.js";
import { setLevel } from "../src/utils/logger.js";

setLevel("error");
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-room-${tag}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 可控 executor: 记录调用顺序 (start/end), 可注入延迟与失败
function stubExecutor({ delay = 20, failOn = null, callLog = [] } = {}) {
  return async (memberId, message) => {
    callLog.push(`start:${memberId}:${message}`);
    await sleep(delay);
    if (failOn && message.includes(failOn)) {
      callLog.push(`throw:${memberId}`);
      throw new Error("模拟失败");
    }
    callLog.push(`end:${memberId}`);
    return `${memberId} 的产出：${message}`;
  };
}

function mkRoom(opts = {}) {
  const replies = [];
  const room = new TeamRoom({
    name: "测试团队",
    host: { id: "host", label: "主持人" },
    members: [{ id: "a", label: "成员A" }, { id: "b", label: "成员B" }],
    ...opts,
    processor: { onReply: async (ev) => { replies.push(ev); }, ...(opts.processor || {}) },
  });
  room.__replies = replies;
  return room;
}

// ---- ① 生命周期 ----
test("room: 建房间需要主持人 + 至少 2 名成员, id 不可重复", () => {
  assert.throws(() => new TeamRoom({ host: null, members: [{ id: "a" }, { id: "b" }] }), /缺主持人/);
  assert.throws(() => new TeamRoom({ host: { id: "h" }, members: [{ id: "a" }] }), /至少需要 2 名成员/);
  assert.throws(() => new TeamRoom({ host: { id: "h" }, members: [{ id: "a" }, { id: "a" }] }), /重复 id/);
  assert.throws(() => new TeamRoom({ host: { id: "h" }, members: [{ id: "a" }, { id: "h" }] }), /重复 id/);
  const r = mkRoom();
  assert.ok(r.id);
  assert.equal(r.history()[0].kind, "lifecycle");
  assert.equal(r.history()[0].speaker, SPEAKER.SYSTEM);
});

// ---- ② 按 callee 并发 ----
test("room: 同成员串行、不同成员并行", async () => {
  const log = [];
  const room = mkRoom({ executor: stubExecutor({ delay: 30, callLog: log }) });
  room.dispatch("a", "任务1");
  room.dispatch("b", "任务2");
  room.dispatch("a", "任务3");
  await room.drain();
  const seq = log.filter((x) => !x.startsWith("throw"));
  // a 的两条必须首尾相接 (串行); b 与 a 的第一条并行 (start:b 出现在 end:a1 之前)
  assert.deepEqual(seq, ["start:a:任务1", "start:b:任务2", "end:a", "start:a:任务3", "end:b", "end:a"],
    `实际: ${seq.join(" → ")}`);
});

test("room: 派工立即返回 (不阻塞), 完成后才落 status", async () => {
  const room = mkRoom({ executor: stubExecutor({ delay: 40 }) });
  const t0 = Date.now();
  const r = room.dispatch("a", "慢活");
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(elapsed < 20, `dispatch 应立即返回, 实测 ${elapsed}ms`);
  assert.equal(room.inbox.get(r.jobId).status, INBOX_STATUS.QUEUED);
  await room.drain();
  assert.equal(room.inbox.get(r.jobId).status, INBOX_STATUS.DONE);
});

// ---- ③ 回叫闭环 ----
test("room: 成员产出上墙 → 主持人收口 → onReply 通知", async () => {
  const room = mkRoom({ executor: stubExecutor({ delay: 5 }) });
  const j = room.dispatch("a", "写个方案");
  await room.drain();
  const tl = room.history();
  const memberMsg = tl.find((e) => e.speaker === SPEAKER.MEMBER);
  assert.ok(memberMsg, "成员气泡上墙");
  assert.equal(memberMsg.speakerId, "a");
  assert.equal(memberMsg.speakerLabel, "成员A");
  assert.equal(memberMsg.jobId, j.jobId);
  const hostMsg = tl.filter((e) => e.speaker === SPEAKER.HOST).pop();
  assert.ok(hostMsg, "主持人收口回复上墙");
  assert.equal(room.__replies.length, 1, "onReply 被调用一次");
  assert.equal(room.__replies[0].status, INBOX_STATUS.DONE);
  assert.equal(room.__replies[0].targetAgentId, "a");
  assert.ok(room.__replies[0].replyText, "带主持人收口正文");
});

test("room: composeFollowup 默认实现要求判收工且不复述正文", () => {
  const text = composeFollowup({ targetLabel: "成员A", targetAgentId: "a", message: "做调研" }, "调研结果……");
  assert.ok(text.includes("成员A"));
  assert.ok(text.includes("做调研"));
  assert.ok(text.includes("调研结果"));
  assert.ok(text.includes("收工"), "要求判是否收工");
  assert.ok(text.includes("不要") || text.includes("不要再复述"), "要求不复述成员正文");
});

test("room: 失败也进状态机并通知 (不静默吞掉)", async () => {
  const room = mkRoom({ executor: stubExecutor({ failOn: "炸", delay: 5 }) });
  const j = room.dispatch("a", "让它炸");
  await room.drain();
  const job = room.inbox.get(j.jobId);
  assert.equal(job.status, INBOX_STATUS.FAILED);
  assert.match(job.error, /模拟失败/);
  const notice = room.__replies.find((r) => r.status === INBOX_STATUS.FAILED);
  assert.ok(notice, "失败也要 onReply");
  assert.match(notice.errorText, /模拟失败/);
});

test("room: 未接入执行体时明确失败而非静默", async () => {
  const room = mkRoom({ executor: null });
  const j = room.dispatch("a", "活");
  await room.drain();
  assert.equal(room.inbox.get(j.jobId).status, INBOX_STATUS.FAILED);
  assert.match(room.inbox.get(j.jobId).error, /未接入执行体/);
});

// ---- ③ 在途账本 ----
test("room: 有在途派工时拒绝移出成员 (TEAM_MEMBER_BUSY), force 可强移并取消在途", async () => {
  const log = [];
  const room = mkRoom({ executor: stubExecutor({ delay: 30, callLog: log }) });
  room.dispatch("a", "长任务");
  const denied = room.removeMember("a");
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /TEAM_MEMBER_BUSY/);
  assert.equal(denied.inFlight.length, 1);
  assert.equal(room.findMember("a").id, "a", "拒绝后成员仍在编制");
  const forced = room.removeMember("a", { force: true });
  assert.equal(forced.ok, true);
  assert.equal(room.findMember("a"), null);
  await room.drain();
  assert.ok(room.inbox.get(denied.inFlight[0]).status === INBOX_STATUS.CANCELLED, "强移时在途被取消");
});

test("room: 空闲时可自由增删成员, 重名拒绝", () => {
  const room = mkRoom({ executor: stubExecutor() });
  assert.equal(room.removeMember("b").ok, true);
  assert.equal(room.addMember({ id: "b", label: "成员B" }).ok, true);
  assert.equal(room.addMember({ id: "b" }).ok, false, "重名拒绝");
  assert.equal(room.addMember({ id: "host" }).ok, false, "与主持人同名拒绝");
  assert.equal(room.addMember({}).ok, false);
  assert.equal(room.removeMember("不存在").ok, false);
});

test("room: 账本释放幂等 (成功/失败/取消任一先到都只释放一次)", () => {
  const t = new TeamJobTracker();
  t.open({ id: "j1", targetAgentId: "a" });
  assert.equal(t.isBusy("a"), true);
  assert.equal(t.close("j1"), true);
  assert.equal(t.close("j1"), false, "重复释放被忽略");
  assert.equal(t.isBusy("a"), false);
  assert.equal(t.size, 0);
  assert.equal(t.close("nope"), false);
});

// ---- 状态机与视图 ----
test("room: status 统计六态与在途数; listJobs 可过滤", async () => {
  const room = mkRoom({ executor: stubExecutor({ delay: 5, failOn: "炸" }) });
  room.dispatch("a", "正常活");
  room.dispatch("b", "让它炸");
  await room.drain();
  const st = room.status();
  assert.equal(st.jobs.total, 2);
  assert.equal(st.jobs.done, 1);
  assert.equal(st.jobs.failed, 1);
  assert.equal(st.jobs.inFlight, 0);
  assert.equal(st.members.length, 2);
  assert.equal(st.members.every((m) => m.inFlight === 0), true);
  assert.equal(room.listJobs({ target: "a" }).length, 1);
  assert.equal(room.listJobs({ status: INBOX_STATUS.FAILED }).length, 1);
});

test("room: cancelJob 幂等拒绝终态任务", async () => {
  const room = mkRoom({ executor: stubExecutor({ delay: 40 }) });
  const j = room.dispatch("a", "活");
  assert.equal(room.cancelJob(j.jobId).ok, true);
  assert.equal(room.cancelJob(j.jobId).ok, false, "已取消不再重复取消");
  assert.equal(room.cancelJob("不存在").ok, false);
  const st = room.status();
  assert.equal(st.jobs.cancelled, 1);
});

test("room: 用户消息永远先到主持人, 主持人回复上墙", async () => {
  const room = mkRoom({ executor: stubExecutor(), hostExecutor: async (m) => `主持人对「${m.slice(0, 6)}」的回应` });
  const { reply } = await room.say("帮我安排一下");
  assert.match(reply, /主持人对/);
  const tl = room.history();
  assert.equal(tl[1].speaker, SPEAKER.USER);
  assert.equal(tl[1].text, "帮我安排一下");
  assert.equal(tl[2].speaker, SPEAKER.HOST);
});

test("room: peersOf 收窄 (主持人看全部成员; 成员只看同事)", () => {
  const room = mkRoom();
  assert.deepEqual(room.peersOf("host").sort(), ["a", "b"]);
  assert.deepEqual(room.peersOf("a"), ["b"], "成员不能派给自己");
  assert.deepEqual(room.peersOf("外部"), [], "非成员无 peer");
});

test("room: history 支持 since 增量拉取", async () => {
  const room = mkRoom({ executor: stubExecutor({ delay: 3 }) });
  await room.say("一");
  const mark = room.history().pop().ts;
  await sleep(5);
  await room.say("二");
  const inc = room.history({ since: mark });
  assert.ok(inc.length >= 1);
  assert.ok(inc.every((e) => e.ts > mark));
  assert.equal(inc.filter((e) => e.text === "一").length, 0, "旧消息不重复返回");
});

// ---- 持久化 ----
test("room: 快照落盘 + 恢复 (在途任务不恢复)", async () => {
  const dir = tmp("snap");
  try {
    const file = path.join(dir, "r.json");
    const room = mkRoom({ executor: stubExecutor({ delay: 5 }), file });
    await room.say("存一下");
    room.dispatch("a", "一条");
    await room.drain();
    assert.ok(fs.existsSync(file), "落盘");
    const restored = TeamRoom.restore(file, { executor: stubExecutor() });
    assert.ok(restored);
    assert.equal(restored.id, room.id);
    assert.equal(restored.members.length, 2);
    assert.ok(restored.history().some((e) => e.text === "存一下"), "时间线被恢复");
    assert.equal(restored.tracker.size, 0, "在途不恢复 (与 Octop 一致: 重启丢在途)");
    assert.ok(restored.history().some((e) => /快照恢复/.test(e.text)));
    assert.equal(TeamRoom.restore(path.join(dir, "nope.json")), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("room: close 取消全部在途并标记关闭", async () => {
  const room = mkRoom({ executor: stubExecutor({ delay: 100 }) });
  room.dispatch("a", "长活");
  room.close();
  assert.equal(room.closed, true);
  assert.equal(room.tracker.size, 0);
  const r = room.dispatch("b", "还有活");
  assert.equal(r.ok, false, "关闭后拒绝派工");
  const said = await room.say("在吗");
  assert.match(said.reply, /已关闭/);
});

// ---- 会话键 scheme ----
test("session-key: 四段编码与反解析往返一致", () => {
  const k = sessionKeyFor({ agentId: "ppx", surface: "feishu", session: "user_7", scope: "dm" });
  assert.equal(k, "ppx:feishu:user_7:dm");
  assert.deepEqual(parseSessionKey(k), { agentId: "ppx", surface: "feishu", session: "user_7", scope: "dm", raw: k });
  assert.equal(isSessionKey(k), true);
  assert.equal(isSessionKey("default"), false);
  // 群聊
  assert.equal(sessionKeyFor({ agentId: "ppx", surface: "wechat", session: "oc_abc", scope: "group" }), "ppx:wechat:oc_abc:group");
  // 段数不对 → null
  assert.equal(parseSessionKey("a:b:c"), null);
  assert.equal(parseSessionKey("a:b:c:d:e"), null);
  // scope 非法 → null (不做隐式纠正, 免得老键被悄悄改写)
  assert.equal(parseSessionKey("a:b:c:weird"), null);
});

test("session-key: 非法字符被替换 (含 ':' 会错位, 是静默串台的根源)", () => {
  const k = sessionKeyFor({ agentId: "a:b", surface: "cli", session: "c d", scope: "dm" });
  assert.equal(k.split(":").length, 4, "替换后仍是四段");
  assert.ok(parseSessionKey(k), "替换后可解析");
});

test("session-key: normalizeSessionKey 兼容老裸键; withScope 换作用域", () => {
  assert.equal(normalizeSessionKey("default"), "ppx:cli:default:dm");
  const already = "ppx:web:u1:dm";
  assert.equal(normalizeSessionKey(already), already, "已是规范键原样返回");
  assert.equal(withScope(already, "group"), "ppx:web:u1:group");
  assert.equal(withScope("default", "group", { surface: "feishu" }), "ppx:feishu:default:group");
});

test("session-key: 房间键 房间~成员", () => {
  assert.equal(roomKey("room1"), "room1");
  assert.equal(roomKey("room1", "a"), "room1~a");
  assert.deepEqual(parseRoomKey("room1~a"), { roomId: "room1", memberId: "a", raw: "room1~a" });
  assert.deepEqual(parseRoomKey("room1"), { roomId: "room1", memberId: null, raw: "room1" });
});

// ---- 工具层 ----
test("team_room 工具: 开房间 → 派工 → 状态 → 上墙 → 关闭 全链路", async () => {
  const agent = new PPXAgent({ root: path.resolve("."), dataDir: tmp("tools") });
  try {
    const open = await agent.tools.call("team_room_open", {
      name: "研发小组", members: ["ops-engineer", "ai-coding-coach"],
    }, { agent });
    assert.ok(open.includes("房间已开"), open.slice(0, 200));
    const roomId = (open.match(/room_id: (\S+)/) || [])[1];
    assert.ok(roomId, "返回 room_id");
    assert.ok(open.includes("运维工程师") && open.includes("AI 编程实战导师"), "专家包被解析成成员");

    // 桩替真实 executor (不 spawn 子进程)
    const room = agent._rooms.get(roomId);
    assert.ok(room, "房间进了注册表");
    room.executor = stubExecutor({ delay: 5 });

    const st0 = await agent.tools.call("team_room_status", { room_id: roomId }, { agent });
    assert.ok(st0.includes("成员 (2)"), st0.slice(0, 200));

    const disp = await agent.tools.call("team_room_dispatch", {
      room_id: roomId, member: "ops-engineer", task: "看看磁盘", wait: true,
    }, { agent });
    assert.ok(disp.includes("已派工"), disp.slice(0, 160));
    assert.ok(disp.includes("状态: 完成"), disp.slice(0, 240));
    assert.ok(disp.includes("产出"), "wait=true 直接返回产出");

    const hist = await agent.tools.call("team_room_history", { room_id: roomId }, { agent });
    assert.ok(hist.includes("运维工程师"), "上墙记录带说话人");

    const jobs = await agent.tools.call("team_room_manage", { room_id: roomId, action: "list_jobs" }, { agent });
    assert.ok(jobs.includes("[done]"), jobs.slice(0, 200));

    const closed = await agent.tools.call("team_room_close", { room_id: roomId }, { agent });
    assert.ok(closed.includes("房间已关闭"));
    assert.equal(agent._rooms.has(roomId), false, "关闭后从注册表移除");

    // 错误路径
    assert.ok((await agent.tools.call("team_room_status", { room_id: "nope" }, { agent })).includes("[工具错误]"));
    assert.ok((await agent.tools.call("team_room_open", { members: ["ops-engineer"] }, { agent })).includes("至少 2 名成员"));
  } finally {
    agent.shutdown();
    fs.rmSync(agent.dataDir, { recursive: true, force: true });
  }
});

test("team_room 工具: 在途时 remove_member 被拒 (工具层同样受账本约束)", async () => {
  const agent = new PPXAgent({ root: path.resolve("."), dataDir: tmp("busy") });
  try {
    const open = await agent.tools.call("team_room_open", { name: "忙组", members: ["ops-engineer", "data-analyst"] }, { agent });
    const roomId = (open.match(/room_id: (\S+)/) || [])[1];
    const room = agent._rooms.get(roomId);
    room.executor = stubExecutor({ delay: 60 });
    await agent.tools.call("team_room_dispatch", { room_id: roomId, member: "ops-engineer", task: "慢活" }, { agent });
    const denied = await agent.tools.call("team_room_manage", { room_id: roomId, action: "remove_member", member: "ops-engineer" }, { agent });
    assert.ok(denied.includes("TEAM_MEMBER_BUSY"), denied.slice(0, 200));
    await room.drain();
    const ok = await agent.tools.call("team_room_manage", { room_id: roomId, action: "remove_member", member: "ops-engineer" }, { agent });
    assert.ok(ok.includes("已移出成员"), ok.slice(0, 160));
  } finally {
    agent.shutdown();
    fs.rmSync(agent.dataDir, { recursive: true, force: true });
  }
});

test("team_room 工具: 班组名展开成成员 + 高风险班组带复核提示", async () => {
  const agent = new PPXAgent({ root: path.resolve("."), dataDir: tmp("team") });
  try {
    const open = await agent.tools.call("team_room_open", { name: "评审房", members: ["评审", "general-assistant"] }, { agent });
    assert.ok(open.includes("安全专家") || open.includes("合规"), "班组被展开: " + open.slice(0, 260));
    assert.ok(open.includes("⚠ 含高风险域成员"), "高风险成员触发复核提示");
  } finally {
    agent.shutdown();
    fs.rmSync(agent.dataDir, { recursive: true, force: true });
  }
});

test("delegate: 专家包 id 能被 spawn_agent 的 expert 参数解析", async () => {
  const agent = new PPXAgent({ root: path.resolve("."), dataDir: tmp("deleg") });
  try {
    agent.llm = { chat: async () => ({ content: "x" }) };
    let gotPerspective = null;
    agent._legion = {
      spawnAgent: () => {},
      send: async (name, msg) => { gotPerspective = msg.perspective; return { reply: "ok" }; },
    };
    const res = await agent.tools.call("spawn_agent", { task: "看下代码", expert: "ai-coding-coach" }, { agent });
    assert.equal(res, "ok");
    assert.ok(gotPerspective && gotPerspective.includes("AI 编程实战导师"), "专家包人格块被注入为视角");
    assert.ok(gotPerspective.includes("## 行为约定"), "含 MBTI 骨架 (包声明了 persona_mbti)");
  } finally {
    agent.shutdown();
    fs.rmSync(agent.dataDir, { recursive: true, force: true });
  }
});
