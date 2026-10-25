// scripts/list-tools.mjs - 列出全部注册工具名 (验证 guard 覆盖率)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = new Set();
const dirs = ["src/tools", "src/plugin", "src/mcp"];
for (const d of dirs) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const re = /name:\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(src))) names.add(m[1]);
  }
}
const sorted = [...names].sort();
console.log(`工具/实体名总数: ${sorted.length}`);
console.log(sorted.join("\n"));
console.log("\n=== 匹配 DANGEROUS_RE (delete|remove|clear|wipe|drop|purge|truncate|overwrite 前缀) ===");
const dangerous = sorted.filter((n) => /^(delete|remove|clear|wipe|drop|purge|truncate|overwrite)/i.test(n));
console.log(dangerous.length ? dangerous.join("\n") : "(空 —— 无一匹配!)");
