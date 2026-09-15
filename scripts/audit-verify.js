// scripts/audit-verify.js - 审计哈希链校验 CLI (吸收自 ppx-v2 的 audit 能力)
// 用法: npm run audit:verify            校验并打印结果
//       npm run audit:verify -- --fix   校验失败时隔离损坏段并重建
//       npm run audit:verify -- --tail 20  附带最近 20 条记录
import path from "node:path";
import process from "node:process";
import { AuditLog, quarantineBroken } from "../src/audit/audit-chain.js";

const args = process.argv.slice(2);
const wantFix = args.includes("--fix");
const tailIdx = args.indexOf("--tail");
const tailN = tailIdx >= 0 ? Number(args[tailIdx + 1]) || 10 : 0;

const dataDir = process.env.PPX_DATA_DIR || path.join(process.cwd(), "data");
const log = new AuditLog(dataDir);

console.log(`审计日志: ${log.file}`);
let v = log.verify();
console.log(`链完整性: ${v.ok ? "完整" : "已损坏"} | 条数: ${v.total} | 断裂点: ${v.brokenAt ?? "无"}`);
console.log(`详情: ${v.detail}`);

if (!v.ok && wantFix) {
  const q = quarantineBroken(dataDir);
  console.log(`已隔离: ${q.quarantined ? "是" : "否"}${q.backup ? ` | 备份: ${q.backup}` : ""}`);
  v = log.verify();
  console.log(`重建后: ${v.ok ? "完整" : "仍损坏"} | ${v.detail}`);
}

if (tailN > 0) {
  console.log(`\n最近 ${tailN} 条:`);
  for (const e of log.tail(tailN)) {
    console.log(`  #${e.seq} ${e.ts} ${e.ok ? "OK " : "ERR"} ${e.tool} (${e.ms}ms)`);
  }
}

process.exit(v.ok ? 0 : 1);
