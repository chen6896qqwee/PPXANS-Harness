// src/selfheal/healer.js - 自愈引擎
// 1. 启动检查: 修复缺失目录/损坏JSON/权限
// 2. 崩溃恢复: 检测上次异常退出, 清理残留
// 3. 数据一致性: 校验记忆文件
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJson } from "../utils/store.js";
import { info, warn } from "../utils/logger.js";

export class Healer {
  // dataDir 可选: 显式传入真实数据目录 (PPX_DATA_DIR 可能指向非默认位置)。
  // v1.0.8 修复 (P1-2): 原实现把 dataDir 硬编码为 path.join(rootDir, "data"),
  //   而调用方 builtin.js 传进来的是 root 而非数据目录 —— 一旦 PPX_DATA_DIR 改到别处,
  //   自愈就会在错误的目录里创建 memory/experience/logs、写 integrity.json、清理 .tmp,
  //   形成"数据目录 / 自愈目录"分叉: 真实数据目录永不被体检, 空目录反而被反复重建。
  //   默认值保留 rootDir/data, 让既有 15 处 `new Healer(root)` 调用点行为不变 (向后兼容)。
  constructor(rootDir, dataDir = null) {
    this.root = rootDir;
    this.dataDir = dataDir || path.join(rootDir, "data");
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
    // 2026-10-30: 体检从"只有 facts.json"扩展到所有单文件 JSON 存储。
    //   以前 scenes.json / jobs.json / profile.json 损坏只会被各自的下一次写盘静默覆盖成空,
    //   用户看到的是"记忆/任务莫名消失", 日志里没有任何记录。
    const stores = [
      { rel: "memory/facts.json", fallback: [] },
      { rel: "memory/l2/scenes.json", fallback: [] },
      { rel: "memory/l3/meta.json", fallback: {} },
      { rel: "scheduler/jobs.json", fallback: [] },
      { rel: "bots/profile.json", fallback: {} },
    ];
    for (const s of stores) {
      const fix = this._checkJsonStore(s.rel, s.fallback);
      if (fix) fixes.push(fix);
    }
    return fixes;
  }

