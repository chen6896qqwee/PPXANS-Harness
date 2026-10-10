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
// 插件目录式清单文件名 (轻内核路线图缺口 3: 社区按契约贡献, 而不是读源码猜行为)
export const PLUGIN_MANIFEST_NAME = "ppx.plugin.json";
// 合法 access 取值 (白名单, 其余 fail-closed)。读取用上面的 pluginAccess (已存在, 不再重复声明)。
const VALID_ACCESS = new Set([PLUGIN_ACCESS.RESTRICTED, PLUGIN_ACCESS.FULL]);

// 把模块导出规整成插件函数, 并把 access 注入上去 (compose 时据此做敏感服务校验)
function toPluginFn(mod, label, access) {
  const plugin = mod && mod.default ? mod.default : mod;
  const okObj = plugin && typeof plugin.setup === "function";
  if (typeof plugin !== "function" && !okObj) {
    warn(`[plugins] ${label} 需导出插件函数 (ctx) => void, 跳过` +
      (/\.mjs$/.test(label) ? " (ESM 入口请改用 .cjs: 空导出的 ESM 会被识别为空对象)" : ""));
    return null;
  }
  try { plugin.access = access; } catch { /* 冻结对象: 忽略 */ }
  return plugin;
}

export function loadPlugins(pluginsDir) {
  if (!pluginsDir || !fs.existsSync(pluginsDir)) return [];
  const require = createRequire(import.meta.url);
  const plugins = [];
  let entries = [];
  try { entries = fs.readdirSync(pluginsDir, { withFileTypes: true }); } catch { return []; }

  // ---- ① 目录式插件: <dir>/ppx.plugin.json (2026-10-09 补) ----
  // 旧实现只扫顶层 .cjs/.js, 于是 plugins/amem-memory/ 这种"一目录一清单"的社区插件
  // 永远装不进来 —— 而项目自己的示范插件就是这个形状。
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of dirs) {
    const dir = path.join(pluginsDir, name);
    const mf = path.join(dir, PLUGIN_MANIFEST_NAME);
    if (!fs.existsSync(mf)) continue;              // 无清单目录行为不变 (向后兼容)
    let man = null;
    try { man = JSON.parse(fs.readFileSync(mf, "utf8")); }
    catch (e) { warn(`[plugins] ${name} 清单解析失败, 跳过: ${e.message}`); continue; }

    const access = man && man.access ? String(man.access) : PLUGIN_ACCESS.RESTRICTED;
    if (!VALID_ACCESS.has(access)) {
      warn(`[plugins] ${name} access 非法 (${access}), fail-closed 整插件跳过`);
      continue;
    }
    const entry = man && man.entry ? String(man.entry) : "index.cjs";
    const full = path.resolve(dir, entry);
    // 穿越防线: entry 必须落在插件目录内, 否则等于允许清单指向任意路径执行
    const rel = path.relative(dir, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      warn(`[plugins] ${name} entry 越出插件目录 (${entry}), 拒绝加载`);
      continue;
    }
    if (!fs.existsSync(full)) { warn(`[plugins] ${name} entry 不存在: ${entry}, 跳过`); continue; }
    try {
      const fn = toPluginFn(require(full), `${name}/${entry}`, access);
      if (fn) plugins.push(fn);
    } catch (e) {
      warn(`[plugins] 加载 ${name} 失败: ${e.message}`);
    }
  }

  // ---- ② 散文件插件 (向后兼容) ----
  const files = entries.filter((e) => e.isFile() && (e.name.endsWith(".cjs") || e.name.endsWith(".js")))
    .map((e) => e.name).sort();
  for (const f of files) {
    try {
      const fn = toPluginFn(require(path.join(pluginsDir, f)), f, PLUGIN_ACCESS.RESTRICTED);
      if (fn) plugins.push(fn);
    } catch (e) {
      warn(`[plugins] 加载 ${f} 失败: ${e.message}`);
    }
  }

  if (plugins.length) info(`[plugins] 已加载 ${plugins.length} 个自定义插件`);
  return plugins;
}
