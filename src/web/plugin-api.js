// src/web/plugin-api.js - 用户插件管理 Web 接口 (2026-10-30)
//
// 契约: 一个插件 = plugins/<id>/ppx.plugin.json + 入口 .cjs (导出 (ctx) => void 或 { setup(ctx) })
// 这里只做"文件管理 + 静态校验", 不热加载代码 —— 插件在启动时装配, 保存后需重启应用生效。
//
// 安全边界:
//   - id / entry 走白名单正则, 目录穿越直接拒;
//   - 写入前用 vm.Script 做语法检查, 语法错的插件不落盘;
//   - 删除不真删, 移到 data/plugin-trash/<id>-<时间>/, 可人工找回;
//   - 代码大小上限 200KB, 说明上限 500 字。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const MANIFEST = "ppx.plugin.json";
const VALID_ACCESS = new Set(["restricted", "full-access"]);
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,39}$/;
const ENTRY_RE = /^[A-Za-z0-9._-]{1,80}\.cjs$/;
const MAX_CODE = 200 * 1024;
const MAX_DESC = 500;
const MAX_NAME = 60;

const TEMPLATE = (id, name) => `// ${name || id} - 皮皮虾用户插件
//
// 入口在启动时被装配一次。可用能力:
//   ctx.provide(name, service)  注册服务 (供其他插件/内核 consume)
//   ctx.consume(name)           消费其他插件提供的服务
//   ctx.onDispose(fn)           注册卸载钩子
// 默认权限 restricted: 只能注册非敏感服务; 需要完整权限请在插件页显式选择 full-access。
module.exports = function setup(ctx) {
  ctx.provide("user.${id}", {
    hello() {
      return "${name || id} 已就绪";
    },
  });
};
`;

function pluginsDir(channel) {
  const cfg = channel.agent?.config?.plugins || {};
  return path.resolve(channel.agent.root, cfg.dir || "plugins");
}

function trashDir(channel) {
  const dataDir = channel.agent?.dataDir || path.join(channel.agent.root, "data");
  return path.join(dataDir, "plugin-trash");
}

function safeId(raw) {
  const id = String(raw || "").trim();
  if (!ID_RE.test(id)) throw new Error("插件标识需为 2-40 位字母/数字/下划线/短横线，且以字母或数字开头");
  return id;
}

function safeEntry(raw) {
  const entry = String(raw || "index.cjs").trim();
  if (!ENTRY_RE.test(entry) || entry.includes("/") || entry.includes("\\")) {
    throw new Error("入口文件需为目录内的 .cjs 文件名，例如 index.cjs");
  }
  return entry;
}

function readManifest(dir) {
  const mf = path.join(dir, MANIFEST);
  if (!fs.existsSync(mf)) return null;
  const man = JSON.parse(fs.readFileSync(mf, "utf8"));
  return man && typeof man === "object" ? man : {};
}

function entryInfo(dir, entry) {
  const full = path.resolve(dir, entry);
  const inside = full.startsWith(dir + path.sep);
  if (!inside) return { path: full, inside: false, size: 0, mtime: null };
  try {
    const st = fs.statSync(full);
    return { path: full, inside: true, size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { path: full, inside: true, size: 0, mtime: null };
  }
}

function publicPlugin(id, dir, man, extra = {}) {
  const entry = String(man.entry || "index.cjs");
  const info = entryInfo(dir, entry);
  const access = VALID_ACCESS.has(String(man.access)) ? String(man.access) : "restricted";
  return {
    id,
    name: String(man.name || id).slice(0, MAX_NAME),
    description: String(man.description || "").slice(0, MAX_DESC),
    access,
    entry,
    enabled: man.enabled !== false,
    size: info.size,
    mtime: info.mtime,
    loose: false,
    entryInside: info.inside,
    ...extra,
  };
}

function listPlugins(channel) {
  const root = pluginsDir(channel);
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      let man = null;
      try { man = readManifest(full); } catch (err) {
        out.push({ id: e.name, name: e.name, description: "", access: "restricted", entry: "—", enabled: true, size: 0, mtime: null, loose: false, error: "清单解析失败: " + err.message });
        continue;
      }
      if (!man) continue; // 普通目录不是插件
      out.push(publicPlugin(e.name, full, man));
      continue;
    }
    // 散文件插件: 展示但只读 (与 loadPlugins 的向后兼容路径一致)
    if (e.isFile() && /\.(cjs|js)$/.test(e.name)) {
      let st = null;
      try { st = fs.statSync(full); } catch { /* 读不到就报 0 */ }
      out.push({
        id: e.name.replace(/\.(cjs|js)$/i, ""),
        name: e.name,
        description: "散文件插件（不受管理页编辑，可在此查看）",
        access: "restricted",
        entry: e.name,
        enabled: true,
        size: st ? st.size : 0,
        mtime: st ? st.mtime.toISOString() : null,
        loose: true,
        entryInside: true,
      });
    }
  }
  return out;
}

