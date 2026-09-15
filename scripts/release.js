// scripts/release.js - 一键打包: build 前端 + pack 内核, 产出完整发布物到 dist/
// 发布前先跑自愈基准 (7/7 门禁): 修复率不满分即终止, 防止带病发布
// 用法: node scripts/release.js
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

function run(cmd, cwd = ROOT) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

console.log("=== 0/5 自愈基准 (发布门禁, 必须满分) ===");
run("node scripts/selfheal-bench.js");

console.log("=== 1/5 构建前端 (Next.js 生产产物) ===");
run("npm run build --prefix web");

console.log("\n=== 2/5 打包内核 npm 包 ===");
fs.mkdirSync(DIST, { recursive: true });
run(`npm pack --pack-destination ${JSON.stringify(DIST)}`);

console.log("\n=== 3/5 复制前端 build 产物 ===");
const webDist = path.join(DIST, "web");
fs.rmSync(webDist, { recursive: true, force: true });
for (const sub of [".next", "public", "next.config.ts"]) {
  const src = path.join(ROOT, "web", sub);
  const dst = path.join(webDist, sub);
  if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
}
fs.copyFileSync(path.join(ROOT, "web", "package.json"), path.join(webDist, "package.json"));

console.log("\n=== 4/5 完成 ===");
const tgz = fs.readdirSync(DIST).filter((f) => f.endsWith(".tgz"));
console.log(`产物目录: ${DIST}`);
console.log(`  内核: ${tgz.join(", ")}`);
console.log(`  Web UI: dist/web/ (需 cd web && npm install && npm run start)`);
console.log("\n发布内核: npm publish dist/ppx-agent-*.tgz");
console.log("部署 Web UI: 见 docs/QUICKSTART.md 或 Dockerfile");