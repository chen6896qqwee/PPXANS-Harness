// src/selfcode/test-runner.js — 测试子进程执行原语 (2026-11-02 从 selfiterate 抽出)
//
// 为什么搬家: 自改验证 (selfcode/verify) 与自主迭代 (selfcode/selfiterate) 都要跑单个测试文件
//   并解析 TAP。原实现放在 evolve 里, selfcode 反向 import evolve —— 加上进化循环要读
//   selfcode/audit 后形成 evolve → selfcode → evolve 模块环。运行器属于"验证原语",
//   归到 selfcode 一侧后, 依赖方向固定为 evolve → selfcode, 环消失。
//
// 语义与搬家前逐字一致; selfiterate.js 仍重导出 parseTap / runTestFile, 旧引用不破。

import { spawn } from "node:child_process";

// ---- TAP 输出解析: node --test --test-reporter=tap ----
// 返回 { ok, total, failed: [测试名], raw }
export function parseTap(tapText) {
  const text = String(tapText || "");
  const failed = [];
  for (const m of text.matchAll(/^not ok\s+\d+\s+-\s+(.+)$/gm)) {
    failed.push(m[1].trim());
  }
  const totalM = /^# (?:tests|test)\s+(\d+)/m.exec(text);
  const passM = /^# pass\s+(\d+)/m.exec(text);
  const failM = /^# fail\s+(\d+)/m.exec(text);
  const failCount = failM ? Number(failM[1]) : failed.length;
  const passCount = passM ? Number(passM[1]) : 0;
  return {
    ok: failCount === 0,
    total: totalM ? Number(totalM[1]) : passCount + failCount,
    pass: passCount,
    fail: failCount,
    failed,
  };
}

// ---- 子进程跑测试 (单文件, 带超时强杀) ----
// 环境清洗: 本函数常在 node --test 内被调用, 外层 runner 会注入 NODE_TEST_CONTEXT/NODE_OPTIONS,
//   嵌套 node --test 被污染后输出错乱 (实测表现为失败测试被判 already-green)。
//   这里显式剥离, 保证嵌套运行语义独立。
export function runTestFile(testFile, { cwd = process.cwd(), timeoutMs = 60000, extraArgs = [] } = {}) {
  return new Promise((resolve) => {
    const args = ["--test", "--test-reporter=tap", ...extraArgs, testFile];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      out += "\n# timeout-killed";
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e), tap: null }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, tap: parseTap(out) });
    });
  });
}
