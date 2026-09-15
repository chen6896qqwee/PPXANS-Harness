// src/seam/registry.js - 通用能力缝注册表 (P0③ seam 骨架)
// 吸收 deepseek-harness 的 "Service Definition / Service Provider / Consumer" 三分法 + dsh 的 "一个 provider 换整个产品"。
// 与 src/tools/seam.js (工具级能力缝) 互补: 这里管"服务级可替换能力" (shell/fs/embedder/...),
//   工具级管"单个工具的 Definition/Provider/Consumer"。
// 零依赖, 纯 Node 原生。用法:
//   const reg = createSeamRegistry();
//   reg.define("shell", { def: "命令执行接口", impl: LocalShellProvider, consumers: ["run_command", "code_act"] });
//   reg.provide("shell", new LocalShellProvider());        // 注册实现
//   reg.resolve("shell");                                  // 取实现 (消费方)
//   reg.swap("shell", new SandboxShellProvider());          // 一行换实现, 消费方跟着切
//   reg.status();                                          // 可观测: 哪些 seam 有实现/缺实现
export class SeamRegistry {
  constructor() {
    this.seams = new Map(); // key -> { def, implClass, impl, consumers: [], swapped: false }
  }

  // ---- Service Definition 声明 ----
  // def: { desc, interface: [方法名], consumers: [消费方标识] } 或字符串描述
  define(key, def = {}) {
    if (!key || typeof key !== "string") throw new Error("seam.define: 需 key");
    const existing = this.seams.get(key);
    if (existing) {
      // 幂等: 已存在则合并元数据, 不覆盖已装实现
      if (def.consumers) existing.consumers = [...new Set([...existing.consumers, ...def.consumers])];
      if (def.desc) existing.desc = def.desc;
      return existing;
    }
    const seam = {
      key,
      desc: def.desc || "",
      interface: Array.isArray(def.interface) ? def.interface : [],
      consumers: Array.isArray(def.consumers) ? def.consumers : [],
      impl: null,
      implName: null,
      swapped: false,
    };
    this.seams.set(key, seam);
    return seam;
  }

  // ---- Service Provider 提供 ----
  // impl: 实现实例 (或工厂函数返回实例)
  provide(key, impl, { name = "" } = {}) {
    if (!this.seams.has(key)) this.define(key);
    const seam = this.seams.get(key);
    seam.impl = typeof impl === "function" ? impl() : impl;
    seam.implName = name || (seam.impl && seam.impl.constructor ? seam.impl.constructor.name : "anonymous");
    return seam;
  }

  // ---- Consumer 消费 ----
  resolve(key) {
    const seam = this.seams.get(key);
    return seam && seam.impl ? seam.impl : null;
  }

  // 解析 + 缺失报错 (消费方友好)
  require(key) {
    const impl = this.resolve(key);
    if (!impl) throw new Error(`seam 缺失实现: ${key} (已声明, 未 provide)`);
    return impl;
  }

  // ---- 热替换: 一行换实现, 消费方跟着切 ----
  swap(key, impl, { name = "" } = {}) {
    const seam = this.define(key);
    seam.impl = typeof impl === "function" ? impl() : impl;
    seam.implName = name || (seam.impl && seam.impl.constructor ? seam.impl.constructor.name : "anonymous");
    seam.swapped = true;
    seam.swappedAt = Date.now();
    return seam;
  }

  // ---- 可观测 ----
  status() {
    const out = [];
    for (const seam of this.seams.values()) {
      out.push({
        key: seam.key,
        desc: seam.desc,
        impl: seam.implName,
        ready: !!seam.impl,
        swapped: seam.swapped,
        consumers: [...seam.consumers],
      });
    }
    return out;
  }

  has(key) { return this.seams.has(key) && !!this.seams.get(key).impl; }
  keys() { return [...this.seams.keys()]; }
}

export function createSeamRegistry() {
  return new SeamRegistry();
}

export default SeamRegistry;
