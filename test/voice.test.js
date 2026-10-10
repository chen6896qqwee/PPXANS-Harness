// test/voice.test.js - TTS 语音工具单测 (2026-10-06 补齐: 此前实现无测试覆盖)
// 覆盖: 平台命令构建 (win32/darwin/linux) + PowerShell 注入转义 + 参数钳制
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTTSCommand, escapePS } from "../src/tools/voice.js";

test("win32: 走 PowerShell + System.Speech, rate/voice 正确拼装", () => {
  const { cmd, args } = buildTTSCommand("你好", { rate: 2, voice: "Huihui" }, "win32");
  assert.equal(cmd, "powershell");
  const script = args[args.length - 1];
  assert.match(script, /System\.Speech/);
  assert.match(script, /SelectVoice\('Huihui'\)/);
  assert.match(script, /Rate = 2/);
  assert.match(script, /Speak\('你好'\)/);
});

test("win32: rate 越界钳制到 [-10,10], 非数字回 0", () => {
  const hi = buildTTSCommand("x", { rate: 99 }, "win32");
  assert.match(hi.args[hi.args.length - 1], /Rate = 10/);
  const lo = buildTTSCommand("x", { rate: -99 }, "win32");
  assert.match(lo.args[lo.args.length - 1], /Rate = -10/);
  const nan = buildTTSCommand("x", { rate: "abc" }, "win32");
  assert.match(nan.args[nan.args.length - 1], /Rate = 0/);
});

test("darwin: 走 say, rate 映射 -WPM 语义", () => {
  const { cmd, args } = buildTTSCommand("hi", { rate: 3 }, "darwin");
  assert.equal(cmd, "say");
  assert.deepEqual(args.filter((a) => a === "hi"), ["hi"]);
});

test("linux: 走 espeak", () => {
  const { cmd } = buildTTSCommand("hi", {}, "linux");
  assert.equal(cmd, "espeak");
});

test("escapePS: 单引号成对转义, 防止 PowerShell 注入", () => {
  assert.equal(escapePS("it's"), "it''s");
  assert.equal(escapePS("a''b"), "a''''b");
  // 注入样本: 契约 = 每个 ' 都翻倍 → 单引号字符串无法提前闭合, 注入变成无害文本
  const evilInput = "'); Stop-Process -Name explorer; ('";
  const evil = escapePS(evilInput);
  assert.equal(evil, evilInput.replace(/'/g, "''"));
  // 转义后不存在"裸引号闭合 + 立即执行"形态: 单引号数量必为偶数 (在闭合串内成对)
  assert.equal((evil.match(/'/g) || []).length % 2, 0, evil);
});

test("voice: 未指定 voice 时不注入 SelectVoice", () => {
  const { args } = buildTTSCommand("x", {}, "win32");
  assert.ok(!args[args.length - 1].includes("SelectVoice"));
});
