// src/ans/lifecycle.js - 生命周期状态机 (ANS)
// 独立可更换模块: agent 只持有 Lifecycle 实例, 需要自定义阶段逻辑时替换此模块即可
// 阶段: born → growing(首次对话) → mature(10 次对话); evolving(进化)/ reproducing(繁衍) 为累计计数
// v1.0.7 持久化: 传入 file 时状态落盘 JSON, 跨进程/重启不归零 (P1)
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../utils/store.js";
import { info } from "../utils/logger.js";

const MATURE_CHATS = 10;   // 对话达到该次数 → mature
const LOG_LIMIT = 50;      // 阶段日志上限 (环形)

export class Lifecycle {
  constructor({ file = null } = {}) {
    this.file = file || null;
    this.stage = "born";
    this.bornAt = Date.now();
    this.chats = 0;
    this.evolved = 0;
    this.reproduced = 0;
    this.log = [];
    this._load();
  }

  // 从磁盘恢复状态 (跨进程/重启), 文件缺失或损坏时静默用初始值
  _load() {
    if (!this.file) return;
    try {
      if (fs.existsSync(this.file)) {
        const s = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (s && typeof s.stage === "string" && s.stage) {
          this.stage = s.stage;
          this.bornAt = s.bornAt || Date.now();
          this.chats = Number(s.chats) || 0;
          this.evolved = Number(s.evolved) || 0;
          this.reproduced = Number(s.reproduced) || 0;
          this.log = Array.isArray(s.log) ? s.log.slice(-LOG_LIMIT) : [];
        }
      }
    } catch { /* 损坏文件静默忽略, 用初始状态 */ }
  }

  _save() {
    if (!this.file) return;
    try {
      ensureDir(path.dirname(this.file));
      fs.writeFileSync(this.file, JSON.stringify({
        stage: this.stage,
        bornAt: this.bornAt,
        chats: this.chats,
        evolved: this.evolved,
        reproduced: this.reproduced,
        log: this.log.slice(-LOG_LIMIT),
      }, null, 2), "utf8");
    } catch {}
  }

  // 每次对话推进: born → growing → mature (计数由调用方保证每次对话调一次)
  tick() {
    this.chats += 1;
    if (this.stage === "born") this.to("growing", "首次对话");
    else if (this.stage === "growing" && this.chats >= MATURE_CHATS) this.to("mature", `完成 ${this.chats} 次对话`);
    this._save();
  }

  // 阶段转换 (含日志), 供进化/繁衍等外部事件调用
  to(stage, note) {
    this.stage = stage;
    this.log.push({ stage, note, ts: Date.now() });
    if (this.log.length > LOG_LIMIT) this.log.shift();
    info(`[lifecycle] ${stage}: ${note}`);
    this._save();
  }

  // 进化计数 (refine/分享经验), 内部落盘
  evolve(n = 1) { this.evolved += n; this._save(); }

  // 繁衍计数 (spawn_agent), 内部落盘
  reproduce(n = 1) { this.reproduced += n; this._save(); }

  // 人类可读摘要 (可观测)
  status() {
    return {
      stage: this.stage,
      bornAt: new Date(this.bornAt).toISOString(),
      ageMs: Date.now() - this.bornAt,
      chats: this.chats,
      evolved: this.evolved,
      reproduced: this.reproduced,
      recent: this.log.slice(-5),
    };
  }
}
