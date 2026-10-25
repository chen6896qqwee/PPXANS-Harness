#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""皮皮虾最终清理：删 web/ 旧壳(401MB) + 配置备份 + 历史文档 + 截图 + 一次性脚本。"""
import os
import shutil

ROOT = r"C:\Users\chen\Desktop\智能体项目\PPXANS-Harness"

def log(m):
    print(m)

def rm_path(rel, kind):
    p = os.path.join(ROOT, rel)
    if os.path.isdir(p):
        shutil.rmtree(p)
        log(f"  [删目录] {rel}")
    elif os.path.isfile(p):
        os.remove(p)
        log(f"  [删文件] {rel}")
    else:
        log(f"  [跳过·不存在] {rel}")

log("=== A. web/ Next.js 旧壳 (401MB) ===")
rm_path("web", "dir")

log("\n=== B. 配置备份残留 ===")
for f in os.listdir(os.path.join(ROOT, "config")):
    if ".bak" in f:
        rm_path(os.path.join("config", f), "file")

log("\n=== C. 历史发行说明 docs/releases/ ===")
for f in ["docs/releases/v1.3.1_body.md",
          "docs/releases/v1.5.0_body.md",
          "docs/releases/v1.6.0_body.md"]:
    rm_path(f, "file")

log("\n=== D. 开发截图 docs/screenshots/ ===")
sdir = os.path.join(ROOT, "docs", "screenshots")
if os.path.isdir(sdir):
    shutil.rmtree(sdir)
    log("  [删目录] docs/screenshots/")
else:
    log("  [跳过·不存在] docs/screenshots/")

log("\n=== E. tmp/ 空目录 ===")
rm_path("tmp", "dir")

log("\n=== F. 我的一次性扫描脚本 ===")
for f in ["scripts/scan-garbage.py",
          "scripts/check-web-usage.mjs",
          "scripts/check-web-usage.cjs",
          "scripts/do-cleanup.py",
          "scripts/audit-config-scan.py"]:
    rm_path(f, "file")

# workspace 侧的一性脚本也清掉
ws = r"C:\Users\chen\.openclaw\workspace\scripts\maintenance"
for f in ["healthcheck_strategy.py", "dep_check.py", "find_pipixia.py"]:
    p = os.path.join(ws, f)
    if os.path.isfile(p):
        os.remove(p)
        log(f"  [删workspace脚本] {f}")

log("\n=== 完成 ===")