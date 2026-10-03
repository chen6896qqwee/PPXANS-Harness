#!/usr/bin/env node
// skills/ppx-selfheal/scripts/cli.js - 皮皮虾自愈引擎「独立运行版」CLI
// 不依赖主项目 src/, 对数据目录做体检与修复 (与主项目共享 integrity.json 语义)
//
// 用法:
//   node cli.js check    启动体检 (补建缺失目录 + 修复损坏 JSON)
//   node cli.js crash    检查上次是否崩溃退出 (integrity.clean === false)
//   node cli.js status   查看完整性状态
//   node cli.js prune    清理过期备份 (损坏备份/备份目录/.bak, 各保留 2 份)
//   node cli.js heal     完整自愈 (体检 + 崩溃恢复 + 残留清理)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Healer } from "./healer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 技能位于 <root>/skills/ppx-selfheal/scripts/ → ROOT 为三级之上
const ROOT = process.env.PPX_ROOT || path.resolve(HERE, "..", "..", "..");
const DATA = process.env.PPX_DATA_DIR || path.join(ROOT, "data");

const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));
const healer = new Healer(ROOT, DATA);

const cmd = process.argv[2] || "check";

switch (cmd) {
  case "check": {
    const fixes = healer.runStartupChecks();
    if (!fixes.length) out("体检通过: 无需修复 ✓");
    else {
      out(`完成 ${fixes.length} 项修复:`);
      for (const f of fixes) out("  - " + (typeof f === "string" ? f : JSON.stringify(f)));
    }
    break;
  }

  case "crash": {
    const crashed = healer.checkCrash();
    out(crashed ? "⚠ 上次为崩溃退出 (integrity.clean === false), 建议跑 heal" : "上次为正常退出 ✓");
    process.exit(crashed ? 1 : 0);
  }

  case "status": {
    const f = path.join(DATA, "integrity.json");
    if (!fs.existsSync(f)) {
      out("(尚无 integrity.json, 未做过体检)");
      break;
    }
    out(JSON.parse(fs.readFileSync(f, "utf8")));
    break;
  }

  case "prune": {
    healer.cleanupCorruptBackups(2);
    healer.cleanupStaleBackupDirs(2);
    healer.cleanupStaleBakFiles(2);
    out("已清理过期备份 (各保留最近 2 份) ✓");
    break;
  }

  case "heal": {
    const fixes = healer.runStartupChecks();
    const crashed = healer.checkCrash();
    if (crashed) healer._cleanupTmp?.();
    healer.cleanupCorruptBackups(2);
    healer.cleanupStaleBackupDirs(2);
    healer.cleanupStaleBakFiles(2);
    out(`自愈完成: ${fixes.length} 项修复${crashed ? " + 崩溃残留清理" : ""} ✓`);
    for (const f of fixes) out("  - " + (typeof f === "string" ? f : JSON.stringify(f)));
    break;
  }

  default:
    out(`皮皮虾自愈引擎 · 独立 CLI
项目根: ${ROOT}
数据目录: ${DATA}

用法: check | crash | status | prune | heal`);
    process.exit(1);
}
