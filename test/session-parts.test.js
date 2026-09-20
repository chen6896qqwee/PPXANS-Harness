// test/session-parts.test.js - 结构化消息部件测试
import { test } from "node:test";
import assert from "node:assert";
import { part, parts } from "../src/session/parts.js";

test("部件工厂生成带 id/type/ts", () => {
  const t = part.text("hello");
  assert.equal(t.type, "text");
  assert.equal(t.text, "hello");
  assert.ok(t.id && t.ts);

  const f = part.file({ path: "/a.txt", content: "x" });
  assert.equal(f.type, "file");
  assert.equal(f.path, "/a.txt");
  assert.equal(f.content, "x");

  const img = part.image({ url: "http://x/y.png" });
  assert.equal(img.type, "image");
  assert.equal(img.url, "http://x/y.png");

  const a = part.agent({ name: "sub", color: "#f00" });
  assert.equal(a.type, "agent");
  assert.equal(a.name, "sub");
  assert.equal(a.color, "#f00");

  const r = part.reasoning("think");
  assert.equal(r.type, "reasoning");
  assert.equal(r.text, "think");

  const tl = part.tool({ call: { name: "ls" }, output: "out" });
  assert.equal(tl.type, "tool");
  assert.equal(tl.call.name, "ls");
  assert.equal(tl.output, "out");
});

test("fromResponseItems 映射为部件", () => {
  const items = [
    { type: "message", role: "user", content: "hi" },
    { type: "reasoning", text: "thinking" },
    { type: "message", role: "assistant", content: "ok" },
    { type: "function_call", name: "ls", arguments: "{}" },
    { type: "function_call_output", output: "files" },
  ];
  const ps = parts.fromResponseItems(items);
  assert.equal(ps.length, 5);
  assert.equal(ps[0].type, "text");
  assert.equal(ps[1].type, "reasoning");
  assert.equal(ps[2].type, "text");
  assert.equal(ps[3].type, "tool");
  assert.equal(ps[3].call.name, "ls");
  assert.equal(ps[4].type, "tool");
  assert.equal(ps[4].output, "files");
});

test("fromResponseItems: 空/未知类型不崩", () => {
  assert.deepEqual(parts.fromResponseItems(), []);
  const ps = parts.fromResponseItems([null, { type: "weird" }, { type: "message", content: "x" }]);
  assert.equal(ps.length, 2); // null 跳过, weird 兜底文本, message 正常
});

test("estimateTokens: 中文 token 多于等长英文", () => {
  assert.equal(parts.estimateTokens(""), 0);
  const en = parts.estimateTokens("hello world foo bar");
  const cn = parts.estimateTokens("你好世界这是中文测试token估算");
  assert.ok(en > 0 && cn > 0);
  assert.ok(cn > en, "中文每字约 1 token, 等长下 token 数应多于英文");
});

test("parts 命名空间包含工厂与工具方法", () => {
  assert.equal(typeof parts.text, "function");
  assert.equal(typeof parts.fromResponseItems, "function");
  assert.equal(typeof parts.estimateTokens, "function");
});
