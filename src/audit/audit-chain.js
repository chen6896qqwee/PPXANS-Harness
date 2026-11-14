// src/audit/audit-chain.js - 工具调用审计哈希链 (承接自 ppx-v2 / ppx-tools/audit.js)
// 来源: ppx-v2 v0.4.0 bundles/ppx-tools/audit.js (PPX-Agent Next v0.1 设计)
// 定位: 与 src/audit/verifier.js 互补 —— verifier 是"语义验证闸门"(防幻觉经验写回),
//       本模块是"防篡改账本"(append-only + SHA-256 哈希链), 解决"审计日志本身可被悄悄改写"的问题。
//
// 设计原则:
//   - append-only: 只追加, 绝不修改历史行
//   - 哈希链:     每行含 prevHash, 篡改任意一行会导致后续所有行校验失败
//   - HMAC 锚点 (2026-10-24): 裸哈希链是"检测强、防改弱" —— 能写文件者可整链重算后通过校验。
//     现每行追加 sig = HMAC-SHA256(链外密钥, hash)。密钥在数据目录之外 (root/.ppx/ 或环境变量),
//     攻击者只拿到 data/ 也无法伪造合法 sig。verify 时 sig 存在即校验 (错 → 断裂点),
//     缺失行按"未签名历史"继续哈希校验并计数上报 (旧日志平滑升级, 不误报)。
//   - 物理分库:   审计日志独立于记忆库 (记忆可恢复, 审计必须可靠)
//   - 可追责:     每次工具调用记录 工具名/参数(脱敏)/结果/耗时/时间
//
// 存储: <dataDir>/logs/audit.ndjson (每行一条 JSON)
// 校验: audit_verify 工具重放哈希链, 返回链完整性与首个断裂点
import { noteCatch } from "../utils/catch-log.js";
import { readFileTail } from "../utils/tail-read.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, withFileLock } from "../utils/store.js";
import { warn } from "../utils/logger.js";

const AUDIT_SEQ_FILE = "audit.seq";
const AUDIT_FILE = "audit.ndjson";
const AUDIT_DEAD_FILE = "audit.dead.jsonl";
const AUDIT_DEAD_MAX = 50;
const AUDIT_HMAC_KEY_FILE = ".ppx/audit-hmac-key";

// 2026-10-30: 追加时只需要最后一行 (prevHash/seq), 不再每次整文件读入内存 ——
//   审计日志随运行时长线性增长, 全量读取会让每次工具调用都付 O(文件大小) 的代价。
// 尾部读取上限 64KB; 单行正常 < 2KB, 足够容纳最长 error/args。
// (取尾原语 2026-11-03 收口到 utils/tail-read.js)
function readLastLine(file, maxBytes = 64 * 1024) {
  const text = readFileTail(file, maxBytes);
  const last = text.trim().split("\n").pop() || "";
  return last.trim();
}

// 审计文件路径: <dataDir>/logs/audit.ndjson
export function auditFile(dataDir) {
  return path.join(dataDir, "logs", AUDIT_FILE);
}

// HMAC 密钥解析 (2026-10-24): 环境变量 > <root>/.ppx/audit-hmac-key (缺失自动生成)。
// 密钥**必须**在数据目录之外: 攻击模型是"能写 data/ 的进程想伪造审计链", 密钥与账本同目录等于没设。
// 生成失败 (只读 FS 等) 返回 null = 退回裸哈希链 (可检测篡改, 不可抗重算), 不阻断主流程。
export function loadOrCreateHmacKey(root, { env = process.env } = {}) {
  const fromEnv = env.PPX_AUDIT_HMAC_KEY;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  try {
    const keyFile = path.join(String(root || process.cwd()), AUDIT_HMAC_KEY_FILE);
    try {
      const existing = fs.readFileSync(keyFile, "utf8").trim();
      if (existing) return existing;
    } catch (e) { if (e?.code !== "ENOENT") noteCatch(e); /* 不存在 → 生成 (预期分支, 不算异常) */ }
    ensureDir(path.dirname(keyFile));
    const key = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(keyFile, key + "\n", { encoding: "utf8", mode: 0o600 });
    return key;
  } catch (e) {
    warn(`[audit] HMAC 密钥不可用, 审计链退回裸哈希模式: ${e?.message || e}`);
    return null;
  }
}

