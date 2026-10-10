// scripts/verify-p01-cost.mjs — P0-1 成本护栏端到端实证 (零网络)
// 用假 llm client 走真实记账包装, 断言四条链路: 金额折算 / 按模型分账 / 预算闸门 / 周期落盘。
import { PPXAgent } from "../src/agent/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-p01-"));
const a = new PPXAgent({ root });
// 预算阈值设极低, 保证必然超限
a.config.budget = { usd: 0.000001, model_prices: { "glm-4.7": { prompt: 0.5, completion: 1.5 } } };

a.llm = { model: "glm-4.7", apiChat: async () => ({ usage: { prompt_tokens: 1000, completion_tokens: 500 } }) };
a._installUsageTracking();
await a.llm.apiChat([{ role: "user", content: "hi" }]);

console.log("usageStats =", JSON.stringify(a.usageStats));
console.log("byModel keys =", Object.keys(a.usageStats.byModel));
console.log("cost =", a.usageStats.cost, "| tokens =", a.usageStats.tokens);
console.log("_budgetExceeded =", a._budgetExceeded);

// 触发一次周期落盘 (阈值 10 次)
for (let i = 0; i < 10; i++) await a.llm.apiChat([{ role: "user", content: "x" }]);
const f = path.join(a.dataDir, "usage-stats.json");
console.log("usage-stats.json 落盘 =", fs.existsSync(f));

const ok =
  a.usageStats.cost > 0 &&
  Object.keys(a.usageStats.byModel).length === 1 &&
  a._budgetExceeded === true &&
  fs.existsSync(f);
console.log(ok ? "PASS: P0-1 四条链路全部恢复" : "FAIL: P0-1 仍有失效");
fs.rmSync(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
