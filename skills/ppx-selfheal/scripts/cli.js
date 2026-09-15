// ppx-selfheal CLI - 皮皮虾自愈引擎 (OpenClaw skill)
// 用法: node cli.js [--root <dir>] [--check]
// 默认自愈 ppx-memory 数据目录 (~/.openclaw/memory/ppx)
import path from "node:path";
import os from "node:os";
import { Healer } from "./healer.js";

const DATA = process.env.PPX_MEMORY_DIR || path.join(os.homedir(), ".openclaw", "memory", "ppx");
const [, , ...argv] = process.argv;
const rootIdx = argv.indexOf("--root");
const root = rootIdx >= 0 ? argv[rootIdx + 1] : DATA;

const healer = new Healer(root);
if (argv.includes("--check")) {
  // 只检查不修复
  const fixes = healer.runStartupChecks();
  const crash = healer.checkCrash();
  console.log(JSON.stringify({ fixes: fixes.length ? fixes : ["(none)"], crashed: crash.crashed, detail: crash.detail }, null, 2));
} else {
  const report = healer.heal();
  console.log(JSON.stringify(report, null, 2));
}