function checkCode(code, entry) {
  try {
    new vm.Script(String(code), { filename: entry });
  } catch (e) {
    const msg = String(e?.message || e);
    throw new Error("代码语法错误: " + msg.split("\n")[0]);
  }
}

function writeAtomic(file, data) {
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function createPlugin(channel, body) {
  const id = safeId(body.id);
  const root = pluginsDir(channel);
  const dir = path.join(root, id);
  if (fs.existsSync(dir)) {
    const err = new Error("同名插件已存在");
    err.status = 409;
    throw err;
  }
  const entry = safeEntry(body.entry);
  const name = String(body.name || id).trim().slice(0, MAX_NAME) || id;
  const description = String(body.description || "").trim().slice(0, MAX_DESC);
  const access = VALID_ACCESS.has(String(body.access)) ? String(body.access) : "restricted";
  let code = String(body.code == null ? TEMPLATE(id, name) : body.code);
  if (!code.trim()) code = TEMPLATE(id, name);
  if (Buffer.byteLength(code, "utf8") > MAX_CODE) throw new Error("代码过长（上限 200KB）");
  checkCode(code, entry);

  fs.mkdirSync(dir, { recursive: true });
  try {
    writeAtomic(path.join(dir, entry), code);
    writeAtomic(path.join(dir, MANIFEST), JSON.stringify({
      name, entry, access, description, enabled: true,
      created_by: "web-ui", created_at: new Date().toISOString(),
    }, null, 2) + "\n");
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return id;
}

function updatePlugin(channel, idRaw, body) {
  const id = safeId(idRaw);
  const root = pluginsDir(channel);
  const dir = path.join(root, id);
  if (!fs.existsSync(dir)) {
    const err = new Error("插件不存在");
    err.status = 404;
    throw err;
  }
  const man = readManifest(dir);
  if (!man) {
    const err = new Error("该目录不是托管插件（缺少 ppx.plugin.json）");
    err.status = 409;
    throw err;
  }
  const entry = safeEntry(man.entry || "index.cjs");
  if (body.name != null) man.name = String(body.name).trim().slice(0, MAX_NAME) || id;
  if (body.description != null) man.description = String(body.description).trim().slice(0, MAX_DESC);
  if (body.access != null) {
    if (!VALID_ACCESS.has(String(body.access))) throw new Error("access 只能是 restricted 或 full-access");
    man.access = String(body.access);
  }
  if (body.enabled != null) man.enabled = Boolean(body.enabled);
  man.entry = entry;
  man.updated_at = new Date().toISOString();

  if (body.code != null) {
    const code = String(body.code);
    if (Buffer.byteLength(code, "utf8") > MAX_CODE) throw new Error("代码过长（上限 200KB）");
    checkCode(code, entry);
    writeAtomic(path.join(dir, entry), code);
  }
  writeAtomic(path.join(dir, MANIFEST), JSON.stringify(man, null, 2) + "\n");
  return id;
}

function deletePlugin(channel, idRaw) {
  const id = safeId(idRaw);
  const root = pluginsDir(channel);
  const dir = path.join(root, id);
  const loose = path.join(root, id + ".cjs");
  const looseJs = path.join(root, id + ".js");
  let src = null;
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) src = dir;
  else if (fs.existsSync(loose)) src = loose;
  else if (fs.existsSync(looseJs)) src = looseJs;
  if (!src) {
    const err = new Error("插件不存在");
    err.status = 404;
    throw err;
  }
  // 目录必须是托管插件, 不允许误删普通目录
  if (src === dir && !fs.existsSync(path.join(dir, MANIFEST))) {
    const err = new Error("该目录不是托管插件，拒绝删除");
    err.status = 409;
    throw err;
  }
  const trash = path.join(trashDir(channel), `${id}-${Date.now()}`);
  fs.mkdirSync(trashDir(channel), { recursive: true });
  fs.renameSync(src, trash);
  return { id, trash };
}

function detail(channel, idRaw) {
  const id = safeId(idRaw);
  const dir = path.join(pluginsDir(channel), id);
  const man = readManifest(dir);
  if (!man) {
    const err = new Error("插件不存在");
    err.status = 404;
    throw err;
  }
  const p = publicPlugin(id, dir, man);
  let code = "";
  if (p.entryInside) {
    try { code = fs.readFileSync(path.join(dir, p.entry), "utf8"); } catch { /* 入口缺失时留空 */ }
  }
  return { ...p, code };
}

async function readJson(channel, req, res) {
  const raw = await channel._readBody(req, res);
  if (raw === null) return null;
  try { return JSON.parse(raw || "{}"); } catch {
    channel._json(res, 400, { ok: false, error: "非法 JSON" });
    return null;
  }
}

function fail(channel, res, e) {
  const status = Number(e?.status) || 400;
  channel._json(res, status, { ok: false, error: String(e?.message || e) });
}

export async function handlePluginApi(channel, req, res, reqPath) {
  const m = reqPath.match(/^\/api\/plugins(?:\/([^/]+))?$/);
  if (!m) return false;
  const id = m[1] ? decodeURIComponent(m[1]) : "";
  const get = req.method === "GET";

  if (get && !id) {
    try {
      const plugins = listPlugins(channel);
      channel._json(res, 200, {
        ok: true,
        dir: "plugins",
        plugins,
        total: plugins.length,
        enabled: plugins.filter((p) => p.enabled).length,
      }, { "Cache-Control": "no-store" });
    } catch (e) { fail(channel, res, e); }
    return true;
  }

  if (get && id) {
    try { channel._json(res, 200, { ok: true, plugin: detail(channel, id) }, { "Cache-Control": "no-store" }); }
    catch (e) { fail(channel, res, e); }
    return true;
  }

  if (req.method === "POST" && !id) {
    const body = await readJson(channel, req, res);
    if (body === null) return true;
    try {
      const created = createPlugin(channel, body);
      channel._json(res, 201, {
        ok: true, id: created, requiresRestart: true,
        message: "插件已创建，重启皮皮虾后生效",
        plugins: listPlugins(channel),
      });
    } catch (e) { fail(channel, res, e); }
    return true;
  }

  if (req.method === "PUT" && id) {
    const body = await readJson(channel, req, res);
    if (body === null) return true;
    try {
      const updated = updatePlugin(channel, id, body || {});
      channel._json(res, 200, {
        ok: true, id: updated, requiresRestart: true,
        message: "插件已更新，重启皮皮虾后生效",
        plugins: listPlugins(channel),
      });
    } catch (e) { fail(channel, res, e); }
    return true;
  }

  if (req.method === "DELETE" && id) {
    try {
      const out = deletePlugin(channel, id);
      channel._json(res, 200, {
        ok: true, id: out.id, trash: path.relative(channel.agent.root, out.trash).replace(/\\/g, "/"),
        requiresRestart: true,
        message: "插件已移入回收站，重启皮皮虾后生效",
        plugins: listPlugins(channel),
      });
    } catch (e) { fail(channel, res, e); }
    return true;
  }

  return false;
}
