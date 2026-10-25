// scripts/expert-drill.mjs - 专家分工实弹演练 (真 LLM)
// 用法: node scripts/expert-drill.mjs
// 流程: code/design/data 三专家各领一题并行 → 仲裁聚合 (验证 experts 参数 + share_board + 只读链路)
import { PPXAgent } from "../src/agent/index.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-expert-e2e-"));
const main = new PPXAgent({ root: ROOT, dataDir: path.join(tmp, "m"), globalDataDir: path.join(tmp, "g") });

const t0 = Date.now();
const r = await main.tools.call("spawn_agent", {
  tasks: [
    "看 src/orchestrator/legion.js 的 spawnAgent 方法, 指出一个健壮性风险 (一句话)",
    "评价本仓库 bin/ppx-setup.js 交互向导的中文用户体验, 给一条改进 (一句话)",
    "统计 test 目录 .test.js 文件数量并报数 (一句话)",
  ],
  experts: ["code", "design", "data"],
  arbitrate: true,
}, { agent: main });

console.log(`耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
console.log("=== 专家协作结果 ===");
console.log(String(r).slice(0, 900));
main.shutdown();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
