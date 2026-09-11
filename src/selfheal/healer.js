// src/selfheal/healer.js - 自愈引擎
// 1. 启动检查: 修复缺失目录/损坏JSON/权限
// 2. 崩溃恢复: 检测上次异常退出, 清理残留
// 3. 数据一致性: 校验记忆文件
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJson } from "../utils/store.js";
import { info, warn, error } from "../utils/logger.js";

export class Healer {
  constructor(rootDir) {
    this.root = rootDir;
    this.dataDir = path.join(rootDir, "data");
    this.integrity = path.join(this.dataDir, "integrity.json");
  }

  // 启动体检: 返回修复清单
  runStartupChecks() {
    const fixes = [];
    ensureDir(this.dataDir);
    for (const sub of ["memory", "memory/daily", "experience", "sessions", "logs"]) {
      const d = path.join(this.dataDir, sub);
      if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); fixes.push(`created dir: ${sub}`); }
    }
    // 校验关键 JSON 可解析
    const facts = path.join(this.dataDir, "memory", "facts.json");
    if (fs.existsSync(facts)) {
      const parsed = readJson(facts, null);
      if (parsed === null) {
        // 损坏: 备份后重建
        const bak = facts + ".corrupt-" + Date.now();
        fs.renameSync(facts, bak);
        fs.writeFileSync(facts, "[]", "utf8");
        fixes.push(`facts.json corrupt -> backed up to ${path.basename(bak)}, reset`);
      }
    }
    return fixes;
  }

  // 崩溃恢复: 检查上次是否干净退出
  checkCrash() {
    const state = readJson(this.integrity, { clean: true, pid: null });
    const result = { crashed: false, detail: null };
    if (state.clean === false) {
      result.crashed = true;
      result.detail = `上次进程 (pid=${state.pid}) 未干净退出, 可能残留临时文件`;
      this._cleanupTmp();
    }
    return result;
  }

  _cleanupTmp() {
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        let st;
        try { st = fs.statSync(p); } catch { continue; } // 并发删除竞态容错
        if (st.isDirectory()) walk(p);
        else if (f.endsWith(".tmp")) { try { fs.unlinkSync(p); } catch {} info(`cleaned tmp: ${f}`); }
      }
    };
walk(this.dataDir);
  }

  markDirty() {
    ensureDir(this.dataDir);
    fs.writeFileSync(this.integrity, JSON.stringify({ clean: false, pid: process.pid, ts: Date.now() }), "utf8");
  }

  markClean() {
    ensureDir(this.dataDir);
    fs.writeFileSync(this.integrity, JSON.stringify({ clean: true, pid: process.pid, ts: Date.now() }), "utf8");
  }

  // 清理历史 corrupt 备份: 保留最近 N 个, 更早自动删除 (默认保留 2)
  cleanupCorruptBackups(keep = 2) {
    const files = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (f.includes(".corrupt-")) files.push({ p, mtime: st.mtimeMs });
      }
    };
    walk(this.dataDir);
    files.sort((a, b) => b.mtime - a.mtime);
    const removed = [];
    for (const f of files.slice(keep)) {
      try { fs.unlinkSync(f.p); removed.push(path.basename(f.p)); }
      catch (e) { warn("清理损坏备份失败: " + f.p + ": " + e.message); }
    }
    if (removed.length) info("selfheal: 清理旧 corrupt 备份 " + removed.length + " 个: " + removed.join(", "));
    return removed;
  }

  // 清理历史手动备份目录 (memory-backup-*): 保留最近 N 个, 更早自动删除 (默认保留 2)
  // 手动全量备份目录不在 corrupt 备份机制内, 若无清理会持续累积磁盘占用
  cleanupStaleBackupDirs(keep = 2) {
    if (!fs.existsSync(this.dataDir)) return [];
    const dirs = [];
    for (const f of fs.readdirSync(this.dataDir)) {
      if (!f.startsWith("memory-backup-")) continue;
      const p = path.join(this.dataDir, f);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      dirs.push({ p, mtime: st.mtimeMs });
    }
    dirs.sort((a, b) => b.mtime - a.mtime);
    const removed = [];
    for (const d of dirs.slice(keep)) {
      try { fs.rmSync(d.p, { recursive: true, force: true }); removed.push(path.basename(d.p)); }
      catch (e) { warn("清理过期备份目录失败: " + d.p + ": " + e.message); }
    }
    if (removed.length) info("selfheal: 清理旧手动备份目录 " + removed.length + " 个: " + removed.join(", "));
    return removed;
  }

  // 清理历史 .bak-* 文件 (去重/迁移等一次性工具留下的手动备份): 保留最近 N 个, 更早自动删除 (默认保留 2)
  // 覆盖 facts.json.bak-* / lessons.json.bak-* 等, 防手动备份文件在 data/ 内无限累积
  cleanupStaleBakFiles(keep = 2) {
    if (!fs.existsSync(this.dataDir)) return [];
    const files = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (f.includes(".bak-") && !f.endsWith(".lock")) files.push({ p, mtime: st.mtimeMs });
      }
    };
    walk(this.dataDir);
    files.sort((a, b) => b.mtime - a.mtime);
    const removed = [];
    for (const f of files.slice(keep)) {
      try { fs.unlinkSync(f.p); removed.push(path.basename(f.p)); }
      catch (e) { warn("清理过期备份文件失败: " + f.p + ": " + e.message); }
    }
    if (removed.length) info("selfheal: 清理旧 .bak-* 备份文件 " + removed.length + " 个: " + removed.join(", "));
    return removed;
  }
  
  // 完整自愈入口
  heal() {
    const fixes = this.runStartupChecks();
    const crash = this.checkCrash();
    // 清理历史 corrupt 备份 (保留最近 2 个, 更早自动删除) — 之前漏调用导致 corrupt 持续累积
    const cleanedCorrupt = this.cleanupCorruptBackups(2);
    // 清理历史手动备份目录 (保留最近 2 个)
    const cleanedBackupDirs = this.cleanupStaleBackupDirs(2);
    // 清理历史 .bak-* 文件 (保留最近 2 个)
    const cleanedBakFiles = this.cleanupStaleBakFiles(2);
    // 崩溃残留清理后主动翻回 clean: 自愈闭环 - 清了毒就要"宣布痊愈", 否则下次启动还误报崩溃
    if (crash.crashed) { this.markClean(); info("selfheal: 崩溃残留已清理, 状态置回 clean"); }
    const report = { fixes, crashed: crash.crashed, crashDetail: crash.detail, cleanedCorrupt, cleanedBackupDirs, cleanedBakFiles };
    if (fixes.length) info(`selfheal: 修复 ${fixes.length} 项: ${fixes.join("; ")}`);
    else info("selfheal: 无异常");
    if (crash.crashed) warn(`selfheal: 检测到崩溃残留 -> ${crash.detail}`);
    return report;
  }
}
