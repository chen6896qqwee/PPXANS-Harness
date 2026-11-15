#!/usr/bin/env node
// scripts/silent-catch-guard.mjs — 空 catch 静态守卫 (2026-10-10 新增, 对应评价报告 P0-3; 2026-11-03 收口)
//
// 动机: 本项目 2026-10-10 出现一次「加功能但没接线」事故 —— estimateCost 未 import,
//   ReferenceError 被同行 `catch {}` 吃掉, 成本护栏 100% 静默失效且无人发现。
//   空 catch 本身不是错, 但**吞掉关键路径异常且不留痕**是必须门禁的。
//
// 用法:
//   node scripts/silent-catch-guard.mjs            # report 模式: 列出全部空 catch (不失败)
//   node scripts/silent-catch-guard.mjs --strict   # strict 模式: 关键路径空 catch / 无效 scope 即失败
//   node scripts/silent-catch-guard.mjs --json     # 机器可读输出
//
// 判定口径与 self_audit 共用 src/selfcode/catch-scan.js (唯一实现), 避免两个工具互相打架。
// 三类口径 (2026-11-03 补第三类, 同日收紧):
//   empty    = 空块 catch —— --strict 必拦
//   logged   = 有 noteCatch/日志/throw
//   swallowed= 非空但无留痕 (`catch { return []; }`) —— 全仓量化上报;
//              --strict 只拦**关键路径**吞错 (非关键路径仍由 self_audit 分级扣分)
// 豁免标记 `swallowed-ok(YYYY-MM-DD): 理由` 带日期且未过期 (180 天) 才算判读;
//   无日期/超期 = 自动降级为 swallowed —— 白名单不能自证, 必须定期复核。
// 关键路径 = src/{audit,memory,llm,config,session,evidence}/、
//   catch 所在函数名含 account/flush/persist/write/save/load/record/audit/append/store/sync,
//   或 try 体里调用落盘/记账/投递/学习操作 (learn/record/enqueue/deliver/writeFile/...)。
//   最后一条让 src/agent/ 这类不在目录白名单的持久化路径也能被拦住;
//   刻意不含 send/emit/push —— SSE 断开、事件派发失败属正常降级。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeCatchScan } from "../src/selfcode/catch-scan.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "bin", "electron", "scripts"];

const args = process.argv.slice(2);
const STRICT = args.includes("--strict");
const JSON_OUT = args.includes("--json");

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(?:js|mjs|cjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const findings = [];
const badScopes = [];
let logged = 0;
let swallowed = 0;
let criticalSwallowed = 0;
let acknowledged = 0;
let criticalAcknowledged = 0;
let expiredAcks = 0;
let undatedAcks = 0;
const swallowedSites = [];
const criticalAckSites = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  let text = "";
  try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
  const scan = summarizeCatchScan(text, rel);
  logged += scan.logged;
  swallowed += scan.swallowed;
  criticalSwallowed += scan.criticalSwallowed;
  acknowledged += scan.acknowledged;
  criticalAcknowledged += scan.criticalAcknowledged;
  expiredAcks += scan.expiredAcks;
  undatedAcks += scan.undatedAcks;
  for (const x of scan.sites) {
    if (!x.empty) {
      if (x.swallowed && x.critical) {
        swallowedSites.push({ file: rel, line: x.line, fn: x.fn, reason: x.criticalReason });
      } else if (x.acknowledged && x.critical) {
        criticalAckSites.push({ file: rel, line: x.line, fn: x.fn, reason: x.ackReason });
      }
      continue;
    }
    findings.push({
      file: rel,
      line: x.line,
      fn: x.fn,
      critical: x.critical,
      reason: x.criticalReason,
      snippet: text.split(/\r?\n/)[x.line - 1]?.trim().slice(0, 100),
    });
  }
  for (const b of scan.badScopes) badScopes.push({ file: rel, ...b });
}

const criticalFindings = findings.filter((x) => x.critical);

if (JSON_OUT) {
  console.log(JSON.stringify({
    total: findings.length,
    critical: criticalFindings.length,
    logged,
    swallowed,
    criticalSwallowed,
    acknowledged,
    criticalAcknowledged,
    expiredAcks,
    undatedAcks,
    swallowedSites,
    criticalAckSites,
    badScopes,
    findings,
  }, null, 2));
  process.exit(STRICT && (criticalFindings.length || criticalSwallowed || badScopes.length) ? 1 : 0);
}

console.log(`[silent-catch-guard] ${DIRS.join("/")} 内空 catch 共 ${findings.length} 处, 其中关键路径 ${criticalFindings.length} 处`);
console.log(`  已留痕 catch ${logged} 处 (noteCatch/debug/warn/error/rethrow)`);
console.log(`  非空但无留痕 (吞错) ${swallowed} 处, 其中关键路径 ${criticalSwallowed} 处 —— strict 拦关键路径, 非关键路径由 self_audit 分级`);
console.log(`  已判读并标 swallowed-ok ${acknowledged} 处 (日期有效, 180 天内; 其中关键路径 ${criticalAcknowledged} 处 —— 逐处列出可查, 过期后重新进入盲区)`);
if (expiredAcks || undatedAcks) {
  console.log(`  豁免失效 ${expiredAcks + undatedAcks} 处 (超期 ${expiredAcks} / 无日期 ${undatedAcks}) —— 已按吞错计数, 复核后重新标日期`);
}
if (criticalFindings.length) {
  console.log("\n关键路径 (strict 下必须留痕):");
  for (const x of criticalFindings) console.log(`  ${x.file}:${x.line}  fn=${x.fn || "?"}  [${x.reason}]  ${x.snippet}`);
}
if (swallowedSites.length) {
  console.log(`\n关键路径吞错 (块非空, 无 noteCatch/日志/throw; 需人工判读):`);
  for (const x of swallowedSites.slice(0, 20)) console.log(`  ${x.file}:${x.line}  fn=${x.fn || "?"}  [${x.reason}]`);
  if (swallowedSites.length > 20) console.log(`  …另有 ${swallowedSites.length - 20} 处`);
}
if (criticalAckSites.length) {
  console.log(`\n关键路径已判读豁免 (理由由人写, 扫描器无法复核; 过期即回盲区, 复核时逐条对账):`);
  for (const x of criticalAckSites.slice(0, 20)) console.log(`  ${x.file}:${x.line}  fn=${x.fn || "?"}  — ${x.reason.slice(0, 80)}`);
  if (criticalAckSites.length > 20) console.log(`  …另有 ${criticalAckSites.length - 20} 处`);
}
if (badScopes.length) {
  console.log("\n无效 noteCatch scope (取到了 if/for/warn 等代码行, 复盘无法定位):");
  for (const b of badScopes) console.log(`  ${b.file}:${b.line}  scope="${b.scope}"  → 改为 noteCatch(e) 让栈自动定位`);
}
if (!STRICT) {
  console.log(`\n提示: 其余 ${findings.length - criticalFindings.length} 处散落在非关键路径 (UI 回调/事件派发等), 允许静默。`);
  console.log("运行 `--strict` 可将其余关键路径空 catch 作为 CI 门禁。");
}

if (STRICT && (criticalFindings.length || criticalSwallowed || badScopes.length)) {
  console.error(`\n[silent-catch-guard] FAIL: 关键路径静默 catch ${criticalFindings.length} 处, 关键路径吞错 ${criticalSwallowed} 处, 无效 scope ${badScopes.length} 处。`);
  process.exit(1);
}
console.log("\n[silent-catch-guard] PASS");
