#!/usr/bin/env node
// scripts/version-sync.js - 版本号一致性闸门 (2026-11-02)
//
// 动机: 2026-11-02 评估发现 package.json 还是 4.1.0, package-lock 是 4.0.0,
//   CHANGELOG 已有 4.2.0 正式节, 文档写着 v4.2, 工作树却还有一整批未收口改动。
//   版本号是发布叙事的第一句话, 手写必然漂移 —— 所以用脚本逐项实测:
//
//   1) package.json.version 必须是合法 semver
//   2) package-lock.json 顶层 version 与 packages[""].version 必须等于它
//   3) CHANGELOG.md 最新的正式版本标题 (跳过 "未发布") 必须等于它
//   4) README.md 若声明 "当前版本：**x.y.z**", 必须等于它
//
// 用法:
//   node scripts/version-sync.js           # 校验, 失败非零退出 (verify / CI)
//   node scripts/version-sync.js --json    # 机器可读
// 零依赖, 只读, 不修改任何文件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { __error: e?.message || String(e) };
  }
}

function latestChangelogVersion(text) {
  const re = /^##\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/m;
  const m = String(text || "").match(re);
  return m ? m[1] : "";
}

function readmeVersion(text) {
  const m = String(text || "").match(/当前版本[：:]\s*\*\*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\*\*/);
  return m ? m[1] : "";
}

export function checkVersionSync(root) {
  const pkg = readJson(path.join(root, "package.json"));
  const lock = readJson(path.join(root, "package-lock.json"));
  const changelog = (() => {
    try { return fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"); } catch { return ""; }
  })();
  const readme = (() => {
    try { return fs.readFileSync(path.join(root, "README.md"), "utf8"); } catch { return ""; }
  })();

  const expected = String(pkg.version || "");
  const problems = [];
  const rows = [];

  const push = (name, value, ok, detail = "") => {
    rows.push({ name, value, ok, detail });
    if (!ok) problems.push(`${name} = ${value || "(缺失)"}${detail ? ` (${detail})` : ""}`);
  };

  push("package.json", expected, !!expected && SEMVER_RE.test(expected), expected ? "" : "无法读取或非 semver");
  push("package-lock.json version", lock.version || "", lock.version === expected);
  const lockRoot = lock.packages && lock.packages[""] ? lock.packages[""].version : "";
  push('package-lock packages[""].version', lockRoot || "", lockRoot === expected);

  const cl = latestChangelogVersion(changelog);
  push("CHANGELOG 最新正式版本", cl || "", cl === expected, cl ? "" : "没有找到 ## x.y.z 标题");

  const rv = readmeVersion(readme);
  if (rv) push("README 当前版本", rv, rv === expected);
  else rows.push({ name: "README 当前版本", value: "(未声明, 跳过)", ok: true, detail: "" });

  return { expected, rows, problems, ok: problems.length === 0 };
}

function main() {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(HERE, "..");
  const result = checkVersionSync(ROOT);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  console.log("=== 版本号一致性检查 ===");
  for (const r of result.rows) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(30)} ${r.value}`);
  if (result.ok) {
    console.log(`\n  ✓ 版本一致: ${result.expected}`);
  } else {
    console.error(`\n  ✗ 版本不一致 (期望 ${result.expected || "?"}):`);
    for (const p of result.problems) console.error(`    - ${p}`);
    console.error("    修复: 同步 package.json / package-lock.json / CHANGELOG.md / README.md");
  }
  process.exitCode = result.ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
