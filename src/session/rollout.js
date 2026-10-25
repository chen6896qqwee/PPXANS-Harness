// src/session/rollout.js - JSONL rollout 持久化 (对齐 codex rollout + fork/rewind)
// item 约定: { seq, type, payload }
//  - append: 追加一行 JSON, 目录不存在先建
//  - fork:   从源会话复制 seq<=uptoSeq 的 items 到新会话文件
//  - rewind: 删除 seq>uptoSeq 的行, 先写 .tmp 再 rename (Windows 安全: 避免读半截)
import fs from "node:fs";
import path from "node:path";

export const Rollout = {
  // 会话 rollout 文件路径 (sessionId 做安全化, 防路径穿越)
  _file(dir, sessionId) {
    const safe = String(sessionId).replace(/[^\w.-]/g, "_");
    return path.join(dir, `${safe}.rollout.jsonl`);
  },

  // 追加一行 JSON ({ts, ...item})
  append(dir, sessionId, item) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), ...item }) + "\n";
    fs.appendFileSync(this._file(dir, sessionId), line, "utf8");
  },

  // 读取全部 items (按文件顺序)
  load(dir, sessionId) {
    const file = this._file(dir, sessionId);
    const out = [];
    try {
      for (const l of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        try { out.push(JSON.parse(l)); } catch { /* 跳过损坏行 */ }
      }
    } catch { /* 文件不存在视为空 */ }
    return out;
  },

  // 从 fromSessionId 复制 seq<=uptoSeq 的 items 到 newSessionId 文件 (覆盖写, 目标为新会话)
  fork(dir, fromSessionId, newSessionId, uptoSeq) {
    const items = this.load(dir, fromSessionId).filter((it) => it.seq <= uptoSeq);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const content = items.map((it) => JSON.stringify(it)).join("\n") + (items.length ? "\n" : "");
    fs.writeFileSync(this._file(dir, newSessionId), content, "utf8");
    return items;
  },

  // 回退: 删除 seq>uptoSeq 的行 (先写 .tmp 再 rename)
  rewind(dir, sessionId, uptoSeq) {
    const items = this.load(dir, sessionId).filter((it) => it.seq <= uptoSeq);
    const file = this._file(dir, sessionId);
    const tmp = file + ".tmp";
    const content = items.map((it) => JSON.stringify(it)).join("\n") + (items.length ? "\n" : "");
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
    return items;
  },
};
