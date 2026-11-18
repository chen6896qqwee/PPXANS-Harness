// src/worldmodel/index.js - 文件域世界模型 (最小可干预模拟本体, 零依赖) (2026-11-15)
//
// 边界声明 (诚实优先): 这是**文件/目录状态域**的世界模型, 不是通用世界模型 —— 它模拟
//   的对象是"写/删/移/建目录这些动作如何改变文件世界的状态"。命令执行 (exec) 不在 v1
//   模拟域内, 显式返回 simulated:false (不假装能算)。价值主张: 规划可以在模拟里跑,
//   不在真实 FS 上裸奔 —— 不可逆动作 (删除/覆盖/移动) 先 step 一遍看后果, 再决定是否
//   在真实环境执行。对应架构图第三段边界"世界模型: 外部本地服务形态"的最小落地。
//
// 能力 (全部确定性, 零 LLM):
//   seed        从真实目录建虚拟基线 (有界扫描, 跳过 node_modules/.git/data/.ppx)
//   step        结构化动作 {type: write|append|delete|move|mkdir, path, ...} → 观察
//               不变量违反 (父目录缺失/目标已存在/未初始化) 是**可观察的后果**, 不是异常
//   snapshot/restore  状态快照与回滚 —— 反事实推演的基座
//   diff        虚拟状态 vs 真实磁盘的漂移报告 (虚拟独有/真实独有/内容变更)
//   journal     步骤追加落盘, 可重放 (replay)
// 容量纪律: 文件数/单文件字节/快照数三重上限, 防模拟态无限膨胀。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir } from "../utils/store.js";
import { noteCatch } from "../utils/catch-log.js";

const STEP_TYPES = ["write", "append", "delete", "move", "mkdir", "read", "exec"];
const SKIP_DIRS = new Set(["node_modules", ".git", "data", ".ppx"]);
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_CONTENT_BYTES = 64 * 1024;
const DEFAULT_MAX_SNAPSHOTS = 20;

