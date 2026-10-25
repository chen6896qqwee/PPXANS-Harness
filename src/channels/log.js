// src/channels/log.js - 日志通道 (dummy): 无网络依赖, 把消息打印到 stdout
// 用途: 主动提醒/消息先落到本地日志验证契约, 再接真实通道 (webhook/IM) 时只需"换一个 adapter"
import { Channel } from "./base.js";

export class LogChannel extends Channel {
  constructor(agent, { target = "console" } = {}) {
    super("log", agent);
    this.target = target; // 预留: "console" | 未来文件/远程日志
  }

  async connect() {
    this.connected = true;
    return this;
  }

  async send(to, text) {
    const prefix = to && to !== "*" ? `[log:${to}]` : "[log]";
    console.log(`${prefix} ${String(text)}`);
    return text;
  }

  async test() {
    return { ok: true, detail: "日志通道无需网络, 总是可用" };
  }

  async disconnect() {
    this.connected = false;
  }
}
