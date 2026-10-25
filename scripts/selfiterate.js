#!/usr/bin/env node
// scripts/selfiterate.js - 自主迭代进化引擎 CLI 入口 (2026-10-25)
//
// 用法:
//   node scripts/selfiterate.js test/foo.test.js [test/bar.test.js ...]   # propose 模式 (默认, 只出补丁)
//   node scripts/selfiterate.js --apply test/foo.test.js                   # apply 模式 (落盘+验证+回滚)
//   node scripts/selfiterate.js --list-failing                            # 先跑全量测试列出失败文件
//
// apply 模式安全边界 (与引擎一致): 只改 root 内 .js / 默认不碰测试文件 /
// 快照回滚 / LLM 预算上限 / 审计链留痕。无 LLM 配置时安全跳过。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { SelfIterationEngine, runTestFile } from "../src/evolve/selfiterate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const listFailing = argv.includes("--list-failing");
const files = argv.filter((a) => !a.startsWith("--"));

async function main() {
  if (listFailing) {
    // 全量测试 → 解析 TAP → 列出失败测试所在文件 (供挑选 target)
    const testDir = path.join(ROOT, "test");
    const all = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.js")).map((f) => path.join(testDir, f));
    const failing = [];
    for (const f of all) {
      const r = await runTestFile(f, { cwd: ROOT, timeoutMs: 120000 });
      if (r.tap && !r.tap.ok) failing.push({ file: path.relative(ROOT, f), fail: r.tap.fail, names: r.tap.failed.slice(0, 5) });
    }
    console.log(failing.length ? JSON.stringify(failing, null, 2) : "[]");
    console.log(failing.length ? `\n${failing.length} 个测试文件有失败` : "全部通过, 无需迭代");
    return;
  }

  if (!files.length) {
    console.error("用法: node scripts/selfiterate.js [--apply] <test 文件...> | --list-failing");
    process.exit(1);
  }

  const agent = new PPXAgent({ root: ROOT });
  const cfgFromConfig = agent.config?.agent?.self_iteration || {};
  // CLI --apply 与 config mode 双重门 (与 self_improve 工具同一语义)
  let mode = cfgFromConfig.mode === "apply" ? "apply" : "propose";
  if (apply) {
    if (cfgFromConfig.mode !== "apply") {
      console.error('[拒绝] --apply 需同时配置 config/ppx.json 的 agent.self_iteration.mode="apply" (双重确认, 防误用)');
      process.exit(1);
    }
    mode = "apply";
  }

  const engine = new SelfIterationEngine(agent, { ...cfgFromConfig, mode, root: ROOT });
  const summary = await engine.run({
    targetFiles: files.map((f) => path.resolve(ROOT, f)),
    onEvent: (t, p) => console.log(`  · ${t} ${p.file ? path.relative(ROOT, p.file) : ""}`),
  });
  console.log("\n==== 自主迭代结果 ====");
  console.log(JSON.stringify(summary, null, 2));
  agent.shutdown();
}

main().catch((e) => { console.error("[selfiterate] 失败:", e.message); process.exit(1); });