  // 校验单个 JSON 存储; 损坏时优先从同名备份 (.bak* / .backup* / .corrupt-*) 恢复,
  // 无可用备份才重置为空结构。返回修复描述或 null。
  _checkJsonStore(rel, fallback) {
    const file = path.join(this.dataDir, rel);
    if (!fs.existsSync(file)) return null;
    if (readJson(file, null) !== null) return null;
    const dir = path.dirname(file);
    const base = path.basename(file);
    let restored = null;
    try {
      const cands = fs.readdirSync(dir)
        .filter((f) => f.startsWith(base + ".") && /(bak|backup|corrupt)/i.test(f))
        .map((f) => { const p = path.join(dir, f); return { p, m: fs.statSync(p).mtimeMs }; })
        .sort((a, b) => b.m - a.m);
      for (const c of cands) {
        if (readJson(c.p, null) !== null) { restored = c.p; break; }
      }
    } catch { /* 备份枚举失败按无备份处理 */ }
    const quarantine = file + ".corrupt-" + Date.now();
    try { fs.renameSync(file, quarantine); } catch { /* 改名失败则下方直接覆盖 */ }
    if (restored) {
      try {
        fs.copyFileSync(restored, file);
        return `${rel} corrupt -> restored from ${path.basename(restored)} (bad copy kept as ${path.basename(quarantine)})`;
      } catch { /* 恢复失败 → 走重置 */ }
    }
    fs.writeFileSync(file, JSON.stringify(fallback), "utf8");
    return `${rel} corrupt -> backed up to ${path.basename(quarantine)}, reset`;
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

  // ---- 备份清理 (2026-09-18 重构: 原先三个方法各抄一份「收集→按 mtime 排序→保留最近 N→删其余」) ----

  // 通用清理器: collect() 给出候选 [{p, mtime}] → 按 mtime 新→旧排序 → 保留最近 keep 个, 其余逐个 remove
  // 单个删除失败只告警不中断 (与原来逐方法 try/catch 语义一致)。
  _pruneByMtime({ keep, collect, remove, logLabel, warnLabel }) {
    const all = collect();
    all.sort((a, b) => b.mtime - a.mtime);
    const removed = [];
    for (const item of all.slice(keep)) {
      try { remove(item.p); removed.push(path.basename(item.p)); }
      catch (e) { warn(`清理${warnLabel}失败: ${item.p}: ${e.message}`); }
    }
    if (removed.length) info(`selfheal: 清理旧${logLabel} ${removed.length} 个: ${removed.join(", ")}`);
    return removed;
  }

  // 递归收集 dataDir 下满足 pred(fileName) 的文件 (带 mtime)
  _collectFilesBy(pred) {
    const found = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (pred(f)) found.push({ p, mtime: st.mtimeMs });
      }
    };
    walk(this.dataDir);
    return found;
  }

  // 清理历史 corrupt 备份: 保留最近 N 个, 更早自动删除 (默认保留 2)
  cleanupCorruptBackups(keep = 2) {
    return this._pruneByMtime({
      keep,
      collect: () => this._collectFilesBy((f) => f.includes(".corrupt-")),
      remove: (p) => fs.unlinkSync(p),
      logLabel: "corrupt 备份",
      warnLabel: "损坏备份",
    });
  }

  // 清理历史手动备份目录 (memory-backup-*): 保留最近 N 个, 更早自动删除 (默认保留 2)
  // 手动全量备份目录不在 corrupt 备份机制内, 若无清理会持续累积磁盘占用
  cleanupStaleBackupDirs(keep = 2) {
    return this._pruneByMtime({
      keep,
      collect: () => {
        if (!fs.existsSync(this.dataDir)) return [];
        const dirs = [];
        for (const f of fs.readdirSync(this.dataDir)) {
          if (!f.startsWith("memory-backup-")) continue;
          const p = path.join(this.dataDir, f);
          let st;
          try { st = fs.statSync(p); } catch { continue; }
          if (st.isDirectory()) dirs.push({ p, mtime: st.mtimeMs });
        }
        return dirs;
      },
      remove: (p) => fs.rmSync(p, { recursive: true, force: true }),
      logLabel: "手动备份目录",
      warnLabel: "过期备份目录",
    });
  }

  // 清理历史 .bak-* 文件 (去重/迁移等一次性工具留下的手动备份): 保留最近 N 个, 更早自动删除 (默认保留 2)
  // 覆盖 facts.json.bak-* / lessons.json.bak-* 等, 防手动备份文件在 data/ 内无限累积
  cleanupStaleBakFiles(keep = 2) {
    return this._pruneByMtime({
      keep,
      collect: () => this._collectFilesBy((f) => f.includes(".bak-") && !f.endsWith(".lock")),
      remove: (p) => fs.unlinkSync(p),
      logLabel: ".bak-* 备份文件",
      warnLabel: "过期备份文件",
    });
  }
  
  // 完整自愈入口
  // 2026-09-17 体检修复: 原实现把"崩溃残留已清理, 状态置回 clean"打在"修复 N 项"与
  //   "检测到崩溃残留 -> ..."之前, 日志里表现为「先说痊愈、再说发现崩溃」的因果颠倒,
  //   使用者会怀疑自愈到底有没有生效。现按"先报问题 → 再报处置 → 最后报结果"的顺序输出。
  heal() {
    // 1) 先判定上次是否崩溃 (必须在 runStartupChecks 之前判定, 否则重建的目录会掩盖证据)
    const crash = this.checkCrash();
    if (crash.crashed) warn(`selfheal: 检测到崩溃残留 -> ${crash.detail}`);
    // 2) 启动体检 + 备份清理
    const fixes = this.runStartupChecks();
    // 清理历史 corrupt 备份 (保留最近 2 个, 更早自动删除) — 之前漏调用导致 corrupt 持续累积
    const cleanedCorrupt = this.cleanupCorruptBackups(2);
    // 清理历史手动备份目录 (保留最近 2 个)
    const cleanedBackupDirs = this.cleanupStaleBackupDirs(2);
    // 清理历史 .bak-* 文件 (保留最近 2 个)
    const cleanedBakFiles = this.cleanupStaleBakFiles(2);
    // 3) 处置回执: 崩溃残留清理后主动翻回 clean —— 自愈闭环, 清了毒就要"宣布痊愈",
    //    否则下次启动还误报崩溃
    if (crash.crashed) { this.markClean(); info("selfheal: 崩溃残留已清理, 状态置回 clean"); }
    if (fixes.length) info(`selfheal: 修复 ${fixes.length} 项: ${fixes.join("; ")}`);
    else info("selfheal: 无异常");
    return { fixes, crashed: crash.crashed, crashDetail: crash.detail, cleanedCorrupt, cleanedBackupDirs, cleanedBakFiles };
  }
}
