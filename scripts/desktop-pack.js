#!/usr/bin/env node
// scripts/desktop-pack.js — 桌面端打包入口 (electron-builder 包装)
//
// 只做两件事:
//   1) 默认走国内镜像 (GitHub releases 在部分网络下不可达), 可用环境变量覆盖
//   2) 默认 Windows x64; 传 --mac / --linux / --all 时按 electron-builder 原生语义透传
//
// 用法:
//   node scripts/desktop-pack.js            # nsis 安装包 + portable 单文件
//   node scripts/desktop-pack.js --dir      # 只出未压缩目录 (调试用)
//   node scripts/desktop-pack.js --mac      # macOS dmg + zip (需在 macOS 上执行)
//   node scripts/desktop-pack.js --linux    # AppImage + deb
//
// 环境变量:
//   ELECTRON_MIRROR                    Electron 二进制镜像
//   ELECTRON_BUILDER_BINARIES_MIRROR   NSIS/winCodeSign 等构建工具镜像
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let cli;
try {
  cli = require.resolve("electron-builder/cli.js");
} catch {
  console.error("[desktop:pack] 未找到 electron-builder, 请先执行 npm install");
  process.exit(1);
}

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

if (!fs.existsSync(path.join(ROOT, "electron", "icon.ico"))) {
  console.warn("[desktop:pack] 缺少 electron/icon.ico, 将使用 Electron 默认图标");
}
if (!fs.existsSync(path.join(ROOT, "electron", "icon.png"))) {
  console.warn("[desktop:pack] 缺少 electron/icon.png (macOS/Linux 图标), 将使用 Electron 默认图标");
}

// 平台: 参数里显式给了 --win/--mac/--linux/--all 就原样透传; 否则默认 Windows x64
const PLATFORM_FLAGS = new Set(["--win", "--mac", "--linux", "--all"]);
const hasPlatformFlag = process.argv.slice(2).some((a) => PLATFORM_FLAGS.has(a));
const builderArgs = hasPlatformFlag ? [...process.argv.slice(2)] : ["--win", "--x64", ...process.argv.slice(2)];

console.log(`[desktop:pack] electron-builder ${builderArgs.join(" ") || "(nsis)"}`);
const r = spawnSync(process.execPath, [cli, ...builderArgs], {
  cwd: ROOT,
  env,
  stdio: "inherit",
});
if (r.error) {
  console.error(`[desktop:pack] 启动失败: ${r.error.message}`);
  process.exit(1);
}
// 产物安全扫描: electron-builder 的 files 清单一旦回退成 config/**, 这里会立刻红。
// 解包目录名随平台变化 (win-unpacked / mac / mac-arm64 / linux-unpacked), 统一按 resources/app 找。
if ((r.status ?? 1) === 0) {
  const dist = path.join(ROOT, "dist-desktop");
  const appDirs = fs.existsSync(dist)
    ? fs.readdirSync(dist)
        .map((d) => path.join(dist, d, "resources", "app"))
        .filter((d) => fs.existsSync(d))
    : [];
  for (const appDir of appDirs) {
    const scan = spawnSync(process.execPath, [path.join(ROOT, "scripts", "package-scan.js"), appDir], { stdio: "inherit" });
    if (scan.status !== 0) {
      console.error("[desktop:pack] 产物安全扫描未通过 (见上方问题); 安装包已生成但不应分发。");
      process.exit(1);
    }
  }
}

// 发布物校验和: GitHub Release 必须同时提供 SHA256SUMS.txt
if ((r.status ?? 1) === 0) {
  // 覆盖三平台全部发布物 (默认只认 Windows Setup exe, mac/linux 会漏)
  const sums = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "checksums.js"),
      path.join(ROOT, "dist-desktop"),
      "--pattern",
      "PPXANS-Harness-.*\\.(exe|dmg|zip|AppImage|deb)$",
    ],
    { stdio: "inherit" },
  );
  if (sums.status !== 0) {
    console.error("[desktop:pack] 生成 SHA256SUMS.txt 失败。");
    process.exit(1);
  }
  // 签名状态: 未签名只提示不失败; 已签名但哈希不匹配/无法读取则拒绝交付。
  const sig = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "verify-signature.js"),
      path.join(ROOT, "dist-desktop"),
      "--out",
      path.join(ROOT, "dist-desktop", "SIGNATURE-STATUS.txt"),
    ],
    { stdio: "inherit" },
  );
  if (sig.status !== 0) {
    console.error("[desktop:pack] 签名校验失败 (文件可能被改动或无法读取), 不应分发。");
    process.exit(1);
  }
}
process.exit(r.status ?? 1);
