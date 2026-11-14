// webapp/src/stores/admin.js - 管理页数据: 插件 / 技能 / MCP 服务器
// 自旧 bot.js 的三个管理节移植。契约字面量保持 (test/manage-pages-2026-11-03
// 按源码锚定 "/api/skills/disable"、"/api/mcp/servers"、"/api/mcp/reconnect")。

import { reactive } from "vue";
import { showToast } from "./toast.js";
import { confirmAsk } from "./ui.js";
import {
  pluginsApi, pluginGetApi, pluginAddApi, pluginPatchApi, pluginDeleteByIdApi,
  skillsApi, skillsDisableApi, mcpServersApi, mcpServersPostApi, mcpServersDeleteApi, mcpReconnectApi,
} from "../api/endpoints.js";

export const PLUG_CAPS = [
  ["routes", "HTTP 路由"], ["lifecycle", "运行阶段"], ["tools", "工具链"],
  ["shell", "命令执行"], ["pages", "页面"], ["providers", "模型提供方"], ["extensions", "扩展"],
];

export const admin = reactive({
  plugins: [],
  plugEdit: null,       // 编辑态插件 (null = 列表; isNew = 新建)
  skills: null,
  mcp: null,
  mcpForm: null,
});

export function accessLabel(p) {
  if (!p || p.access !== "full-access") return "受限";
  const n = (p.capabilities || []).length;
  return n ? "完整权限·" + n + " 项能力" : "完整权限（未声明能力）";
}

function plugTemplate(id, name) {
  return "// " + (name || id) + " - 皮皮虾用户插件\n"
    + "//\n"
    + "// 入口在启动时被装配一次。可用能力:\n"
    + "//   ctx.provide(name, service)  注册服务 (供其他插件/内核 consume)\n"
    + "//   ctx.consume(name)           消费其他插件提供的服务\n"
    + "//   ctx.onDispose(fn)           注册卸载钩子\n"
    + "// 默认权限 restricted: 只能注册非敏感服务; 需要完整权限请在插件页显式选择 full-access。\n"
    + "module.exports = function setup(ctx) {\n"
    + "  ctx.provide(\"user." + id + "\", {\n"
    + "    hello() {\n"
    + "      return \"" + (name || id) + " 已就绪\";\n"
    + "    },\n"
    + "  });\n"
    + "};\n";
}

function suggestPluginId() {
  const used = {};
  (admin.plugins || []).forEach((p) => { used[p.id] = 1; });
  for (let i = 1; i < 1000; i++) {
    if (!used["plugin_" + i]) return "plugin_" + i;
  }
  return "plugin_" + Date.now();
}

export async function loadPlugins() {
  try {
    const j = await pluginsApi();
    if (!j || !j.ok) throw new Error((j && j.error) || "读取插件失败");
    admin.plugins = j.plugins || [];
    admin.pluginsErr = null;
  } catch (e) {
    if (!admin.plugins.length) admin.pluginsErr = (e && e.message) || "读取失败";
  }
}

export function openNewPlugin() {
  const id = suggestPluginId();
  admin.plugEdit = {
    isNew: true, id, name: "新插件", description: "",
    access: "restricted", enabled: true, entry: "index.cjs",
    code: plugTemplate(id, "新插件"), capabilities: [],
  };
}

export async function openPlugin(id) {
  if (!id) return;
  const isLoose = (admin.plugins || []).some((p) => p.id === id && p.loose);
  if (isLoose) { showToast("散文件插件是只读的，直接改插件目录里的文件即可", true); return; }
  try {
    const j = await pluginGetApi(id);
    if (!j || !j.ok || !j.plugin) throw new Error((j && j.error) || "读取插件失败");
    const p = j.plugin;
    admin.plugEdit = {
      isNew: false, id: p.id, name: p.name, description: p.description || "",
      access: p.access, enabled: p.enabled, entry: p.entry, code: p.code || "",
      capabilities: p.capabilities || [],
    };
  } catch (e) {
    showToast((e && e.message) || "读取失败", true);
  }
}

