// scripts/audit-backfill-escalations.js - 历史提权事件 append-only 补录 (评测-II P1-1b)
//
// 背景 (2026-11-14 二次评测): 生产 2026-11-03 ~ 11-09 共 10 次 via:http 提权
//   (security/permission-escalated tracer 事件), 全部发生在 11-13 修复之前 —— 当时
//   recordEscalation 只有 tracer 通道, 哈希链里 security_permission_escalated 为 0 条。
//   提权是安全决策点, 唯一账本却是会轮转的 tracer 事件流, 不满足"与工具调用同链可追责"。
//
// 本脚本把 tracer 事件里仍可复原的提权记录 **append-only** 补录进哈希链 (不改写任何历史行):
//   每条 fields 带 occurredAt (原始发生时间) / backfill:true / source:"eval-backfill-2026-11-14"。
// 幂等: 先扫链上已有 backfill 标记的 occurredAt, 已补录过的跳过 —— 重复执行零副作用。
//
// 用法: node scripts/audit-backfill-escalations.js            实际补录
//       node scripts/audit-backfill-escalations.js --dry-run  只打印将要补录的条目
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { AuditLog, loadOrCreateHmacKey } from "../src/audit/audit-chain.js";

const dryRun = process.argv.includes("--dry-run");
const dataDir = process.env.PPX_DATA_DIR || path.join(process.cwd(), "data");
const tracesDir = path.join(dataDir, "logs", "traces");

// 1) 从 tracer 事件流复原提权事件 (事件文件按天分片, 只认标准字段)
const events = [];
try {
  const files = fs.readdirSync(tracesDir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(tracesDir, f), "utf8").split("\n").filter(Boolean)) {
      let o = null;
      try { o = JSON.parse(line); } catch { continue; }
      if (o?.type === "security/permission-escalated" && Array.isArray(o.changes)) {
        events.push({ ts: String(o.ts || ""), via: String(o.via || "http"), changes: o.changes.map(String) });
      }
    }
  }
} catch (e) {
  console.error(`读取 tracer 事件失败: ${e?.message || e}`);
  process.exit(1);
}

// 2) 幂等: 链上已有的 backfill occurredAt 集合
const audit = new AuditLog(dataDir, { hmacKey: loadOrCreateHmacKey(process.cwd()) });
const doneAt = new Set();
for (const row of audit.tail(10000)) {
  if (row?.tool === "security_permission_escalated" && row?.args?.backfill && row.args.occurredAt) {
    doneAt.add(String(row.args.occurredAt));
  }
}
const chainCount = audit.tail(10000).filter((r) => r?.tool === "security_permission_escalated").length;

const pending = events.filter((e) => !doneAt.has(e.ts));
console.log(`tracer 提权事件: ${events.length} 条 | 链上已有 security_permission_escalated: ${chainCount} 条 | 待补录: ${pending.length} 条`);
if (!pending.length) {
  console.log("无需补录 (全部已在链上或无可复原事件)。");
  process.exit(0);
}

if (dryRun) {
  for (const e of pending) console.log(`  [dry-run] ${e.ts} via=${e.via} ${e.changes.join("; ")}`);
  process.exit(0);
}

// 3) append-only 补录: occurredAt 保留原始发生时间, ts 为补录时刻 —— 不伪造历史时间线
for (const e of pending) {
  audit.appendEvent({
    event: "security_permission_escalated",
    fields: { changes: e.changes, via: e.via, severity: "high", occurredAt: e.ts, backfill: true, source: "eval-backfill-2026-11-14" },
    ok: true,
  });
  console.log(`  已补录 seq(链上追加): ${e.ts} via=${e.via}`);
}

const v = audit.verify();
console.log(`补录完成 | 链完整性: ${v.ok ? "完整" : "已损坏"} | 条数: ${v.total}`);
process.exit(v.ok ? 0 : 1);
