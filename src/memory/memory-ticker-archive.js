// src/memory/memory-ticker-archive.js - 记忆水位线 · 轮次上下文档组 (2026-11-03 从 memory-ticker.js 拆出)
// 职责: memory/turns/YYYY-MM-DD.jsonl 的写入 (_archiveTurnContext + 合批队列) 与读取
//   (turnArchive 尾窗读 + _labelArchiveRow 来源标注) + 保留期清扫 (_sweepTurnArchive)。
// 与 longterm 的分工: longterm 是"读得下去"的散文归档 (只认 user/assistant);
//   turns 是"重建得出来"的结构化档, 永不进 context() 也不进蒸馏输入。
// 类静态常量 (TURN_ARCHIVE_*) 仍声明在宿主类上 (外部与测试直接读 MemoryTicker.XXX),
//   本组经 this.constructor.* 读取 —— 与 fact-store mixin 读 TOMBSTONE_FACTOR 同法。
// 宿主经 Object.assign 装配 (见 memory-ticker.js 末尾); 技能副本 (skills/ppx-memory/scripts/
// memory-ticker.js) 仍为单文件同源, 由 test/skill-memory-drift.test.js 按组守卫。
import fs from "node:fs";
import path from "node:path";
import { noteCatch } from "../utils/catch-log.js";
import { readFileTail } from "../utils/tail-read.js";
import { ensureDir, appendText, logicalDay, withFileLock } from "../utils/store.js";
import { normalizeTier, tierFromEvidence, isQuarantined, untrustedToolsIn, TIER_MODEL } from "./provenance.js";
import { _scrub } from "./memory-ticker-daily.js";

