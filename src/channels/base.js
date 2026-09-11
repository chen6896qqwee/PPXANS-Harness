// src/channels/base.js - 通道基类
// 统一通道接口: 每个通道实现 connect/send/disconnect
// 可选能力: test() 连通性探测 (配置是否可用), mount(server) 把 webhook 路由挂到 HTTP server
export class Channel {
  constructor(name, agent) {
    this.name = name;
    this.agent = agent;
    this.connected = false;
  }

  async connect() { throw new Error(`${this.name}: connect() 未实现`); }
  async send(to, text) { throw new Error(`${this.name}: send() 未实现`); }
  async disconnect() { this.connected = false; }

  // 连通性测试: 默认尝试 connect (验证配置能建立连接), 返回 { ok, detail }
  // 需要网络探测的通道可覆盖为更细的校验 (如验证 token)
  async test() {
    try {
      await this.connect();
      return { ok: true, detail: `${this.name} 配置有效` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }

  // 把 webhook 路由挂到 HTTP server (若通道是 webhook 型); 默认不挂载
  mount(/* httpServer */) { return null; }

  // 收到消息 → 调 agent 处理 → 回发
  async handleMessage(from, text) {
    const reply = await this.agent.chat(text);
    await this.send(from, reply);
    return reply;
  }
}