export async function savePlugin() {
  const p = admin.plugEdit;
  if (!p) return;
  const id = String(p.id || "").trim();
  const name = String(p.name || "").trim();
  if (!name) { showToast("名称不能为空", true); return; }
  if (p.isNew && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,39}$/.test(id)) {
    showToast("标识需为 2-40 位字母/数字/下划线/短横线", true);
    return;
  }
  const submit = async () => {
    const body = {
      name, description: p.description || "", access: p.access, enabled: !!p.enabled, code: p.code || "",
      capabilities: p.access === "full-access" ? (p.capabilities || []) : [],
    };
    if (p.isNew) { body.id = id; body.entry = p.entry || "index.cjs"; }
    try {
      const j = p.isNew ? await pluginAddApi(body) : await pluginPatchApi(p.id, body);
      if (!j || !j.ok) throw new Error((j && j.error) || "保存失败");
      admin.plugins = j.plugins || admin.plugins;
      admin.plugEdit = null;
      showToast(j.message || "已保存，重启应用后生效");
    } catch (e) {
      showToast((e && e.message) || "保存失败", true);
    }
  };
  // full-access 是危险操作: 站内弹窗确认, 不用会冻结页面的原生 confirm
  if (p.access === "full-access") {
    const ok = await confirmAsk("full-access 插件能触碰内核敏感能力, 只保存你完全信任的代码。", {
      title: "保存完整权限插件?", okText: "保存", danger: true,
    });
    if (ok) submit();
    return;
  }
  submit();
}

export async function togglePlugin(id, enabled) {
  try {
    const j = await pluginPatchApi(id, { enabled: !!enabled });
    if (!j || !j.ok) throw new Error((j && j.error) || "操作失败");
    admin.plugins = j.plugins || admin.plugins;
    showToast(enabled ? "已启用，重启应用后生效" : "已停用，重启应用后生效");
  } catch (e) {
    showToast((e && e.message) || "操作失败", true);
  }
}

export async function deletePlugin(id) {
  const p = (admin.plugins || []).find((x) => x.id === id);
  const nm = p ? (p.name || p.id) : id;
  const ok = await confirmAsk("目录会移入 data/plugin-trash, 可人工找回; 重启后生效。", {
    title: "删除插件「" + nm + "」?", okText: "删除", danger: true,
  });
  if (!ok) return;
  try {
    const j = await pluginDeleteByIdApi(id);
    if (!j || !j.ok) throw new Error((j && j.error) || "删除失败");
    admin.plugins = j.plugins || admin.plugins;
    if (admin.plugEdit && admin.plugEdit.id === id) admin.plugEdit = null;
    showToast(j.message || "已移入回收站，重启应用后生效");
  } catch (e) {
    showToast((e && e.message) || "删除失败", true);
  }
}

/* ---------- 技能 ---------- */
export function sourceLabel(src) {
  return src === "builtin" ? "内置" : src === "user" ? "用户" : src === "project" ? "项目" : (src || "—");
}

export async function loadSkills() {
  try {
    const j = await skillsApi();
    if (!j || j.ok === false) throw new Error((j && j.error) || "读取技能失败");
    admin.skills = j;
    admin.skillsErr = null;
  } catch (e) {
    admin.skillsErr = (e && e.message) || "读取失败";
  }
}

export async function toggleSkill(id, enabled) {
  try {
    const j = await skillsDisableApi(id, enabled);
    if (!j || j.ok === false) throw new Error((j && j.error) || "操作失败");
    admin.skills = j;
    showToast(j.message || (enabled ? "已启用" : "已停用"));
  } catch (e) {
    showToast((e && e.message) || "操作失败", true);
  }
}