export const memoryTickerArchiveMethods = {
  // 本轮证据 + 轮内草稿 -> memory/turns/YYYY-MM-DD.jsonl 的一行 (追加写 + 跨进程文件锁, 临界区全同步)
  _archiveTurnContext({ evidence = null, drafts = null, sessionKey = null, assistant = "", turn = 0, provenance = null } = {}) {
    // 折叠口径与 src/agent/context.js 的 foldText 同形 (头 70% + 尾 30% + 可见占位);
    // 写成局部闭包: foldText 从未被导出。
    const CAP = this.constructor.TURN_ARCHIVE_ITEM_CHARS;
    const fold = (s, cap = CAP) => {
      const str = String(s == null ? "" : s).replace(/\r/g, "");
      if (str.length <= cap) return str;
      const head = Math.max(0, Math.floor(cap * 0.7));
      const tail = Math.max(0, cap - head);
      return str.slice(0, head) + `…[已折叠, 原 ${str.length} 字符]…` + (tail ? str.slice(-tail) : "");
    };
    // 凭证类路径的正文一律不落记忆文件: 只丢正文, 不丢"这个工具跑过"这一事实
    const CRED = /(^|[^\w.-])\.env[\w.-]*|secrets?[\\/.]|credential|\.git-credentials|id_(?:rsa|ed25519)|private[-_]?key|token[\\/._-]?store/i;
    const capOf = (d) => String(d.args ?? d.input ?? d.path ?? d.command ?? "");
    const evs = Array.isArray(evidence) ? evidence : [];
    const dfs = Array.isArray(drafts) ? drafts : [];
    if (!evs.length && !dfs.length) return null;   // 普通闲聊轮: 零增长
    const credTurn = evs.some((e) => {
      const d = (e && typeof e === "object" && e.data && typeof e.data === "object") ? e.data : e;
      return CRED.test(capOf(d));
    });
    const items = [];
    for (const e of evs) {
      if (!e || typeof e !== "object") continue;
      const d = (e.data && typeof e.data === "object") ? e.data : e;
      const type = e.type || (("ok" in d || "digest" in d || "result" in d || "error" in d) ? "tool/result" : "tool/call");
      const tool = String(d.tool || d.name || "tool").slice(0, 40);
      const callId = d.callId == null ? null : String(d.callId).slice(0, 40);
      if (type === "tool/call") {
        const args = fold(d.args ?? d.input ?? "");
        items.push({ k: "call", tool, callId, args, cred: CRED.test(args) ? true : undefined });
        continue;
      }
      const body = d.digest ?? d.content ?? d.result ?? d.error ?? "";
      items.push({
        k: "result", tool, callId,
        ok: d.ok !== false,
        ms: Number(d.durationMs) || 0,
        out: credTurn || CRED.test(String(body)) ? "" : fold(body),
        omitted: credTurn ? "凭证类入参, 正文未存" : (CRED.test(String(body)) ? "正文含凭证特征, 未存" : undefined),
      });
    }
    for (const raw of dfs) {
      if (raw == null) continue;
      const isObj = raw && typeof raw === "object";
      const text = fold(isObj ? (raw.content ?? raw.text ?? "") : raw);
      // 只留工具**名** (绝不落工具入参值, 与 name-only 日志口径一致)
      const names = isObj && Array.isArray(raw.tools) ? raw.tools.map((t) => String(t).slice(0, 40)).filter(Boolean)
        : (isObj && Array.isArray(raw.tool_calls) ? raw.tool_calls.map((c) => String(c?.function?.name || c?.name || "").slice(0, 40)) : []);
      if (!text && !names.length) continue;
      // 推理链 (2026-11-03): 草稿带上该轮思考链 (已截断), 归档才能复盘"模型当时怎么想的"。
      const thinking = isObj && raw.thinking ? fold(raw.thinking, 2000) : "";
      items.push({ k: "draft", text, tools: names.length ? names.slice(0, this.constructor.TURN_ARCHIVE_ITEMS) : undefined, thinking: thinking || undefined });
    }
    if (!items.length) return null;
    const MAX = Math.max(1, this.constructor.TURN_ARCHIVE_ITEMS);
    const evOnly = items.filter((x) => x.k !== "draft");
    const draftOnly = items.filter((x) => x.k === "draft");
    let dropped = Math.max(0, evOnly.length - MAX) + Math.max(0, draftOnly.length - MAX);
    let body = [...evOnly.slice(-MAX), ...draftOnly.slice(-MAX)]
      .filter((x) => !(x.k === "draft" && x.text && x.text === String(assistant || "").replace(/\r/g, "").trim()));
    const rec = {
      // v:2 —— 新增 prov/untrusted 两个来源分级字段 (v:1 = 无分级标注的存量行, 读取侧按工具名重算)
      v: 2, ts: Date.now(), day: logicalDay(),
      sessionKey: String(sessionKey == null ? "" : sessionKey).slice(0, 80),
      turn,
      counts: { evidence: evOnly.length, drafts: draftOnly.length },
      // 来源标注 (与 src 同口径): 这一行里存的是**抓来的正文**, 所以它自己就是不可信输入。
      //   写清 tier + 污点工具名, 未来的读者 (经验蒸馏/审计/回放) 一眼能判定"要不要包 wrapUntrusted",
      //   不必回头猜工具白名单。
      prov: String(provenance || TIER_MODEL),
      untrusted: untrustedToolsIn(evidence).slice(0, 8),
    };
    const lineOf = (arr, drop) => JSON.stringify(drop > 0 ? { ...rec, dropped: drop, items: arr } : { ...rec, items: arr });
    let line = lineOf(body, dropped);
    while (Buffer.byteLength(line, "utf8") > this.constructor.TURN_ARCHIVE_LINE_BYTES && body.length > 1) {
      body = body.slice(1);
      dropped++;
      line = lineOf(body, dropped);
    }
    const file = path.join(this.dir, "turns", `${rec.day}.jsonl`);
    // 2026-10-30 (L1 合批): 不再每轮 ensureDir + 加锁 + append —— 入队, 由阈值/强制点批量落盘。
    //   落档失败不阻塞蒸馏主链 (与原来单条写入的容忍度一致)。
    this._enqueueArchive(file, _scrub(line) + "\n");
    return { file, bytes: Buffer.byteLength(line, "utf8"), items: body.length, dropped, queued: true };
  },

  // 归档入队 (调用方: _archiveTurnContext)。达阈值或超时即落盘, 否则留到强制点。
  _enqueueArchive(file, text) {
    try {
      this._archiveQueue.push({ file, text });
      const now = Date.now();
      if (this._archiveQueue.length >= this.constructor.TURN_ARCHIVE_BATCH
        || now - (this._archiveFlushedAt || 0) >= this.constructor.TURN_ARCHIVE_FLUSH_MS) {
        this.flushTurnArchive();
      }
    } catch (e) { noteCatch(e); /* 入队异常不阻塞主链 */ }
  },

  // 批量落盘队列 (强制点: 跨天 / turnArchive 读取 / 进程收口 / 队列达阈值)。
  // 同一文件的多个行合成一次锁 + 一次 append; 逐文件 try/catch, 单文件失败不拖累其他文件。
  // 返回真正落盘的行数 (供测试与可观测)。
  flushTurnArchive() {
    const q = this._archiveQueue;
    if (!Array.isArray(q) || !q.length) return 0;
    this._archiveQueue = [];
    const byFile = new Map();
    for (const it of q) {
      if (!it || !it.file) continue;
      if (!byFile.has(it.file)) byFile.set(it.file, []);
      byFile.get(it.file).push(it.text);
    }
    let n = 0;
    for (const [file, lines] of byFile) {
      try {
        ensureDir(path.dirname(file));   // 锁文件与数据文件同目录, 缺目录时 wx 抢锁必失败
        withFileLock(file, () => appendText(file, lines.join("")));
        n += lines.length;
      } catch (e) { noteCatch("src/memory/memory-ticker.js#withFileLock", e); /* 单文件落档失败: 丢弃该批 (与单条写入失败的容忍度一致) */ }
    }
    this._archiveFlushedAt = Date.now();
    return n;
  },

  // 读回某天的轮次上下文 (尾窗读 + 逐行解析, 坏行跳过不抛)。结果从不注入 prompt。
  //
  // 来源分级 (v2026-10-XX, 与 src 同口径): 返回的每一行都带 prov / untrusted / quarantined 三个
  //   判定字段, 读取方**不需要**再去猜工具白名单:
  //     · v≥2 的行按写入时记下的 prov;
  //     · v:1 的存量行按 items 里的工具名确定性重算 (只看工具名 = 调用点事实, 不看正文, provDerived=true 可见)。
  //   quarantined=true 的行里存的是外部抓取正文: 任何把它写进 system prompt 的调用方必须再过一层
  //   src/security/injection.js 的 wrapUntrusted —— 本层保证"必须包裹"这件事是可判定的, 而不是靠约定。
  _labelArchiveRow(r) {
    const items = Array.isArray(r.items) ? r.items : [];
    const declared = r.prov ? normalizeTier(r.prov) : null;
    const prov = declared || (tierFromEvidence(items) || TIER_MODEL);
    r.prov = prov;
    r.quarantined = isQuarantined(prov);
    if (!Array.isArray(r.untrusted)) r.untrusted = untrustedToolsIn(items).slice(0, 8);
    if (!declared) r.provDerived = true; // 存量行的 tier 是算出来的, 不是写下来的 (诚实标注来源链)
    return r;
  },

  turnArchive({ day = null, sessionKey = null, limit = 20, tailBytes = 65536 } = {}) {
    // 读取前先落盘队列 —— 合批后最近几轮可能还在内存里, 不 flush 会让读取方"看不见刚发生的对话"
    this.flushTurnArchive();
    const d = day ? String(day).slice(0, 10) : logicalDay();
    const file = path.join(this.dir, "turns", `${d}.jsonl`);
    const TAIL = Math.max(1024, Number(tailBytes) || 65536);
    const out = [];
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return out; /* swallowed-ok(2026-11-03): 当日归档不存在 → 空 */ }
    // 取尾原语 2026-11-03 收口到 utils/tail-read.js; 半行 shift 语义留在这里
    try {
      const lines = readFileTail(file, TAIL).split("\n");
      if (size > TAIL) lines.shift();   // 窗口起点落在某行中间: 半截行不可解析
      for (const l of lines) {
        const s = l.trim();
        if (!s) continue;
        try {
          const r = JSON.parse(s);
          if (!r || typeof r !== "object") continue;
          if (sessionKey != null && String(r.sessionKey || "") !== String(sessionKey)) continue;
          out.push(this._labelArchiveRow(r));
        } catch (e) { noteCatch(e); /* 交错/半截行: 跳过 */ }
      }
    } catch (e) { noteCatch(e); /* 读失败: 返回已解析部分 */ }
    return out.slice(-Math.max(1, Number(limit) || 20));
  },

  // 轮次上下文档的保留期清理 (挂在按天边界上, 一天最多真跑一次; 与 src 同口径的 turns 一支)
  _sweepTurnArchive(today) {
    const retainDays = this.constructor.TURN_ARCHIVE_RETAIN_DAYS;
    if (retainDays <= 0) return 0;
    const DAY_MS = 86400000;
    const dir = path.join(this.dir, "turns");
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return 0; /* swallowed-ok(2026-11-03): 归档目录不存在 → 0 */ }
    let n = 0;
    for (const name of names) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!m || m[1] === today) continue;                 // 非按日命名的文件一律不碰
      const t = Date.parse(`${m[1]}T00:00:00`);
      if (!Number.isFinite(t) || Math.floor((Date.now() - t) / DAY_MS) < retainDays) continue;
      try { fs.rmSync(path.join(dir, name), { force: true }); n++; } catch (e) { noteCatch(e); }
    }
    return n;
  },
};
