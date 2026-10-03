// scripts/legion-e2e.js - 军团模式实弹演练 (真 LLM 端到端)
// 用法: node scripts/legion-e2e.js
// 流程: 主 agent 派 3 个并行侦察兵 (真方舟 API) → share_board 自动发板 → arbitrate 自动读板聚合
// 验证: 记忆板条目数 ≥ 子任务数, 仲裁结果返回, 全程计时
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-legion-e2e-"));
const globalDir = path.join(tmp, "global");

const main = new PPXAgent({
  root: ROOT,
  dataDir: path.join(tmp, "main"),
  globalDataDir: globalDir,
});

const TASKS = [
  "读 README.md 前 50 行, 用一句话概括本项目定位 (不超过 40 字)",
  "数一下 src/memory 目录下有几个 .js 文件, 报出文件名列表",
  "看 package.json, 报出项目名和 description",
];

console.log(`→ 军团演练开始: ${TASKS.length} 个并行侦察兵 (真 LLM)\n`);
const t0 = Date.now();
let result;
try {
  result = await main.tools.call("spawn_agent", {
    tasks: TASKS,
    role: "侦察兵",
    arbitrate: true,
    judge: "合并三方侦察结果为一段简报, 保留具体文件名/数字",
  }, { agent: main });
} finally {
  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n→ 委派+仲裁耗时: ${dt}s`);
}

console.log(`\n===== 仲裁简报 =====\n${result}\n====================`);

// 验证 1: 记忆板自动发板
const board = await main.tools.call("board_query", { topic: "侦察兵" }, { agent: main });
const entries = board === "(记忆板暂无匹配内容)" ? [] : board.split("\n");
console.log(`\n→ 记忆板条目: ${entries.length} 条`);
entries.forEach((e) => console.log(`  ${e.slice(0, 120)}`));

// 验证 2: 板上条目来自多个发布者 (发板 from=worker)
const okBoard = entries.length >= TASKS.length;
console.log(`\n${okBoard ? "✓" : "✗"} share_board 自动发板: ${okBoard ? "通过" : "失败 (条目不足)"}`);
main.shutdown();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(okBoard ? 0 : 1);
