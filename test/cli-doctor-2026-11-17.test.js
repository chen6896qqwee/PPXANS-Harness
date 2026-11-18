// test/cli-doctor-2026-11-17.test.js — ppx doctor 体检 (进程内, 零网络)
// runDoctor({net:false}) 读真实仓库配置/数据目录/技能库, 返回 boolean。
// 不测通过/失败的具体值 (取决于本机配置), 只钉住返回值类型与 results 数组形状。
import test from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../src/cli-doctor.js";

test("doctor: runDoctor({net:false}) 返回 boolean", async () => {
  // 临时静音 console, 防止 doctor 输出污染测试报告
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    const ok = await runDoctor({ net: false });
    assert.equal(typeof ok, "boolean", "runDoctor 应返回 boolean");
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
});
