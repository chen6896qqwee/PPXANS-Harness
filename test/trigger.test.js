// test/trigger.test.js - Trigger 结构化事件对象 (2026-10-31 Super-agent 一期)
// 覆盖: 飞书 v2 三种事件形态 (p2p/群/话题回复) → Trigger 字段; 微信字段提取;
//       Trigger → 四段式会话键映射 (含 shared 回退); id 唯一性。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTrigger, triggerFromFeishuEvent, triggerFromWechatFields, sessionKeyForTrigger,
} from "../src/channels/trigger.js";

test("createTrigger: id 唯一且 scope 按群组推导", () => {
  const a = createTrigger({ source: "feishu", from: "ou_u", text: "hi" });
  const b = createTrigger({ source: "feishu", from: "ou_u", text: "hi" });
  assert.notEqual(a.id, b.id, "同秒创建的两条 Trigger 也必须不同 id");
  assert.match(a.id, /^tg-[0-9a-z]+-[0-9a-z]+$/);
  assert.equal(a.scope, "dm");
  const g = createTrigger({ source: "feishu", group: "oc_x", text: "hi" });
  assert.equal(g.scope, "group");
});

test("triggerFromFeishuEvent: p2p 私聊 → 会话按发送者分", () => {
  const ev = {
    message: { message_id: "om_1", chat_id: "oc_p2p", chat_type: "p2p", content: JSON.stringify({ text: "你好" }) },
    sender: { sender_id: { open_id: "ou_u" } },
  };
  const t = triggerFromFeishuEvent(ev);
  assert.equal(t.source, "feishu");
  assert.equal(t.from, "ou_u");
  assert.equal(t.group, "", "p2p 不归群组");
  assert.equal(t.thread, "");
  assert.equal(t.messageId, "om_1");
  assert.equal(t.text, "你好");
  assert.equal(sessionKeyForTrigger(t), "ppx:feishu:ou_u:dm");
});

test("triggerFromFeishuEvent: 群聊按 chat_id 归组 (scope=group)", () => {
  const ev = {
    message: { message_id: "om_2", chat_id: "oc_g1", chat_type: "group", content: JSON.stringify({ text: "群里说话" }) },
    sender: { sender_id: { open_id: "ou_u" } },
  };
  const t = triggerFromFeishuEvent(ev);
  assert.equal(t.group, "oc_g1");
  assert.equal(t.scope, "group");
  assert.equal(sessionKeyForTrigger(t), "ppx:feishu:oc_g1:group");
});

test("triggerFromFeishuEvent: 话题回复按 root_id 归到话题串 (chat_id-root_id 惯例)", () => {
  const ev = {
    message: {
      message_id: "om_3", chat_id: "oc_g1", chat_type: "group",
      root_id: "om_root", parent_id: "om_parent", content: JSON.stringify({ text: "跟帖" }),
    },
    sender: { sender_id: { open_id: "ou_u" } },
  };
  const t = triggerFromFeishuEvent(ev);
  assert.equal(t.thread, "om_root", "root_id 优先于 parent_id (话题串根)");
  assert.equal(sessionKeyForTrigger(t), "ppx:feishu:oc_g1-om_root:group", "同话题独立会话, 不与群主时间线串台");
});

test("triggerFromFeishuEvent: content 非 JSON 时不炸 (text 退化空串)", () => {
  const t = triggerFromFeishuEvent({ message: { chat_type: "p2p", content: "{oops" }, sender: { sender_id: { open_id: "ou_u" } } });
  assert.equal(t.text, "");
});

test("triggerFromWechatFields: 字段提取 + CreateTime 秒转毫秒", () => {
  const t = triggerFromWechatFields({ from: "wx_user", messageId: "MSG42", text: "在吗", createTime: 1700000000 });
  assert.equal(t.source, "wechat");
  assert.equal(t.from, "wx_user");
  assert.equal(t.messageId, "MSG42");
  assert.equal(t.text, "在吗");
  assert.equal(t.ts, 1700000000000);
  assert.equal(t.group, "", "微信回调无群组概念");
  assert.equal(sessionKeyForTrigger(t), "ppx:wechat:wx_user:dm");
});

test("sessionKeyForTrigger: shared 返回 null (调用方不传 sessionKey, 精确回退旧行为)", () => {
  const t = createTrigger({ source: "feishu", from: "ou_u", group: "oc_g", thread: "om_r", text: "x" });
  assert.equal(sessionKeyForTrigger(t, { sessionMapping: "shared" }), null);
  assert.equal(sessionKeyForTrigger(t, {}), "ppx:feishu:oc_g-om_r:group", "缺省 (chat) 走归组");
});

test("sessionKeyForTrigger: 会话键段内脏字符消毒 (':' 会破坏四段结构)", () => {
  const t = createTrigger({ source: "feishu", group: "oc:bad:id", text: "x" });
  const key = sessionKeyForTrigger(t);
  assert.equal(key.split(":").length, 4, "段数必须恒为 4");
  assert.ok(key.includes("oc-bad-id"), "非法字符被替换为 '-'");
});

test("sessionKeyForTrigger: 空消息体 (无 group 无 from) 兜底 default 会话", () => {
  const t = createTrigger({ source: "log", text: "x" });
  assert.equal(sessionKeyForTrigger(t), "ppx:log:default:dm");
});