// ---- shell 命令 → 效果提取 (保守解析, 2026-11-16) ----
// 边界声明 (诚实优先): 这不是 shell 解释器, 是**只认确定形态**的效果提取器。目标只有一个:
//   让 `rm -rf build/` 这类不可逆命令在执行前能在虚拟世界走一遍, 看它到底会删掉什么。
//   做不到的事明确说做不到 —— 含通配符/变量/管道/子 shell/后台符/控制流的命令一律
//   parseable:false, 调用方必须回落人工确认。**半模拟比不模拟更危险**, 所以宁缺毋滥。
//
// 支持 (每段必须是简单命令): rm / mv / cp / mkdir / touch / truncate / dd / cd
// 不支持即拒绝: 任何其他命令 (node/npm/git/python/grep/sed/curl...), 以及上面这些命令的
//   通配符参数 —— 静态无法确定它们碰哪些路径。
// 段级危险字符: 必须在 splitSegments **之后**检查 —— `&&` / `||` / `;` 是合法分段符,
//   在原始命令上直接扫 `&` 会把每一条 `cd x && rm y` 都误杀 (这是第一版的实际 bug)。
//   段内残留的 `&`(后台) / `|`(管道) / 反引号 / 括号 / 通配符 / 变量, 才是真正无法静态定界的。
const UNSAFE_SEG = /\$[({]|\$\w|[*?\[\]{}]|[|&`()]|\bxargs\b|\beval\b|\bfind\b/;

function splitSegments(command) {
  const segs = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ";" || ch === "\n") { segs.push(cur); cur = ""; continue; }
    if (ch === "&" && command[i + 1] === "&") { segs.push(cur); cur = ""; i += 1; continue; }
    if (ch === "|" && command[i + 1] === "|") { segs.push(cur); cur = ""; i += 1; continue; }
    cur += ch;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

function tokenizeSegment(seg) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * 把 shell 命令解析成"对文件世界的效果"列表。纯函数、零依赖、零 LLM。
 * @param {string} command
 * @param {object} [opts]
 * @param {string|null} [opts.cwd] 相对路径的基准目录; null = 只接受绝对路径
 * @returns {{parseable:boolean, effects:Array, reason?:string, segments?:number}}
 */
export function parseShellEffects(command, { cwd = null } = {}) {
  const raw = String(command || "").trim();
  if (!raw) return { parseable: false, effects: [], reason: "空命令" };
  let cur = cwd ? path.resolve(cwd) : null;
  const abs = (p) => (path.isAbsolute(p) ? path.resolve(p) : (cur ? path.resolve(cur, p) : null));
  const effects = [];
  const segs = splitSegments(raw);

  for (const seg of segs) {
    if (UNSAFE_SEG.test(seg)) {
      return { parseable: false, effects: [], reason: `含通配符/变量/管道/子shell/后台符, 影响面无法静态确定: ${seg.slice(0, 60)}` };
    }
    const toks = tokenizeSegment(seg);
    if (!toks.length) continue;
    const head = toks[0];
    const rest = toks.slice(1);
    const flags = rest.filter((t) => t.startsWith("-"));
    const args = rest.filter((t) => !t.startsWith("-"));
    const need = (n) => args.length >= n && args.every((a) => a && !a.includes(">"));
    const push = (eff, p) => {
      const a = abs(p);
      if (!a) return { ok: false, reason: `纯虚拟世界不接受相对路径: ${p}` };
      effects.push({ ...eff, path: a });
      return { ok: true };
    };

    if (head === "cd") {
      if (args.length !== 1) return { parseable: false, effects: [], reason: "cd 参数不是恰好一个" };
      const a = abs(args[0]);
      if (!a) return { parseable: false, effects: [], reason: "cd 到相对路径但没有 cwd 基准" };
      cur = a;
      continue;
    }
    if (head === "rm") {
      if (!args.length || !need(1)) return { parseable: false, effects: [], reason: "rm 无可识别的目标路径" };
      const recursive = flags.some((f) => /[rR]/.test(f));
      for (const a of args) { const r = push({ type: "delete", recursive }, a); if (!r.ok) return { parseable: false, effects: [], reason: r.reason }; }
      continue;
    }
    if (head === "mv") {
      if (args.length !== 2) return { parseable: false, effects: [], reason: "mv 需要恰好 2 个路径" };
      let r = push({ type: "move", to: null }, args[0]);
      if (!r.ok) return { parseable: false, effects: [], reason: r.reason };
      const dst = abs(args[1]);
      if (!dst) return { parseable: false, effects: [], reason: "mv 目标为相对路径但没有 cwd 基准" };
      effects[effects.length - 1].to = dst;
      continue;
    }
    if (head === "cp") {
      if (args.length !== 2) return { parseable: false, effects: [], reason: "cp 需要恰好 2 个路径" };
      const dst = abs(args[1]);
      if (!dst) return { parseable: false, effects: [], reason: "cp 目标为相对路径但没有 cwd 基准" };
      // cp 只读源、写目标 —— 在虚拟世界里用"写一个同大小占位"表达, 不复制真实内容
      effects.push({ type: "write", path: dst, content: "", _cpFrom: abs(args[0]) });
      continue;
    }
    if (head === "mkdir") {
      if (!args.length) return { parseable: false, effects: [], reason: "mkdir 无目标路径" };
      for (const a of args) { const r = push({ type: "mkdir" }, a); if (!r.ok) return { parseable: false, effects: [], reason: r.reason }; }
      continue;
    }
    if (head === "touch") {
      if (!args.length) return { parseable: false, effects: [], reason: "touch 无目标路径" };
      for (const a of args) { const r = push({ type: "write", content: "", _touch: true }, a); if (!r.ok) return { parseable: false, effects: [], reason: r.reason }; }
      continue;
    }
    if (head === "truncate") {
      // -s 0 <path> 里的 0 是参数值, 不是路径 —— 先把它从 args 里摘掉再判目标数。
      const si = rest.findIndex((t) => t === "-s");
      const truncArgs = si >= 0 ? rest.filter((_, i) => i !== si && i !== si + 1) : args;
      const zero = flags.some((f) => /^-s0?$/.test(f)) || (si >= 0 && rest[si + 1] === "0") || /-s\s*0/.test(seg);
      if (!zero || truncArgs.length !== 1) return { parseable: false, effects: [], reason: "只支持 truncate -s 0 <path>" };
      const r = push({ type: "write", content: "" }, truncArgs[0]);
      if (!r.ok) return { parseable: false, effects: [], reason: r.reason };
      continue;
    }
    if (head === "dd") {
      const of = rest.find((t) => t.startsWith("of="));
      if (!of) return { parseable: false, effects: [], reason: "只支持带 of= 的 dd (写目标未知则不模拟)" };
      const r = push({ type: "write", content: "" }, of.slice(3));
      if (!r.ok) return { parseable: false, effects: [], reason: r.reason };
      continue;
    }
    return { parseable: false, effects: [], reason: `命令 ${head} 不在模拟域内 (支持 rm/mv/cp/mkdir/touch/truncate/dd/cd)` };
  }
  return { parseable: true, effects, segments: segs.length };
}

function shortHash(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex").slice(0, 12);
}

export class FilesystemWorldModel {
  // @param {object} opts
  // @param {string|null} [opts.root]   世界根目录 (null = 纯虚拟世界, 全部相对路径禁用)
  // @param {string|null} [opts.journalFile] 步骤落盘文件 (null = 不落盘)
  // @param {number} [opts.maxFiles]    虚拟状态条目上限 (默认 500)
  // @param {number} [opts.maxContentBytes] 单文件内容上限 (默认 64KB, 超限拒绝写入)
  // @param {number} [opts.maxSnapshots] 快照上限 (默认 20, 超出淘汰最老)
  constructor({ root = null, journalFile = null, maxFiles = DEFAULT_MAX_FILES, maxContentBytes = DEFAULT_MAX_CONTENT_BYTES, maxSnapshots = DEFAULT_MAX_SNAPSHOTS } = {}) {
    this.root = root ? path.resolve(root) : null;
    this.journalFile = journalFile || null;
    this.maxFiles = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES);
    this.maxContentBytes = Math.max(1024, Number(maxContentBytes) || DEFAULT_MAX_CONTENT_BYTES);
    this.maxSnapshots = Math.max(1, Number(maxSnapshots) || DEFAULT_MAX_SNAPSHOTS);
    this.state = new Map();      // normPath -> {kind: "file"|"dir", content?, size, seq}
    this.snapshots = new Map();  // id -> {label, ts, state: 深拷贝数组}
    this.seq = 0;                // 虚拟时钟 (每次状态变更 +1, 作 mtime)
    this._snapCounter = 0;
    if (this.journalFile) ensureDir(path.dirname(this.journalFile));
  }

  // ---- 路径归一 + 逃逸防护 (虚拟世界的物理定律之一) ----
  _norm(p) {
    const s = String(p || "").trim();
    if (!s) return { ok: false, reason: "路径为空" };
    const abs = path.isAbsolute(s) ? path.resolve(s) : (this.root ? path.resolve(this.root, s) : null);
    if (!abs) return { ok: false, reason: "纯虚拟世界 (无 root) 不接受相对路径" };
    const n = path.normalize(abs);
    if (this.root && n !== this.root && !n.startsWith(this.root + path.sep)) {
      return { ok: false, reason: `逃逸世界根目录: ${s}` };
    }
    return { ok: true, path: n };
  }

  _journal(op, payload) {
    if (!this.journalFile) return;
    try {
      fs.appendFileSync(this.journalFile, JSON.stringify({ ts: new Date().toISOString(), op, ...payload }) + "\n", "utf8");
    } catch (e) { noteCatch("src/worldmodel/index.js#_journal", e); }
  }

  // ---- 基线: 从真实目录建虚拟世界 (有界扫描) ----
  seedFromDisk({ maxFiles = this.maxFiles } = {}) {
    if (!this.root || !fs.existsSync(this.root)) return { ok: false, reason: "无 root 或 root 不存在" };
    this.state = new Map();
    let scanned = 0;
    const walk = (dir, depth) => {
      if (scanned >= maxFiles || depth > 8) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (scanned >= maxFiles) return;
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          this.state.set(full, { kind: "dir", seq: ++this.seq });
          scanned += 1;
          walk(full, depth + 1);
        } else if (e.isFile()) {
          try {
            const st = fs.statSync(full);
            if (st.size > this.maxContentBytes) { scanned += 1; continue; } // 大文件只占位不建模
            const content = fs.readFileSync(full, "utf8");
            this.state.set(full, { kind: "file", content, size: st.size, seq: ++this.seq });
            scanned += 1;
          } catch { /* 不可读文件跳过 */ }
        }
      }
    };
    walk(this.root, 0);
    this._journal("seed", { root: this.root, entries: this.state.size, scanned });
    return { ok: true, entries: this.state.size, scanned, skippedLarge: true };
  }

  _parentOk(p) {
    const parent = path.dirname(p);
    if (parent === p) return true; // 根
    if (this.state.has(parent)) return this.state.get(parent).kind === "dir";
    return this.root != null && parent === this.root; // 根目录视为存在
  }

  // ---- 步进: 一个动作改变一次世界状态 ----
  step(action = {}) {
    const type = String(action.type || "");
    if (!STEP_TYPES.includes(type)) {
      return { ok: false, simulated: false, reason: `未知动作类型 ${type} (支持 ${STEP_TYPES.join("/")})` };
    }
    // exec 无 path, 必须在 _norm 之前分流 —— 否则"路径为空"会把一条合法命令当错误挡掉
    if (type === "exec") return this._stepExec(action);
    const np = this._norm(action.path);
    if (!np.ok) return { ok: false, simulated: true, reason: np.reason };
    const p = np.path;
    this._journal("step", { action: { ...action, path: p } });

    const entry = this.state.get(p);

    if (type === "read") {
      if (!entry) return { ok: false, simulated: true, reason: "路径不存在", path: p };
      if (entry.kind === "dir") return { ok: true, simulated: true, path: p, kind: "dir", children: [...this.state.values()].length };
      return { ok: true, simulated: true, path: p, kind: "file", size: entry.size, content: String(entry.content || "").slice(0, 2000) };
    }
    if (type === "mkdir") {
      if (entry) return { ok: false, simulated: true, reason: entry.kind === "dir" ? "目录已存在" : "同名文件已存在", path: p };
      if (!this._parentOk(p)) return { ok: false, simulated: true, reason: "父目录不存在 (先 mkdir 父目录, 世界不会替你补)", path: p };
      this.state.set(p, { kind: "dir", seq: ++this.seq });
      return { ok: true, simulated: true, op: "mkdir", path: p };
    }
    if (type === "write") {
      const content = String(action.content ?? "");
      if (Buffer.byteLength(content, "utf8") > this.maxContentBytes) {
        return { ok: false, simulated: true, reason: `内容超限 (>${this.maxContentBytes}B), 世界拒绝建模`, path: p };
      }
      if (!this._parentOk(p)) return { ok: false, simulated: true, reason: "父目录不存在", path: p };
      const existed = entry?.kind === "file";
      this.state.set(p, { kind: "file", content, size: Buffer.byteLength(content, "utf8"), seq: ++this.seq });
      return { ok: true, simulated: true, op: existed ? "overwrite" : "create", path: p, sizeBefore: existed ? entry.size : null, sizeAfter: Buffer.byteLength(content, "utf8") };
    }
    if (type === "append") {
      if (!entry || entry.kind !== "file") return { ok: false, simulated: true, reason: "目标不是已存在的文件 (append 不隐式创建)", path: p };
      const content = String(action.content ?? "");
      const merged = String(entry.content || "") + content;
      if (Buffer.byteLength(merged, "utf8") > this.maxContentBytes) {
        return { ok: false, simulated: true, reason: "追加后超限", path: p };
      }
      this.state.set(p, { kind: "file", content: merged, size: Buffer.byteLength(merged, "utf8"), seq: ++this.seq });
      return { ok: true, simulated: true, op: "append", path: p, sizeBefore: entry.size, sizeAfter: Buffer.byteLength(merged, "utf8") };
    }
    if (type === "delete") {
      if (!entry) return { ok: false, simulated: true, reason: "路径不存在 (世界不会静默吞掉删除)", path: p };
      if (entry.kind === "dir") {
        const hasChildren = [...this.state.keys()].some((k) => k.startsWith(p + path.sep));
        if (hasChildren && action.recursive !== true) {
          return { ok: false, simulated: true, reason: "目录非空且未指定 recursive:true —— 这正是模拟该拦下的不可逆事故", path: p };
        }
        for (const k of [...this.state.keys()]) {
          if (k === p || k.startsWith(p + path.sep)) this.state.delete(k);
        }
      } else {
        this.state.delete(p);
      }
      return { ok: true, simulated: true, op: "delete", path: p, kind: entry.kind };
    }
    if (type === "move") {
      const nt = this._norm(action.to);
      if (!nt.ok) return { ok: false, simulated: true, reason: nt.reason };
      if (!entry) return { ok: false, simulated: true, reason: "源不存在", path: p };
      if (this.state.has(nt.path)) return { ok: false, simulated: true, reason: "目标已存在 (move 不覆盖)", path: nt.path };
      if (!this._parentOk(nt.path)) return { ok: false, simulated: true, reason: "目标父目录不存在", path: nt.path };
      const moved = [];
      for (const [k, v] of [...this.state.entries()]) {
        if (k === p || k.startsWith(p + path.sep)) {
          const nk = nt.path + k.slice(p.length);
          this.state.delete(k);
          this.state.set(nk, v);
          moved.push(nk);
        }
      }
      return { ok: true, simulated: true, op: "move", from: p, to: nt.path, moved: moved.length };
    }
    return { ok: false, simulated: false, reason: "unreachable" };
  }

  // ---- exec 预演: 命令 → 效果 → 在虚拟世界里走一遍 (2026-11-16) ----
  // 语义选择: 真实 shell 里单条命令失败不中断后续一条 (除非 set -e), 所以这里逐效果推演、
  //   不因某一条失败早退 —— 要回答的是"这条命令会造成什么", 不是"第一条为什么挂"。
  // cp 的内容用空串占位 (不复制真实字节): 对"目标会不会被覆盖、覆盖前有多大"这个判断
  //   已经够用 (sizeBefore 是真的), 但不该拿它当"复制后大小"的预测。
  _stepExec(action = {}) {
    const command = String(action.command || "").trim();
    if (!command) return { ok: false, simulated: false, reason: "exec 缺 command" };
    const parsed = parseShellEffects(command, { cwd: action.cwd || this.root || null });
    if (!parsed.parseable) {
      return { ok: false, simulated: false, command, reason: `命令超出模拟域: ${parsed.reason}` };
    }
    this._journal("exec", { command, effects: parsed.effects.length });
    const observations = [];
    for (const eff of parsed.effects) observations.push({ effect: eff.type, ...this.step(eff) });
    const blocked = observations.filter((o) => !o.ok);
    return {
      ok: true, simulated: true, op: "exec", command,
      effects: observations.slice(0, 50),      // 单命令效果数封顶, 防一条 mkdir 刷爆返回体
      effectCount: observations.length,
      blocked: blocked.slice(0, 20).map((o) => ({ path: o.path, reason: o.reason })),
      note: blocked.length
        ? `${blocked.length} 个动作在模拟世界里会被拒绝 (不可逆/前提不成立), 真实执行前先看清`
        : "全部动作可执行, 世界状态已推演 (要撤可用 snapshot/restore)",
    };
  }

  // ---- 反事实: 快照与回滚 ----
  snapshot(label = "") {
    const id = "ws_" + (++this._snapCounter).toString(36) + "_" + shortHash([...this.state.keys()].join("|"));
    this.snapshots.set(id, { label: String(label).slice(0, 60), ts: new Date().toISOString(), state: [...this.state.entries()] });
    while (this.snapshots.size > this.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value;
      this.snapshots.delete(oldest);
    }
    this._journal("snapshot", { id, label, entries: this.state.size });
    return { id, entries: this.state.size };
  }

  restore(id) {
    const snap = this.snapshots.get(String(id));
    if (!snap) return { ok: false, reason: `快照不存在 (${id}); 现有: ${[...this.snapshots.keys()].join(",") || "无"}` };
    this.state = new Map(snap.state.map(([k, v]) => [k, { ...v }]));
    this._journal("restore", { id });
    return { ok: true, restored: id, entries: this.state.size };
  }

  // ---- 漂移检测: 虚拟世界 vs 真实磁盘 (反事实与现实之间的距离) ----
  diffAgainstDisk({ maxScan = this.maxFiles } = {}) {
    if (!this.root || !fs.existsSync(this.root)) return { ok: false, reason: "无 root 可对照" };
    const real = new Map();
    let scanned = 0;
    const walk = (dir, depth) => {
      if (scanned >= maxScan || depth > 8) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (scanned >= maxScan) return;
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { real.set(full, "dir"); scanned += 1; walk(full, depth + 1); }
        else if (e.isFile()) {
          try { const st = fs.statSync(full); real.set(full, { size: st.size, mtimeMs: st.mtimeMs }); scanned += 1; } catch { /* skip */ }
        }
      }
    };
    walk(this.root, 0);
    const changed = [], onlyVirtual = [], onlyReal = [];
    for (const [k, v] of this.state) {
      const r = real.get(k);
      if (!r) { onlyVirtual.push(k); continue; }
      if (v.kind === "file" && r && typeof r === "object" && r.size !== v.size) changed.push(k);
    }
    for (const [k] of real) {
      if (!this.state.has(k)) onlyReal.push(k);
    }
    return { ok: true, changed: changed.slice(0, 50), onlyVirtual: onlyVirtual.slice(0, 50), onlyReal: onlyReal.slice(0, 50), counts: { changed: changed.length, onlyVirtual: onlyVirtual.length, onlyReal: onlyReal.length }, scanned };
  }

  stateCount() { return this.state.size; }
  snapshotList() { return [...this.snapshots.entries()].map(([id, s]) => ({ id, label: s.label, ts: s.ts, entries: s.state.length })); }
  listState({ limit = 50 } = {}) {
    return [...this.state.entries()].slice(0, Math.max(1, Number(limit) || 50))
      .map(([k, v]) => ({ path: k, kind: v.kind, size: v.size ?? null }));
  }
  reset() {
    this.state = new Map();
    this._journal("reset", {});
    return { ok: true };
  }
  replay(steps = []) {
    const results = [];
    for (const a of Array.isArray(steps) ? steps : []) results.push(this.step(a));
    return results;
  }
}
