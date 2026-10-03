#!/usr/bin/env node
// skills/ppx-memory/scripts/cli.js - 皮皮虾记忆引擎「独立运行版」CLI
// 不依赖主项目 src/, 直接对记忆库做增删查 (与主项目共享同一数据格式, 可用 PPX_DATA_DIR 共用)
//
// 用法:
//   node cli.js add "内容" [--layer 1] [--importance 12] [--scope proj] [--type fact]
//   node cli.js search "查询" [--limit 5]
//   node cli.js context ["当前消息"]
//   node cli.js session [--limit 50]
//   node cli.js forget <id|内容> [--reason 原因]
//   node cli.js restore <id>
//   node cli.js deleted
//   node cli.js stats
//   node cli.js export [--no-deleted]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FactStore } from "./fact-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 默认数据目录: 技能位于 <root>/skills/ppx-memory/scripts/, 回退三级到 <root>/data
const DATA = process.env.PPX_DATA_DIR || path.resolve(HERE, "..", "..", "..", "data");

const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));
const facts = new FactStore(DATA);

// 极简参数解析: 位置参数 + --key value
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function addMemory(content, fl = {}) {
  const f = facts.add(content, {
    layer: fl.layer ? Number(fl.layer) : undefined,
    importance: fl.importance ? Number(fl.importance) : undefined,
    type: fl.type || undefined,
    scope: fl.scope || null,
  });
  if (!f) {
    out("未写入 (内容为空, 或被归一化去重命中已有条目)");
    return;
  }
  out({ ok: true, id: f.id, layer: f.layer, score: Math.round(f.score * 100) / 100, content: f.content });
}

function printFacts(list) {
  if (!list.length) {
    out("(无匹配)");
    return;
  }
  for (const f of list) {
    const s = typeof f.score === "number" ? Math.round(f.score * 100) / 100 : "-";
    out(`[L${f.layer ?? 1}] (${s}) ${f.id}  ${f.content}`);
  }
}

// 读取最近会话 (直接读 jsonl, 不依赖 SessionStore API)
function readSession(limit = 50) {
  const dir = path.join(DATA, "sessions");
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const lines = [];
  for (const { f } of files) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (line.trim()) lines.push(line);
      if (lines.length > limit * 4) break;
    }
    if (lines.length > limit * 4) break;
  }
  return lines.slice(-limit).map((l) => {
    try {
      const o = JSON.parse(l);
      const d = o.data || {};
      return { ts: o.ts, type: o.type, text: d.user || d.assistant || d.text || "" };
    } catch {
      return { raw: l };
    }
  });
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = positional;

switch (cmd) {
  case "add":
    addMemory(rest.join(" "), flags);
    break;

  case "search":
  case "q": {
    const q = rest.join(" ");
    if (!q) {
      out("需要查询关键词");
      process.exit(1);
    }
    const limit = flags.limit ? Number(flags.limit) : 5;
    const hits = facts.query(q, { limit });
    hits.forEach((h) => facts.hit(h.id)); // 命中加分 (与主项目一致)
    printFacts(hits);
    break;
  }

  case "context": {
    // 组装: 高分事实 + 长期摘要 (today/longterm 由 MemoryTicker 维护, 此处轻量回退)
    const q = rest.join(" ");
    printFacts(facts.query(q, { limit: 8 }));
    const lt = path.join(DATA, "memory", "longterm.md");
    if (fs.existsSync(lt)) {
      out("\n--- longterm ---");
      out(fs.readFileSync(lt, "utf8").trim().slice(0, 2000));
    }
    break;
  }

  case "session": {
    const limit = flags.limit ? Number(flags.limit) : 50;
    const rows = readSession(limit);
    if (!rows.length) out("(无会话记录)");
    for (const r of rows) out(`${r.type || "?"}  ${String(r.text || r.raw || "").slice(0, 160)}`);
    break;
  }

  case "forget": {
    const target = rest.join(" ");
    if (!target) {
      out("需要 id 或内容片段");
      process.exit(1);
    }
    const r = facts.forget(target, { reason: flags.reason || null });
    out(r ? { ok: true, forgotten: r.id || target } : "未找到可遗忘的条目");
    break;
  }

  case "restore": {
    const id = rest.join(" ");
    const r = facts.restore(id);
    out(r ? { ok: true, restored: r.id || id } : "未找到该 id (或未被软删)");
    break;
  }

  case "deleted": {
    const all = facts.exportAll({ includeDeleted: true });
    const list = (Array.isArray(all) ? all : all.facts || []).filter((f) => f.status === "deleted");
    if (!list.length) out("(无已遗忘条目)");
    for (const f of list) out(`${f.id}  ${f.content}  ← ${f.deletedReason || "无原因"}`);
    break;
  }

  case "stats":
    out(facts.stats());
    break;

  case "export": {
    const all = facts.exportAll({ includeDeleted: flags["no-deleted"] !== true });
    process.stdout.write(JSON.stringify(all, null, 2));
    break;
  }

  default:
    out(`皮皮虾记忆引擎 · 独立 CLI
数据目录: ${DATA}

用法:
  add <内容> [--layer 1] [--importance 12] [--scope xxx]   写入一条记忆
  search <关键词> [--limit 5]                              检索 (命中自动加分)
  context [当前消息]                                       组装上下文 (高分事实 + 长期摘要)
  session [--limit 50]                                     读取最近会话
  forget <id|内容> [--reason 原因]                         软删 (可恢复)
  restore <id>                                             回滚软删
  deleted                                                  列出已遗忘条目
  stats                                                    记忆库统计
  export [--no-deleted]                                    导出 JSON`);
    process.exit(cmd ? 1 : 0);
}
