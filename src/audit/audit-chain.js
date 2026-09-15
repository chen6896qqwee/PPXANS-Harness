// src/audit/audit-chain.js - 工具调用审计哈希链 (吸收自 ppx-v2 / ppx-tools/audit.js)
// 来源: ppx-v2 v0.4.0 bundles/ppx-tools/audit.js (PPX-Agent Next v0.1 设计)
// 定位: 与 src/audit/verifier.js 互补 —— verifier 是"语义验证闸门"(防幻觉经验写回),
//       本模块是"防篡改账本"(append-only + SHA-256 哈希链), 解决"审计日志本身可被悄悄改写"的问题。
//
// 设计原则:
//   - append-only: 只追加, 绝不修改历史行
//   - 哈希链:     每行含 prevHash, 篡改任意一行会导致后续所有行校验失败
//   - 物理分库:   审计日志独立于记忆库 (记忆可恢复, 审计必须可靠)
//   - 可追责:     每次工具调用记录 工具名/参数(脱敏)/结果/耗时/时间
//
// 存储: <dataDir>/logs/audit.ndjson (每行一条 JSON)
// 校验: audit_verify 工具重放哈希链, 返回链完整性与首个断裂点
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir } from "../utils/store.js";

export const AUDIT_SEQ_FILE = "audit.seq";
export const AUDIT_FILE = "audit.ndjson";

// 审计文件路径: <dataDir>/logs/audit.ndjson
export function auditFile(dataDir) {
  return path.join(dataDir, "logs", AUDIT_FILE);
}

// 参数脱敏: 掩码命令/内容里的密钥与手机号 (防审计日志二次泄密)
// 与 utils/pii.js 的 scrubPII 同语义, 但针对 args 逐字段处理 (保留字段结构便于追责)
export function scrubArgs(args) {
  if (!args || typeof args !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v == null) { out[k] = null; continue; }
    let s = String(v);
    if (s.length > 500) s = s.slice(0, 500) + `…(+${s.length - 500}字符)`;
    out[k] = s
      .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "sk-***")
      .replace(/(Bearer\s+[A-Za-z0-9._-]{8,})/gi, "Bearer ***")
      .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)([A-Za-z0-9._-]{8,})/gi, "$1***")
      // URL query 凭证 (?token=xxx / &api_key=yyy) — 与 v1.6.0 事件流修复的同类漏洞
      .replace(/([?&](?:token|access[_-]?token|api[_-]?key|apikey|secret|password|pwd|signature|sig|auth)=)([^&\s"']+)/gi, "$1[REDACTED]")
      .replace(/(1[3-9]\d{9})/g, "1**********");
  }
  return out;
}

export class AuditLog {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = auditFile(dataDir);
    this._seqFile = path.join(path.dirname(this.file), AUDIT_SEQ_FILE);
    ensureDir(path.dirname(this.file));
    this._seq = this._loadSeq();
  }

  _loadSeq() {
    try {
      const n = Number(fs.readFileSync(this._seqFile, "utf8").trim());
      return Number.isFinite(n) ? n : 0;
    } catch {
      // 无 seq 文件 → 从日志尾部推断 (防并行进程计数漂移)
      try {
        const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
        if (lines.length) return Number(JSON.parse(lines[lines.length - 1]).seq) || 0;
      } catch {}
      return 0;
    }
  }

  _hash(entry) {
    return crypto.createHash("sha256")
      .update(`${entry.seq}|${entry.ts}|${entry.tool}|${JSON.stringify(entry.args)}|${entry.ok}|${entry.prevHash}`)
      .digest("hex");
  }

  // 追加一条审计记录 (单进程内同步追加; 用独立 seq 文件防并行进程计数漂移)
  append({ tool, args = {}, ok = true, error = null, ms = 0 }) {
    const seq = this._seq + 1;
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
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf8");
      this._seq = seq;
      fs.writeFileSync(this._seqFile, String(seq), "utf8");
    } catch {
      // 审计写入失败不阻断主流程 (可观测性降级不阻塞 agent, 与 core/trace.js 同策略)
    }
    return entry;
  }

  // 读最后一条 hash (链头)
  lastHash() {
    try {
      const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
      if (!lines.length) return null;
      return JSON.parse(lines[lines.length - 1]).hash || null;
    } catch {
      return null;
    }
  }

  // 重放校验哈希链, 返回 {ok, total, brokenAt, detail}
  verify() {
    try {
      if (!fs.existsSync(this.file)) return { ok: true, total: 0, brokenAt: null, detail: "空审计日志" };
      const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
      let prev = null;
      for (let i = 0; i < lines.length; i++) {
        let e;
        try { e = JSON.parse(lines[i]); } catch { return { ok: false, total: lines.length, brokenAt: i + 1, detail: `第 ${i + 1} 行不是合法 JSON (被篡改/截断)` }; }
        if (e.prevHash !== prev) return { ok: false, total: lines.length, brokenAt: i + 1, detail: `第 ${i + 1} 行 prevHash 断裂 (期望 ${String(prev).slice(0, 12)}…, 实际 ${String(e.prevHash).slice(0, 12)}…)` };
        const expect = crypto.createHash("sha256")
          .update(`${e.seq}|${e.ts}|${e.tool}|${JSON.stringify(e.args)}|${e.ok}|${e.prevHash}`)
          .digest("hex");
        if (expect !== e.hash) return { ok: false, total: lines.length, brokenAt: i + 1, detail: `第 ${i + 1} 行 hash 不匹配 (内容被篡改)` };
        prev = e.hash;
      }
      return { ok: true, total: lines.length, brokenAt: null, detail: `审计链完整 (${lines.length} 条)` };
    } catch (e) {
      return { ok: false, total: 0, brokenAt: null, detail: `校验失败: ${e.message}` };
    }
  }

  // 读取最近 n 条记录 (倒序, 供排查)
  tail(n = 20) {
    try {
      const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch {
      return [];
    }
  }

  // 统计概览
  stats() {
    const v = this.verify();
    return { file: this.file, ...v };
  }
}

// 审计链校验失败 → 隔离损坏段 (自愈语义: 先诊断, 再修复, 修不好就隔离并告警)
export function quarantineBroken(dataDir) {
  const log = new AuditLog(dataDir);
  const v = log.verify();
  if (v.ok) return { quarantined: false, ...v };
  try {
    const bak = log.file + ".quarantine-" + Date.now();
    fs.renameSync(log.file, bak);
    try { fs.rmSync(log._seqFile, { force: true }); } catch {}
    // 重建空日志 + 记录隔离事件 (新的链起点)
    const fresh = new AuditLog(dataDir);
    fresh.append({ tool: "audit_quarantine", args: { reason: v.detail, source: path.basename(bak) }, ok: false, error: v.detail });
    return { quarantined: true, backup: bak, ...v };
  } catch (e) {
    return { quarantined: false, error: e.message, ...v };
  }
}
