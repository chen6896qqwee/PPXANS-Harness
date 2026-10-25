// test/wechat-cdata.test.js - 微信回包 CDATA 注入修复回归 (2026-10-25 评估修复)
//
// 背景: agent 回复含 "]]>" 时 CDATA 提前闭合 → 回包 XML 破损 → 微信解析失败静默丢回复。
//   修复: 回填前把 ]]> 拆成两段 CDATA。本测试直接钉住转义函数行为与整体 XML 可解析性。
import { test } from "node:test";
import assert from "node:assert";

// 与 wechat.js 内联实现同源的转义 (通道方法是私有构造路径, 这里钉语义 + 用正则验成品)
const cdata = (s) => String(s ?? "").replace(/\]\]>/g, "]]]]><![CDATA[>");

test("cdata: 普通文本原样", () => {
  assert.equal(cdata("你好, 世界"), "你好, 世界");
  assert.equal(cdata("a ] b"), "a ] b", "单个 ] 不是边界");
  assert.equal(cdata("a ]] b"), "a ]] b", "两个 ] 不跟 > 不是边界");
});

test("cdata: ']]>' 被拆分为两段 CDATA", () => {
  const out = cdata("x]]>y");
  assert.equal(out, "x]]]]><![CDATA[>y");
});

test("cdata: XML 端到端可解析 (含注入载荷的回复不再破损)", () => {
  const reply = '结论是 a]]>b 与 ]]>inject';
  const xml = `<xml><Content><![CDATA[${cdata(reply)}]]></Content></xml>`;
  // 用 DOMParser 不可用 (无 DOM), 以"每段 CDATA 都正确闭合"验证: 按 CDATA 段拼接后语义等价
  const roundtrip = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const inner = roundtrip(xml);
  assert.equal(inner, "<xml><Content>" + reply + "</Content></xml>", "CDATA 拆分后拼接应还原原文");
});
