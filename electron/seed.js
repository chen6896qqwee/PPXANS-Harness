// electron/seed.js — 工作副本播种 (版本化)
// 拆自 main.js (2026-11-03): 播种是一组纯 fs 操作, 与窗口/服务生命周期无关;
//   播种清单只在本文件内使用, 主入口仅需 seedWorkspace / resetWorkspace。
import { app, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, APP_NAME } from "./app-meta.js";
import { log } from "./app-log.js";

const SPAWN_DIRS = ["bin", "src", "skills", "experts", "plugins", "references", "webapp", "scripts", "test", "bench", "fixtures"];
// config 不再整目录播种: ppx.json 是用户配置, 打包机上的版本绝不能被复制给用户。
const SPAWN_CONFIG_FILES = ["ppx.json.example", "identity.md", "ishiki.md"];
const SPAWN_FILES = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "PPX.md"];
// 升级时这些用户资产已存在就不覆盖 (代码目录仍整体更新, 旧版先完整备份)
const USER_OWNED = new Set(["config/ppx.json", "config/identity.md", "config/ishiki.md", "PPX.md"]);
const UPGRADE_BACKUP_DIRS = [...SPAWN_DIRS, "config"];

// 2026-10-30: 版本化播种。旧实现只在缺少 bin/ppx-web.js 时播种, 安装包升级后工作副本
//   永远停在首次安装的代码 —— UI 显示新版本号, 实际跑的是旧内核。现在:
//   · 首次安装: 全量播种
//   · 版本变化: 先把旧代码+配置完整备份到 workspace.backup-<旧版本>-<时间>,
//     再覆盖代码目录; data/uploads/.ppx/用户配置/身份文件/PPX.md 原样保留。
function readSeedMarker(ws) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ws, ".desktop-seed.json"), "utf8")) || {};
  } catch { return {}; }
}

function copySpawn(fromRoot, toDir, { skipExisting = false } = {}) {
  for (const dir of SPAWN_DIRS) {
    const from = path.join(fromRoot, dir);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(toDir, dir), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(toDir, "config"), { recursive: true });
  for (const f of SPAWN_CONFIG_FILES) {
    const from = path.join(fromRoot, "config", f);
    const to = path.join(toDir, "config", f);
    if (!fs.existsSync(from)) continue;
    if (skipExisting && fs.existsSync(to)) continue;
    fs.copyFileSync(from, to);
  }
  for (const f of SPAWN_FILES) {
    const from = path.join(fromRoot, f);
    const to = path.join(toDir, f);
    if (!fs.existsSync(from)) continue;
    if (skipExisting && USER_OWNED.has(f) && fs.existsSync(to)) continue;
    fs.copyFileSync(from, to);
  }
}

function writeSeedMarker(ws, extra = {}) {
  fs.writeFileSync(path.join(ws, ".desktop-seed.json"), JSON.stringify({
    version: app.getVersion(), seededAt: new Date().toISOString(), source: APP_ROOT, ...extra,
  }, null, 2));
}

// 「重置工作副本」(菜单动作, 2026-11-12 自 main.js 移入): 整个旧副本改名备份,
//   用内置版本重新播种, 只把用户资产搬回来。失败时停在备份前一步, 不破坏现有副本。
export async function resetWorkspace({ root, win = null, onBeforeRelaunch = null } = {}) {
  const r = await dialog.showMessageBox(win ?? undefined, {
    type: "warning", title: APP_NAME,
    message: "重置工作副本？",
    detail: "当前工作副本会备份到同目录的 workspace.backup-<时间>，然后用内置版本重新播种。数据目录 (data/uploads/config/ppx.json) 会保留。",
    buttons: ["取消", "重置并重启"], defaultId: 0, cancelId: 0,
  });
  if (r.response !== 1) return false;
  let backup = "";
  try {
    backup = `${root}.backup-${Date.now()}`;
    fs.renameSync(root, backup);
    const tmp = `${root}.seeding`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const dir of SPAWN_DIRS) {
      const from = path.join(APP_ROOT, dir);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, dir), { recursive: true });
    }
    for (const f of SPAWN_FILES) {
      const from = path.join(APP_ROOT, f);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, f));
    }
    for (const keep of ["data", "uploads", ".ppx", "config/ppx.json", "PPX.md"]) {
      const from = path.join(backup, keep);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, keep), { recursive: true });
    }
    fs.renameSync(tmp, root);
    log(`工作副本已重置, 备份: ${backup}`);
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `重置失败: ${e.message}`);
    return false;
  }
  if (onBeforeRelaunch) onBeforeRelaunch();
  app.relaunch();
  app.quit();
  return true;
}

export function seedWorkspace(ws) {
  const hasCode = fs.existsSync(path.join(ws, "bin", "ppx.js"));
  const marker = readSeedMarker(ws);
  const version = app.getVersion();

  if (!hasCode) {
    const tmp = ws + ".seeding";
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    copySpawn(APP_ROOT, tmp);
    fs.mkdirSync(path.join(tmp, "uploads"), { recursive: true });
    writeSeedMarker(tmp);
    // 播种目录整体替换, 避免半成品被当成已完成
    fs.rmSync(ws, { recursive: true, force: true });
    fs.renameSync(tmp, ws);
    log(`工作副本已播种: ${ws} (v${version})`);
    return;
  }

  // 版本未变: 不动盘 (尊重用户自改后的代码)
  if (marker.version === version) return;

  // 版本升级: 备份旧代码+配置, 再覆盖代码; 数据与用户配置保留
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${ws}.backup-${marker.version || "unknown"}-${stamp}`;
  try {
    fs.mkdirSync(backup, { recursive: true });
    for (const dir of UPGRADE_BACKUP_DIRS) {
      const from = path.join(ws, dir);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(backup, dir), { recursive: true, force: true });
    }
    for (const f of SPAWN_FILES) {
      const from = path.join(ws, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(backup, f));
    }
    copySpawn(APP_ROOT, ws, { skipExisting: true });
    fs.mkdirSync(path.join(ws, "uploads"), { recursive: true });
    writeSeedMarker(ws, { upgradedFrom: marker.version || null, backup });
    log(`工作副本已升级: v${marker.version || "?"} → v${version}; 旧代码备份于 ${backup}`);
  } catch (e) {
    // 升级失败不阻断启动: 旧工作副本仍可运行, 错误留给日志排查
    log(`工作副本升级失败 (继续使用旧代码): ${e?.message || e}`);
  }
}
