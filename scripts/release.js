// scripts/release.js - 一键打包: build 前端 (可选) + pack 内核, 产出完整发布物到 dist/
// 发布前先跑自愈基准 (7/7 门禁): 修复率不满分即终止, 防止带病发布
// 用法: node scripts/release.js
// 2026-10-01 重构: web/ (Next.js 深度定制 UI) 为可选子项目, 缺失时优雅跳过不再报错;
//                 另见 scripts/package.js (PC 端便携版/安装包打包)。
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const HAS_WEB = fs.existsSync(path.join(ROOT, "web", "package.json"));

function run(cmd, cwd = ROOT) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

console.log("=== 0/4 自愈基准 (发布门禁, 必须满分) ===");
run("node scripts/selfheal-bench.js");

console.log("=== 0.5/4 Skill 质量门禁 (蓝皮书: 元数据质量决定技能可发现性) ===");
run("node scripts/skill-lint.js");

if (HAS_WEB) {
  console.log("=== 1/4 构建前端 (Next.js 生产产物) ===");
  run("npm run build --prefix web");
} else {
  console.log("=== 1/4 构建前端: 跳过 (web/ 深度定制 UI 不存在, 现行 UI 为 public/ 零构建) ===");
}

console.log("\n=== 2/4 打包内核 npm 包 ===");
fs.mkdirSync(DIST, { recursive: true });
run(`npm pack --pack-destination ${JSON.stringify(DIST)}`);

if (HAS_WEB) {
  console.log("\n=== 3/4 复制前端 build 产物 ===");
  const webDist = path.join(DIST, "web");
  fs.rmSync(webDist, { recursive: true, force: true });
  for (const sub of [".next", "public", "next.config.ts"]) {
    const src = path.join(ROOT, "web", sub);
    const dst = path.join(webDist, sub);
    if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, "web", "package.json"), path.join(webDist, "package.json"));
} else {
  console.log("\n=== 3/4 复制前端 build 产物: 跳过 ===");
}

console.log("\n=== 4/4 完成 ===");
const tgz = fs.readdirSync(DIST).filter((f) => f.endsWith(".tgz"));
console.log(`产物目录: ${DIST}`);
console.log(`  内核: ${tgz.join(", ")}`);
if (HAS_WEB) console.log(`  Web UI: dist/web/ (需 cd web && npm install && npm run start)`);
console.log("\n发布内核: npm publish dist/ppx-agent-*.tgz");
console.log("PC 端安装包: node scripts/package.js (便携版 zip + Windows 安装器)");
console.log("部署 Web UI: 见 docs/QUICKSTART.md 或 Dockerfile");
