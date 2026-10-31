// test/trigger-policy.test.js - Trigger 两级事件过滤 (2026-10-31 Super-agent 一期)
// 覆盖: 程序层 Fast Path (mode/黑白名单/first-match/deny 恒胜); 语义层 Slow Path
//       (fail-open 语义); admitThroughPolicy 全链 (含 tracer 留痕与会话键产出)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { admitTrigger, admitSemantic, admitThroughPolicy, normalizePolicy } from "../src/channels/policy.js";
import { createTrigger } from "../src/channels/trigger.js";

function mkAgent({ policy = {}, llm = null } = {}) {
  const events = [];
  return {
    agent: {
      config: { agent: { trigger_policy: policy } },
      tracer: { event: (type, payload) => events.push({ type, payload }) },
      ...(llm ? { auxLLM: llm } : {}),
    },
    events,
  };
}

test("normalizePolicy: 脏配置收敛为安全默认 (mode=all = 不过滤)", () => {
  const p = normalizePolicy(null);
  assert.equal(p.mode, "all");
  assert.equal(p.semantic, false);
  assert.equal(p.session_mapping, "chat");
  assert.deepEqual(p.deny_groups, []);
  const bad = normalizePolicy({ mode: "hack", semantic: "yes", deny_groups: "oc_x", session_mapping: 42 });
  assert.equal(bad.mode, "all", "非法 mode 回落 all");
  assert.equal(bad.semantic, false, "非布尔 semantic 回落 false");
  assert.deepEqual(bad.deny_groups, [], "非数组黑名单收敛为空");
  assert.equal(bad.session_mapping, "chat", "非法 mapping 回落 chat");
});

test("admitTrigger: mode=all 全放行, deny 命中才拦", () => {
  const t = createTrigger({ source: "feishu", from: "ou_u", group: "oc_g", text: "x" });
  assert.equal(admitTrigger(t, { mode: "all" }).ok, true);
  assert.equal(admitTrigger(t, {}).ok, true, "无配置 = 不过滤 (行为不变)");
  assert.equal(admitTrigger(t, { deny_groups: ["oc_g"] }).ok, false);
  assert.equal(admitTrigger(t, { deny_groups: ["oc_other"] }).ok, true);
  assert.equal(admitTrigger(t, { deny_senders: ["ou_u"] }).ok, false);
});

test("admitTrigger: mode=off 全拦 (渠道可整体静默)", () => {
  const t = createTrigger({ source: "feishu", from: "ou_u", text: "x" });
  const r = admitTrigger(t, { mode: "off" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /mode=off/);
});

test("admitTrigger: whitelist 群或发送者任一命中放行, 都未命中拦", () => {
  const inGroup = createTrigger({ source: "feishu", from: "ou_stranger", group: "oc_ok", text: "x" });
  const bySender = createTrigger({ source: "feishu", from: "ou_boss", group: "oc_other", text: "x" });
  const outsider = createTrigger({ source: "feishu", from: "ou_stranger", group: "oc_other", text: "x" });
  const policy = { mode: "whitelist", allow_groups: ["oc_ok"], allow_senders: ["ou_boss"] };
  assert.equal(admitTrigger(inGroup, policy).ok, true);
  assert.equal(admitTrigger(bySender, policy).ok, true);
  const r = admitTrigger(outsider, policy);
  assert.equal(r.ok, false);
  assert.match(r.reason, /whitelist/);
});

test("admitTrigger: deny 恒胜 —— 黑名单里的群即使同时进白名单也拦", () => {
  const t = createTrigger({ source: "feishu", from: "ou_u", group: "oc_bad", text: "x" });
  const policy = { mode: "whitelist", allow_groups: ["oc_bad", "oc_ok"], deny_groups: ["oc_bad"] };
  assert.equal(admitTrigger(t, policy).ok, false, "deny 先于 allow 判定");
});

test("admitSemantic: 未启用 semantic 或无 LLM 时 fail-open 放行", async () => {
  const t = createTrigger({ source: "feishu", from: "ou_u", text: "x" });
  const { agent } = mkAgent({ policy: { semantic: false } });
  assert.equal((await admitSemantic(t, agent)).ok, true, "semantic=off 直接放行");
  const { agent: noLlm } = mkAgent({ policy: { semantic: true } });
  const r = await admitSemantic(t, noLlm);
  assert.equal(r.ok, true, "无 LLM fail-open (拦错用户消息代价更高)");
  assert.match(r.reason, /fail-open/);
});

test("admitSemantic: LLM 答 NO 拦下噪音; YES 放行; LLM 异常 fail-open", async () => {
  const t = createTrigger({ source: "feishu", from: "ou_u", text: "帮我查下天气" });
  const no = mkAgent({ policy: { semantic: true }, llm: { chat: async () => ({ content: "NO" }) } });
  assert.equal((await admitSemantic(t, no.agent)).ok, false);
  const yes = mkAgent({ policy: { semantic: true }, llm: { chat: async () => ({ content: "YES" }) } });
  assert.equal((await admitSemantic(t, yes.agent)).ok, true);
  const boom = mkAgent({ policy: { semantic: true }, llm: { chat: async () => { throw new Error("超时"); } } });
  const r = await admitSemantic(t, boom.agent);
  assert.equal(r.ok, true, "LLM 挂了也放行");
  assert.match(r.reason, /fail-open/);
});

test("admitThroughPolicy: 程序层拦下 → ok:false 且不再进语义层", async () => {
  const t = createTrigger({ source: "feishu", from: "ou_u", group: "oc_g", text: "x" });
  const { agent, events } = mkAgent({ policy: { deny_groups: ["oc_g"], semantic: true } });
  const r = await admitThroughPolicy(t, agent);
  assert.equal(r.ok, false);
  assert.equal(r.sessionKey, null);
  assert.equal(events.length, 1, "程序层拦截后不再调 LLM");
  assert.equal(events[0].type, "trigger/filtered");
  assert.equal(events[0].payload.stage, "program");
});

test("admitThroughPolicy: 全链放行产出会话键, 两级留痕, sessionKey 受 mapping 控制", async () => {
  const t = createTrigger({ source: "feishu", from: "ou_u", group: "oc_g", text: "x" });
  const { agent, events } = mkAgent({ policy: { mode: "all" } });
  const r = await admitThroughPolicy(t, agent);
  assert.equal(r.ok, true);
  assert.equal(r.sessionKey, "ppx:feishu:oc_g:group");
  assert.deepEqual(events.map((e) => e.payload.stage), ["program", "semantic"], "两级各留痕一次");
  const shared = mkAgent({ policy: { session_mapping: "shared" } });
  const r2 = await admitThroughPolicy(t, shared.agent);
  assert.equal(r2.ok, true);
  assert.equal(r2.sessionKey, null, "shared 回退: 调用方不传 sessionKey");
});

test("admitThroughPolicy: 裸 agent (无 tracer 无 config) 不炸", async () => {
  const t = createTrigger({ source: "feishu", from: "ou_u", text: "x" });
  const r = await admitThroughPolicy(t, {});
  assert.equal(r.ok, true, "无任何配置 = 行为不变 (放行)");
  assert.equal(r.sessionKey, "ppx:feishu:ou_u:dm");
});
