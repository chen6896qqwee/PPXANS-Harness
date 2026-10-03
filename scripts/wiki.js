// scripts/wiki.js - 代码库 Wiki 生成 CLI (ZCode repo-wiki 机制对齐)
// 用法: node scripts/wiki.js [仓库根] [--out docs/WIKI.md]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateWiki } from "../src/wiki/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ROOT);
const oi = process.argv.indexOf("--out");
const out = oi >= 0 ? path.resolve(process.argv[oi + 1]) : path.join(target, "docs", "WIKI.md");

const w = generateWiki(target);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, w.text + "\n", "utf8");
console.log(`✓ Wiki 已生成: ${path.relative(ROOT, out) || out}`);
console.log(`  规模: 文件 ${w.stats.files} · 定义 ${w.stats.defs} · 依赖边 ${w.stats.edges} · 敏感排除 ${w.sensitiveSkipped}`);
