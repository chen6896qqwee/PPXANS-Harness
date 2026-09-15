// src/plugin/index.js - 插件装配器
// compose(ctx, plugins): 按顺序装配插件 (同步), 返回 ctx 便于链式
// 插件 = (ctx) => void, 在函数内用 ctx.provide 注册服务、ctx.consume 消费依赖、ctx.onDispose 挂卸载钩子
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { info, warn } from "../utils/logger.js";

export { Context } from "./context.js";

// 装配插件树: 顺序执行每个插件的 setup
// v1.0.9: 单个插件 setup 抛错不中断整条装配链 (隔离失败, 其余插件照常)
export function compose(ctx, plugins = []) {
  for (const p of plugins) {
    try {
      if (typeof p === "function") p(ctx);
      else if (p && typeof p.setup === "function") p.setup(ctx);
    } catch (e) {
      warn(`[plugins] setup 失败已隔离: ${(e && e.message) || e}`);
    }
  }
  return ctx;
}

// 扫描 plugins/ 目录加载用户插件 (声明式, 不改源码扩展 agent)
// 每个 .cjs 导出插件函数 (ctx) => void 或 { setup(ctx) }
export function loadPlugins(pluginsDir) {
  if (!pluginsDir || !fs.existsSync(pluginsDir)) return [];
  const require = createRequire(import.meta.url);
  let files = [];
  try { files = fs.readdirSync(pluginsDir); } catch { return []; }
  const candidates = files.filter((f) => f.endsWith(".cjs") || f.endsWith(".js")).sort();
  const plugins = [];
  for (const f of candidates) {
    const full = path.join(pluginsDir, f);
    try {
      const mod = require(full);
      const plugin = mod && mod.default ? mod.default : mod;
      if (typeof plugin === "function") plugins.push(plugin);
      else if (plugin && typeof plugin.setup === "function") plugins.push(plugin);
      else warn(`[plugins] ${f} 需导出插件函数 (ctx) => void, 跳过`);
    } catch (e) {
      warn(`[plugins] 加载 ${f} 失败: ${e.message}`);
    }
  }
  if (plugins.length) info(`[plugins] 已加载 ${plugins.length} 个自定义插件`);
  return plugins;
}