// 正文类参数: 用户任务/对话/模型产出。审计链要证明"发生过什么", 不需要保存原文 ——
//   原文可能含隐私、商业内容或注入载荷, 且长文本会让账本无界膨胀。
//   入链只留「长度 + SHA-256 摘要」: 仍需比对时, 对疑似原文重算摘要即可验证, 不可逆推。
const BODY_FIELDS = new Set([
  "task", "tasks", "message", "messages", "prompt", "reply",
  "thinking", "content", "text", "question", "answer", "body",
]);

function toText(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch (e) { noteCatch(e); return String(v); }
}

function bodyDigest(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

// 参数脱敏: 掩码命令/内容里的密钥与手机号 (防审计日志二次泄密)
// 与 utils/pii.js 的 scrubPII 同语义, 但针对 args 逐字段处理 (保留字段结构便于追责)。
// 正文类字段 (BODY_FIELDS) 永不落原文 —— 只落长度与摘要 (2026-11-05 修复:
//   spawn_agent 的 task 曾随工具参数整段进链, 与"任务正文永不入链"的承诺相悖)。
export function scrubArgs(args) {
  if (!args || typeof args !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v == null) { out[k] = null; continue; }
    const raw = toText(v);
    if (BODY_FIELDS.has(k)) {
      out[k] = `[正文已脱敏 ${raw.length}字符 sha256:${bodyDigest(raw)}]`;
      continue;
    }
    // 标量保留原类型: 审计消费方 (看门狗/面板) 按 number/boolean 读取,
    //   字符串化会把 ok/steps 变成 "true"/"2", 静默破坏语义。
    if (typeof v === "number" || typeof v === "boolean") { out[k] = v; continue; }
    let s = raw;
    if (s.length > 500) s = s.slice(0, 500) + `…(+${s.length - 500}字符)`;
    out[k] = s
      // 2026-11-14 (评测 P2-1): 起始加负向后顾 —— 旧式 /(sk-…)/g 无边界, "ask-user-loop-*.test.js"
      //   里的 sk- 被当密钥, 生产审计 seq383 实际把命令改写成 "ask-***.test.js" (追责对不回原文)。
      //   (?<![A-Za-z]) 挡住字母前缀 (ask/mask/task…), 保留 [_-] 以覆盖 sk-proj- 类真密钥形态。
      .replace(/(?<![A-Za-z])(sk-[A-Za-z0-9_-]{8,})/g, "sk-***")
      .replace(/(Bearer\s+[A-Za-z0-9._-]{8,})/gi, "Bearer ***")
      .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)([A-Za-z0-9._-]{8,})/gi, "$1***")
      // URL query 凭证 (?token=xxx / &api_key=yyy) — 与 v1.6.0 事件流修复的同类漏洞
      .replace(/([?&](?:token|access[_-]?token|api[_-]?key|apikey|secret|password|pwd|signature|sig|auth)=)([^&\s"']+)/gi, "$1[REDACTED]")
      // \b 边界对齐 utils/pii.js:13 位 epoch 时间戳 (1[3-9]\d{9} 的子串) 不再被误当手机号
      .replace(/\b(1[3-9]\d{9})\b/g, "1**********");
  }
  return out;
}

export class AuditLog {
  // hmacKey (2026-10-24): 可选 HMAC-SHA256 密钥。提供时每条记录追加 sig 字段
  //   (对 hash 做 HMAC), verify 按 sig 锚定防"整链重算"。不提供 = 兼容旧裸哈希链。
  constructor(dataDir, { hmacKey = null } = {}) {
    this.dataDir = dataDir;
    this.file = auditFile(dataDir);
    this._seqFile = path.join(path.dirname(this.file), AUDIT_SEQ_FILE);
    this._deadFile = path.join(path.dirname(this.file), AUDIT_DEAD_FILE);
    this.hmacKey = hmacKey || null;
    ensureDir(path.dirname(this.file));
    this._seq = this._loadSeq();
    this.deadLetters = 0;
  }

  _loadSeq() {
    try {
      const n = Number(fs.readFileSync(this._seqFile, "utf8").trim());
      return Number.isFinite(n) ? n : 0;
    } catch {
      // 无 seq 文件 → 从日志尾部推断 (防并行进程计数漂移)
      try {
        const last = readLastLine(this.file);
        if (last) return Number(JSON.parse(last).seq) || 0;
      } catch (e) { noteCatch(e); }
      return 0;
    }
  }

  // 2026-11-06 (评估 P1-3): 只读 seq 档文件本身, 不做"日志尾部推断"回退 ——
  //   verify() 检测尾部截断必须以"最后写入序号"的独立真相为锚, 用链尾自身推断会掩盖截断。
  _seqFileOnly() {
    if (!fs.existsSync(this._seqFile)) return 0; // 旧日志/新装: 无 seq 档, 跳过尾部截断比对
    try {
      const n = Number(fs.readFileSync(this._seqFile, "utf8").trim());
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch (e) { noteCatch(e); return 0; } // 档文件损坏 (非缺失) 必须留痕
  }

  _hash(entry) {
    return crypto.createHash("sha256")
      .update(`${entry.seq}|${entry.ts}|${entry.tool}|${JSON.stringify(entry.args)}|${entry.ok}|${entry.prevHash}`)
      .digest("hex");
  }

  // 追加一条审计记录 (单进程内同步追加)
  // 2026-10-10 (G9 修复): 两进程交替追加时 seq 会重复 —— 各自构造时 _seq=0, 谁都不知道对方写到哪。
  //   现改为在**文件锁内**分配: seq 取 max(进程内档, 磁盘档)+1 (磁盘 seq 文件是跨进程真相),
  //   prevHash 也在锁内重读 (链头始终指向盘上真最后一条)。锁只护"读尾→算 hash→追加"临界区。
  append({ tool, args = {}, ok = true, error = null, ms = 0 }) {
    return withFileLock(this.file, () => {
      const seq = Math.max(this._seq, this._loadSeq()) + 1;
      const prevHash = this.lastHash();
      const entry = {
        seq,
        ts: new Date().toISOString(),
        tool,
        args: scrubArgs(args),
        ok: !!ok,
        error: error ? String(error).slice(0, 1000) : null,
        ms,
        prevHash,
      };
      entry.hash = this._hash(entry);
      // HMAC 锚点: sig = HMAC-SHA256(链外密钥, hash) —— 整链重算绕不过密钥
      if (this.hmacKey) entry.sig = crypto.createHmac("sha256", this.hmacKey).update(entry.hash, "utf8").digest("hex");
      this.totalWrites = (this.totalWrites || 0) + 1;
      try {
        fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf8");
        this._seq = seq;
        fs.writeFileSync(this._seqFile, String(seq), "utf8");
      } catch (e) {
        // 审计写入失败不阻断主流程 (可观测性降级不阻塞 agent, 与 core/trace.js 同策略),
        // 但不静默吞: 计数 + warn, 供 audit.health() 暴露写入健康度 (审计承诺不能被悄悄破坏)。
        this.writeFailures = (this.writeFailures || 0) + 1;
        warn(`[audit] 审计写入失败 (${tool}): ${e?.message || e}`);
        // 评测-II P1-1: 死信通道 —— 断档的那条记录正文必须有持久落点 (health 计数重启即归零,
        //   而死信文件可事后人工比对/重放), 封顶 50 条防无限增长 (模式同 channels/delivery.js)。
        this._writeDeadLetter(entry, e);
      }
      return entry;
    });
  }

  // 死信落盘: {ts, tool, seq, ok, reason, entry} 扁平行; 读写失败本身再 noteCatch (双保险不静默)。
  _writeDeadLetter(entry, err) {
    this.deadLetters = (this.deadLetters || 0) + 1;
    try {
      const row = {
        ts: new Date().toISOString(),
        tool: entry?.tool ?? null,
        seq: entry?.seq ?? null,
        ok: entry?.ok ?? null,
        reason: `审计写入失败: ${String(err?.message || err).slice(0, 200)}`,
        entry: entry ? { args: entry.args, error: entry.error, prevHash: entry.prevHash, hash: entry.hash } : null,
      };
      let rows = [];
      try {
        rows = fs.readFileSync(this._deadFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch (e) {
        // 首次 (ENOENT) = 预期分支即重建; 其余读失败必须留痕, 契约同 _loadSeq
        if (e?.code !== "ENOENT") noteCatch("src/audit/audit-chain.js#_writeDeadLetter.readDead", e);
      }
      rows = rows.slice(-(AUDIT_DEAD_MAX - 1));
      rows.push(row);
      fs.writeFileSync(this._deadFile, rows.map((r) => JSON.stringify(r) + "\n").join(""), "utf8");
    } catch (e) {
      noteCatch("src/audit/audit-chain.js#_writeDeadLetter", e);
    }
  }

  // 追加一条**调度生命周期**事件 (2026-11-05, Super-agent 调度闭环收口 ⑤):
  //   Router 的任务分派/收口 (ticket_*/assignment_*/delivery_*) 与工具调用一样进哈希链,
  //   审计轨迹从"工具调用链"升级为"覆盖调度全生命周期"。
  // 实现: 复用 append 管道 —— tool 字段存事件名 (如 "ticket_created"), args 存脱敏后的
  //   白名单字段。哈希公式 (seq|ts|tool|args|ok|prevHash) 不变, verify/HMAC 零改动全兼容;
  //   事件名与 src/protocol EventType 对齐, 与工具调用靠命名约定区分 (工单事件均以
  //   ticket_/assignment_/delivery_ 前缀开头, 不与 103 个内置工具名冲突)。
  appendEvent({ event, fields = {}, ok = true, error = null, ms = 0 }) {
    const name = String(event || "").trim();
    if (!name) return null;
    return this.append({ tool: name, args: fields, ok, error, ms });
  }

  // 审计健康度: 写入失败次数 / 总写入数 / 死信数, 供 Web 面板/监控展示 (外部体检建议)
  health() {
    return {
      ok: !this.writeFailures,
      writeFailures: this.writeFailures || 0,
      deadLetters: this.deadLetters || 0,
      totalWrites: this.totalWrites || 0,
      file: this.file,
    };
  }

  // 读最后一条 hash (链头) —— 只读文件尾部一行, 不再全量加载 (2026-10-30)
  lastHash() {
    try {
      const line = readLastLine(this.file);
      if (!line) return null;
      return JSON.parse(line).hash || null;
    } catch (e) {
      // 尾行损坏/不可读 → 返回 null 是契约, 但不能让异常消失: 否则只能看到"没有链头"
      noteCatch(e);
      return null;
    }
  }

  // 重放校验哈希链, 返回 {ok, total, brokenAt, detail, unsigned?, signed?}
  // 2026-10-24: 配置 HMAC 密钥时逐行校验 sig —— sig 错 = 被篡改 (含"整链重算"攻击,
  //   重算者没有密钥, 伪造不出合法 sig); 行缺 sig = 历史未签名行, 继续哈希校验并计数。
  // 2026-11-06 (评估 P1-3): 补两类此前不设防的完整性破坏 ——
  //   ① seq 连续性: 链内相邻两条 seq 必须差 1, 断档 = 中段有记录被抽走 (prevHash 逐条删改可伪造,
  //      但 seq 档独立于链外, 抽走中段后链尾 seq 落后于它);
  //   ② 尾部截断: seq 档记录的"最后写入序号" > 链尾 seq = 尾部记录被静默删除 —— 旧实现
  //      "删掉尾部 N 行"后 prevHash/哈希依旧自洽, verify 恒返回 ok, 无法证明"没丢记录"。
  //      反向缺口 (链尾 > seq 档) = 追加后、seq 档落盘前崩溃, 属良性窗口, 不判死只计数。
  verify() {
    try {
      const seqFileSeq = this._seqFileOnly();
      if (!fs.existsSync(this.file)) {
        if (seqFileSeq > 0) {
          return { ok: false, total: 0, brokenAt: null, truncatedTo: 0, expected: seqFileSeq, detail: `审计日志不存在但 seq 档记录 ${seqFileSeq} —— 日志疑似被整体清空/替换`, signed: !!this.hmacKey, unsigned: 0 };
        }
        return { ok: true, total: 0, brokenAt: null, detail: "空审计日志", signed: !!this.hmacKey, unsigned: 0 };
      }
      const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
      if (!lines.length && seqFileSeq > 0) {
        return { ok: false, total: 0, brokenAt: null, truncatedTo: 0, expected: seqFileSeq, detail: `审计链为空但 seq 档记录 ${seqFileSeq} —— 尾部记录被清空`, signed: !!this.hmacKey, unsigned: 0 };
      }
      let prev = null;
      let prevSeq = null;
      let unsigned = 0;
      for (let i = 0; i < lines.length; i++) {
        let e;
        try { e = JSON.parse(lines[i]); } catch (err) { noteCatch(err); return { ok: false, total: lines.length, brokenAt: i + 1, detail: `第 ${i + 1} 行不是合法 JSON (被篡改/截断)`, signed: !!this.hmacKey, unsigned }; }
        if (e.prevHash !== prev) return { ok: false, total: lines.length, brokenAt: i + 1, detail: `第 ${i + 1} 行 prevHash 断裂 (期望 ${String(prev).slice(0, 12)}…, 实际 ${String(e.prevHash).slice(0, 12)}…)`, signed: !!this.hmacKey, unsigned };
        const sq = Number(e.seq);
        if (!Number.isInteger(sq) || sq <= 0) {
          return { ok: false, total: lines.length, brokenAt: i + 1, detail: `第 ${i + 1} 行 seq 非法 (${JSON.stringify(e.seq ?? null)})`, signed: !!this.hmacKey, unsigned };
        }
        if (prevSeq !== null && sq !== prevSeq + 1) {
          return { ok: false, total: lines.length, brokenAt: i + 1, gapFrom: prevSeq, gapTo: sq, detail: `第 ${i + 1} 行 seq 断档 (期望 ${prevSeq + 1}, 实际 ${sq}) —— 中段记录被抽走`, signed: !!this.hmacKey, unsigned };
        }
        prevSeq = sq;
        const expect = crypto.createHash("sha256")
          .update(`${e.seq}|${e.ts}|${e.tool}|${JSON.stringify(e.args)}|${e.ok}|${e.prevHash}`)
          .digest("hex");
        if (expect !== e.hash) return { ok: false, total: lines.length, brokenAt: i + 1, detail: `第 ${i + 1} 行 hash 不匹配 (内容被篡改)`, signed: !!this.hmacKey, unsigned };
        if (this.hmacKey) {
          if (typeof e.sig === "string" && e.sig) {
            const sigExpect = crypto.createHmac("sha256", this.hmacKey).update(e.hash, "utf8").digest("hex");
            if (sigExpect !== e.sig) return { ok: false, total: lines.length, brokenAt: i + 1, detail: `第 ${i + 1} 行 HMAC 签名不匹配 (无密钥伪造/被篡改)`, signed: true, unsigned };
          } else {
            unsigned++; // 未签名历史行 (密钥启用前的旧记录), 不判死, 计数上报
          }
        }
        prev = e.hash;
      }
      if (seqFileSeq > 0 && prevSeq !== null && seqFileSeq > prevSeq) {
        return {
          ok: false,
          total: lines.length,
          brokenAt: lines.length,
          truncatedTo: prevSeq,
          expected: seqFileSeq,
          detail: `尾部截断: 链尾 seq=${prevSeq}, seq 档=${seqFileSeq} —— 最后 ${seqFileSeq - prevSeq} 条记录被删除`,
          signed: !!this.hmacKey,
          unsigned,
        };
      }
      return { ok: true, total: lines.length, brokenAt: null, detail: `审计链完整 (${lines.length} 条${unsigned ? `, ${unsigned} 条未签名历史` : ""})`, signed: !!this.hmacKey, unsigned };
    } catch (e) {
      noteCatch(e);
      return { ok: false, total: 0, brokenAt: null, detail: `校验失败: ${e.message}`, signed: !!this.hmacKey, unsigned: 0 };
    }
  }

  // 读取最近 n 条记录 (倒序, 供排查)
  // 读不出来 ≠ 没有记录: 失败必须留痕, 否则排查者只会看到"今天没有审计记录"。
  tail(n = 20) {
    let lines;
    try {
      lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
    } catch (e) {
      noteCatch(e);
      return [];
    }
    return lines.slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch (e) { noteCatch(e); return null; } })
      .filter(Boolean)
      .reverse();
  }

  // 统计概览
  stats() {
    const v = this.verify();
    return { file: this.file, ...v };
  }
}

// 审计链校验失败 → 隔离损坏段 (自愈语义: 先诊断, 再修复, 修不好就隔离并告警)
export function quarantineBroken(dataDir, { hmacKey = null } = {}) {
  const log = new AuditLog(dataDir, { hmacKey });
  const v = log.verify();
  if (v.ok) return { quarantined: false, ...v };
  try {
    const bak = log.file + ".quarantine-" + Date.now();
    fs.renameSync(log.file, bak);
    try { fs.rmSync(log._seqFile, { force: true }); } catch (e) { noteCatch(e); }
    // 重建空日志 + 记录隔离事件 (新的链起点)
    const fresh = new AuditLog(dataDir, { hmacKey });
    fresh.append({ tool: "audit_quarantine", args: { reason: v.detail, source: path.basename(bak) }, ok: false, error: v.detail });
    return { quarantined: true, backup: bak, ...v };
  } catch (e) {
    noteCatch(e);
    return { quarantined: false, error: e.message, ...v };
  }
}
