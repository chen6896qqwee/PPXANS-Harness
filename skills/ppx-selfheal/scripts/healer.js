// ppx-selfheal - 皮皮虾自愈引擎 (适配 ppx-memory 数据布局)
// 1. 启动体检: 建缺失目录 + 校验关键 JSON 可解析
// 2. 崩溃恢复: integrity.json 检测上次异常退出, 清理 .tmp 残留
// 3. 数据一致性: 校验 memory/facts.json, memory/l2/scenes.json, experience/lessons.json
import fs from "node:fs";
import path from "node:path";

const info  = (...a) => console.log("[" + new Date().toISOString() + "][info]", ...a);
const warn  = (...a) => console.warn("[" + new Date().toISOString() + "][warn]", ...a);

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    let raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return fallback; }
}

export class Healer {
  constructor(rootDir) {
    this.root = rootDir;
    // ppx-memory 布局: 无 data 层
    this.integrity = path.join(rootDir, "integrity.json");
  }

  // 关键 JSON 文件 (相对 root)
  get _jsonFiles() {
    return [
      { rel: "memory/facts.json",         fallback: "[]" },
      { rel: "memory/l2/scenes.json",     fallback: "[]" },
      { rel: "experience/lessons.json",   fallback: "[]" },
    ];
  }

  runStartupChecks() {
    const fixes = [];
    // 建缺失目录
    for (const sub of ["memory", "memory/daily", "memory/l0", "memory/l2", "memory/l3", "experience", "sessions", "logs/traces"]) {
      const d = path.join(this.root, sub);
      if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); fixes.push("created dir: " + sub); }
    }
    // 校验关键 JSON 可解析, 损坏则备份重建
    for (const { rel, fallback } of this._jsonFiles) {
      const f = path.join(this.root, rel);
      if (fs.existsSync(f)) {
        const parsed = readJson(f, null);
        if (parsed === null) {
          const bak = f + ".corrupt-" + Date.now();
          try { fs.renameSync(f, bak); fixes.push(`${rel} corrupt -> backed up, reset`); }
          catch { fixes.push(`${rel} corrupt (rename failed)`); }
          try { fs.writeFileSync(f, fallback, "utf8"); } catch {}
        }
      }
    }
    return fixes;
  }

  checkCrash() {
    const state = readJson(this.integrity, { clean: true, pid: null });
    const result = { crashed: false, detail: null };
    if (state.clean === false) {
      result.crashed = true;
      result.detail = "上次进程 (pid=" + state.pid + ") 未干净退出, 可能残留临时文件";
      this._cleanupTmp();
    }
    return result;
  }

  _cleanupTmp() {
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (f.endsWith(".tmp")) { try { fs.unlinkSync(p); } catch {} info("cleaned tmp: " + f); }
      }
    };
    walk(this.root);
  }

  markDirty() {
    ensureDir(this.root);
    fs.writeFileSync(this.integrity, JSON.stringify({ clean: false, pid: process.pid, ts: Date.now() }), "utf8");
  }

  markClean() {
    ensureDir(this.root);
    fs.writeFileSync(this.integrity, JSON.stringify({ clean: true, pid: process.pid, ts: Date.now() }), "utf8");
  }

  heal() {
    const fixes = this.runStartupChecks();
    const crash = this.checkCrash();
    const report = { fixes, crashed: crash.crashed, crashDetail: crash.detail };
    if (fixes.length) info("selfheal: fixed " + fixes.length + ": " + fixes.join("; "));
    else info("selfheal: no issue");
    if (crash.crashed) warn("selfheal: crash residue -> " + crash.detail);
    return report;
  }
}