/* ---------- MCP 服务器 ---------- */
function parseLines(text) {
  return String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
function parseEnv(text) {
  const out = {};
  parseLines(text).forEach((line) => {
    const i = line.indexOf("=");
    if (i <= 0) throw new Error("环境变量需为 KEY=VALUE: " + line);
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  });
  return out;
}
function parseHeaders(text) {
  const out = {};
  parseLines(text).forEach((line) => {
    const i = line.indexOf(":");
    if (i <= 0) throw new Error("请求头需为 Name: Value: " + line);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return out;
}

export async function loadMcp() {
  try {
    const j = await mcpServersApi();
    if (!j || j.ok === false) throw new Error((j && j.error) || "读取 MCP 配置失败");
    admin.mcp = j;
    admin.mcpErr = null;
  } catch (e) {
    admin.mcpErr = (e && e.message) || "读取失败";
  }
}

export function openMcpForm(i) {
  const s = i == null ? null : (admin.mcp && admin.mcp.servers ? admin.mcp.servers[i] : null);
  admin.mcpForm = s
    ? {
      index: i, name: s.name, transport: s.transport, command: s.command || "", url: s.url || "",
      argsText: (s.args || []).join("\n"), prefix: s.prefix || "", timeout: s.timeout || "",
      trusted: !!s.trusted, headersText: "", envText: "",
      headers_set: s.headers_set, env_set: s.env_set, origTransport: s.transport,
    }
    : { index: null, name: "", transport: "stdio", command: "", url: "", argsText: "", prefix: "", timeout: "", trusted: false, headersText: "", envText: "" };
}

export async function saveMcp() {
  const f = admin.mcpForm;
  if (!f) return;
  const transport = f.transport || "stdio";
  const server = {
    name: (f.name || "").trim() || undefined,
    args: parseLines(f.argsText),
    prefix: (f.prefix || "").trim(),
    trusted: !!f.trusted,
  };
  const timeoutRaw = String(f.timeout || "").trim();
  if (timeoutRaw) server.timeout = Number(timeoutRaw);
  if (transport === "http") {
    server.url = (f.url || "").trim();
    if (!server.url) { showToast("http 传输需要 URL", true); return; }
    if (f.origTransport === "stdio") server.command = null;
  } else {
    server.command = (f.command || "").trim();
    if (!server.command) { showToast("stdio 传输需要命令", true); return; }
    if (f.origTransport === "http") server.url = null;
  }
  try {
    const env = parseEnv(f.envText);
    if (Object.keys(env).length) server.env = env;
    const headers = parseHeaders(f.headersText);
    if (Object.keys(headers).length) server.headers = headers;
  } catch (e) {
    showToast((e && e.message) || "解析失败", true);
    return;
  }
  if (f.clearSecrets) { server.headers = null; server.env = null; }
  const body = { server };
  if (f.index != null) body.index = f.index;
  try {
    const j = await mcpServersPostApi(body);
    if (!j || j.ok === false) throw new Error((j && j.error) || "保存失败");
    admin.mcp = j;
    admin.mcpForm = null;
    showToast(j.message || "已保存并重连");
  } catch (e) {
    showToast((e && e.message) || "保存失败", true);
  }
}

export async function deleteMcp(i) {
  const s = (admin.mcp && admin.mcp.servers || [])[i];
  if (!s) return;
  const ok = await confirmAsk("会断开连接, 并从工具目录卸载该服务器注册的全部工具; 配置文件同步更新。", {
    title: "删除 MCP 服务器「" + s.name + "」?", okText: "删除", danger: true,
  });
  if (!ok) return;
  try {
    const j = await mcpServersDeleteApi(s.name);
    if (!j || j.ok === false) throw new Error((j && j.error) || "删除失败");
    admin.mcp = j;
    if (admin.mcpForm && admin.mcpForm.index === i) admin.mcpForm = null;
    showToast(j.message || "已删除并重连");
  } catch (e) {
    showToast((e && e.message) || "删除失败", true);
  }
}

export async function reconnectMcp() {
  try {
    const j = await mcpReconnectApi();
    if (!j || j.ok === false) throw new Error((j && j.error) || "重连失败");
    admin.mcp = j;
    showToast(j.message || "已重连");
  } catch (e) {
    showToast((e && e.message) || "重连失败", true);
  }
}
