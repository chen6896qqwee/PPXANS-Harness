#!/usr/bin/env node
// scripts/selfcode.js — 自改代码的命令行入口 (2026-10-27)
//
// 为什么需要它: 工具面 (self_edit 等) 只有 agent 能调, 而"改自己"这件事人也要能验。
// 这个 CLI 走同一套引擎, 因此结论与 agent 调用完全同源 —— 人跑通了, 模型跑的就是同一条路。
//
// 用法:
//   node scripts/selfcode.js status                 看账本 + 待生效清单
//   node scripts/selfcode.js plan  patch.txt        只出 diff, 不动盘
//   node scripts/selfcode.js apply patch.txt --tests test/a.test.js,test/b.test.js --reason "..." 
//   node scripts/selfcode.js rewind [sc-xxxx]       回滚 (默认最近一次 kept)
//   node scripts/selfcode.js ack                    确认待生效自改已生效 (清清单)
//
// patch 文件内容就是 SEARCH/REPLACE 块 (首行文件名), 与 apply_patch 同一格式。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SelfCodeEngine } from "../src/selfcode/engine.js";
import { SelfCodeLedger } from "../src/selfcode/ledger.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");

function arg(name, def = null) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function readPatch(p) {
  if (!p || p === true) throw new Error("需要补丁文件路径 (含 SEARCH/REPLACE 块的文本文件)");
  const abs = path.resolve(ROOT, String(p));
  if (!fs.existsSync(abs)) throw new Error(`补丁文件不存在: ${abs}`);
  return fs.readFileSync(abs, "utf8");
}

function testsFrom(v) {
  if (!v || v === true) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

function print(o) {
  process.stdout.write(JSON.stringify(o, null, 2) + "\n");
}

const cmd = process.argv[2] || "status";
const mode = arg("apply") === true ? "apply" : null; // --apply 简写
const eng = new SelfCodeEngine({ root: ROOT, dataDir: DATA, mode: "propose" });

try {
  if (cmd === "status") {
    print(eng.status({ limit: Number(arg("limit", 10)) || 10 }));
  } else if (cmd === "plan") {
    const r = await eng.run({ patch: readPatch(process.argv[3]), tests: testsFrom(arg("tests")), mode: "propose" });
    print(r);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "apply") {
    const r = await eng.run({
      patch: readPatch(process.argv[3]),
      tests: testsFrom(arg("tests")),
      mode: "apply",
      reason: String(arg("reason", "CLI 自改") || "CLI 自改"),
    });
    print(r);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "rewind") {
    const r = eng.rewind({ id: process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null });
    print(r);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "ack") {
    const ledger = new SelfCodeLedger({ dataDir: DATA });
    const before = ledger.readPending();
    ledger.clearPending();
    print({ ok: true, acked: before.files || [] });
  } else {
    console.error(`未知子命令: ${cmd}\n可用: status | plan <patch> | apply <patch> [--tests a,b] [--reason ..] | rewind [id] | ack`);
    process.exit(2);
  }
} catch (e) {
  console.error("[selfcode] " + (e?.message || e));
  process.exit(2);
}
