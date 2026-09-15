// src/plugin/index.js - 插件装配器
// compose(ctx, plugins): 按顺序装配插件 (同步), 返回 ctx 便于链式
// 插件 = (ctx) => void, 在函数内用 ctx.provide 注册服务、ctx.consume 消费依赖、ctx.onDispose 挂卸载钩子
// P2⑧: 插件可声明权限 (plugin.access = 'full-access'), 声明方式: 插件函数挂 access 属性 或 导出对象带 access。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { info, warn } from "../utils/logger.js";
import { Context, PLUGIN_ACCESS } from "./context.js";

export { Context } from "./context.js";

// 解析插件权限: 函数自身属性 > 导出对象 access 字段; 默认 restricted
export function pluginAccess(plugin) {
  if (typeof plugin === "function" && plugin.access) return plugin.access;
  if (plugin && plugin.access) return plugin.access;
  return PLUGIN_ACCESS.RESTRICTED;
}

// 装配插件树: 顺序执行每个插件的 setup
// v1.0.9: 单个插件 setup 抛错不中断整条装配链 (隔离失败, 其余插件照常)
// P2⑧: 每个插件在自己的权限 context 里运行 (敏感服务注册受控)。
//   full-access 插件直接用父 ctx (服务注册到顶层, agent.consume 可见);
//   restricted 插件用 withAccess 子 context (注册到子, 父链向上可查, 但敏感 key 被拒)。
export function compose(ctx, plugins = []) {
  for (const p of plugins) {
    try {
      const access = pluginAccess(p);
      const pCtx = access === PLUGIN_ACCESS.FULL ? ctx : ctx.withAccess(access);
      if (typeof p === "function") p(pCtx);
      else if (p && typeof p.setup === "function") p.setup(pCtx);
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
