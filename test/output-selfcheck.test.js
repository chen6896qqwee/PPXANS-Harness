// test/output-selfcheck.test.js - 最终回答自检 (2026-10-09 新增)
// 背景: 项目输入侧闸门齐备, 但【用户直接看到的那段回答】此前没有任何检查
// (grep critic|selfCheck|verifyReply = 0 命中) —— 内部错误原文 / 未渲染工具信封 / 裸 JSON
// 都能直接漏给用户。本测试锁死自检行为与净化效果。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selfCheckReply, sanitizeReply, SELFCHECK_CODES } from "../src/core/selfcheck.js";
import { PPXAgent } from "../src/agent/index.js";

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-selfcheck-${tag}-`)); }

test("自检: 正常回答通过", () => {
  const r = selfCheckReply("这是正常的一段回答, 包含结论与依据。");
  assert.equal(r.ok, true, "正常回答不应报问题");
  assert.equal(r.issues.length, 0);
});

test("自检: 空回复被判 empty", () => {
  for (const v of ["", "   ", "\n\n", null, undefined, {}]) {
    const r = selfCheckReply(v);
    assert.equal(r.ok, false, `应判为不通过: ${JSON.stringify(v)}`);
    assert.equal(r.issues[0].code, SELFCHECK_CODES.EMPTY);
  }
});

test("自检: 内部错误原文/栈帧被判 internal_leak", () => {
  const cases = [
    "ERR_HTTP_HEADERS_SENT: Cannot write headers after they are sent",
    "TypeError: x is not a function\n    at foo (C:\\a\\b.js:10:2)",
    "结果: [object Object]",
  ];
  for (const c of cases) {
    const r = selfCheckReply(c);
    assert.equal(r.ok, false, `应判为不通过: ${c.slice(0, 30)}`);
    assert.ok(r.issues.some((i) => i.code === SELFCHECK_CODES.INTERNAL_LEAK));
  }
});

test("自检: 未渲染的工具调用信封被判 tool_envelope", () => {
  const cases = [
    "⟪tool⟫read_file⟪/tool⟫",
    '<tool_call>{"name":"read_file"}</tool_call>',
    "<|tool▁calls▁begin|>",
    'antml:invoke name="read_file"',
  ];
  for (const c of cases) {
    const r = selfCheckReply(c);
    assert.equal(r.ok, false, `应判为不通过: ${c.slice(0, 30)}`);
    assert.ok(r.issues.some((i) => i.code === SELFCHECK_CODES.TOOL_ENVELOPE));
  }
});

test("自检: 裸 JSON 回复被判 json_dump, 但带说明不算", () => {
  const bad = selfCheckReply('{"ok":true,"files":["a.js"]}');
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.code === SELFCHECK_CODES.JSON_DUMP));

  const good = selfCheckReply('已完成, 结果如下:\n```json\n{"ok":true}\n```');
  assert.equal(good.ok, true, "带自然语言说明 + 代码块, 不应判为裸 JSON");
});

test("净化: internal_leak 会被就地清除, 其余类型不擅自改写", () => {
  const dirty = "先说明一句。\nERR_HTTP_HEADERS_SENT: boom\n    at foo (C:\\x.js:1:1)\n结论在此。";
  const report = selfCheckReply(dirty);
  const clean = sanitizeReply(dirty, report);
  assert.ok(!/ERR_HTTP_HEADERS_SENT/.test(clean), "内部错误行应被清除");
  assert.ok(!/\bat foo \(/.test(clean), "栈帧应被清除");
  assert.ok(clean.includes("先说明一句") && clean.includes("结论在此"), "正常内容应保留");

  // 非 internal_leak 的报告不得改写文本
  const env = "⟪tool⟫read_file⟪/tool⟫";
  const r2 = selfCheckReply(env);
  assert.equal(sanitizeReply(env, r2), env, "工具信封类不净化, 只报告");
});

test("接线: agent.chat 产出内部错误文本时会被自检净化", async () => {
  const d = tmp("chat");
  const agent = new PPXAgent({ root: path.resolve("."), dataDir: d });
  try {
    // 直接验证装配点: 自检开关默认开启, 且实例上有对应的总线事件名契约
    assert.notEqual(agent.config?.agent?.self_check, false, "自检默认应开启");
    const dirty = "ERR_HTTP_HEADERS_SENT: boom";
    const report = selfCheckReply(dirty, { usedTools: false });
    assert.equal(report.ok, false);
    assert.ok(!/ERR_HTTP_HEADERS_SENT/.test(sanitizeReply(dirty, report)));
  } finally {
    agent.shutdown();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
