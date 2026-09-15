"use client";
// web/src/app/settings/plugins/page.tsx - 插件与能力
// 工具启停开关 (持久化到 config.tools.disabled) / 方法技能 / MCP 配置与连接状态
import { useEffect, useState } from "react";
import Link from "next/link";
import { getApiBase, getAuthToken, getSettings, saveSettings, type AppSettings, type McpServerConfig } from "../../../lib/api";

type ToolInfo = { name: string; enabled: boolean; category?: string };
type SkillInfo = { id: string; description?: string };
type Stats = {
  tools?: { total: number; enabled: number; list?: ToolInfo[] };
  skills?: SkillInfo[];
  mcp?: { connected: boolean; count: number };
};

async function fetchStats(): Promise<Stats> {
  const base = getApiBase();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const tok = getAuthToken();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  const r = await fetch(base + "/api/stats", { headers });
  const text = await r.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && typeof data === "object" && "error" in data) ? String((data as { error: unknown }).error) : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return (data || {}) as Stats;
}

export default function PluginsSettingsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  // MCP 表单
  const [autoConnect, setAutoConnect] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  // 工具表单
  const [disabledTools, setDisabledTools] = useState<string[]>([]);

  async function refresh() {
    try {
      const [st, se] = await Promise.all([fetchStats(), getSettings()]);
      setStats(st);
      setSettings(se.settings);
      setAutoConnect(se.settings.mcp.auto_connect);
      setMcpServers(se.settings.mcp.servers || []);
      setDisabledTools(se.settings.tools.disabled || []);
      setErr(null);
    } catch (e: unknown) {
      setErr((e as Error).message || "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const tools = stats?.tools;
  const toolList = tools?.list || [];
  const skills = stats?.skills || [];
  const mcp = stats?.mcp;

  // 工具启停
  async function toggleTool(name: string, enabled: boolean) {
    setSaving(true); setErr(null); setOkMsg(null);
    try {
      const next = new Set(disabledTools);
      if (enabled) next.delete(name); else next.add(name);
      await saveSettings({ tools: { disabled: [...next] } });
      setDisabledTools([...next]);
      setOkMsg(`已${enabled ? "启用" : "禁用"} ${name}, 立即生效`);
      await refresh();
    } catch (e: unknown) {
      setErr((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  // MCP 服务器操作
  function updateServer(i: number, patch: Partial<McpServerConfig>) {
    setMcpServers((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function addServer() {
    setMcpServers((arr) => [...arr, { name: "", command: "", url: "" }]);
  }
  function removeServer(i: number) {
    setMcpServers((arr) => arr.filter((_, idx) => idx !== i));
  }
  async function saveMcp() {
    setSaving(true); setErr(null); setOkMsg(null);
    try {
      // 前端表单字段: name/command/args/prefix/url/timeout (headers/env 只显示已配置标志)
      const servers = mcpServers.map((s) => {
        const out: Record<string, unknown> = { name: s.name };
        if (s.command) out.command = s.command;
        if (s.args && s.args.length) out.args = s.args;
        if (s.prefix) out.prefix = s.prefix;
        if (s.url) out.url = s.url;
        if (s.timeout) out.timeout = s.timeout;
        return out;
      }).filter((s) => s.command || s.url);
      await saveSettings({ mcp: { auto_connect: autoConnect, servers } });
      setOkMsg("MCP 配置已保存, 重启服务后自动连接");
      await refresh();
    } catch (e: unknown) {
      setErr((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[#0f1115] p-8 text-neutral-200">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/" className="field rounded-lg border border-[#2a2e37] px-3 py-1.5 text-[12px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200">← 返回聊天</Link>
          <h1 className="text-lg font-semibold">插件与能力</h1>
        </div>
        <p className="mb-6 text-[13px] text-neutral-500">工具启停即时生效；MCP 配置保存后需重启服务连接。</p>

        {err && <div className="mb-4 rounded-xl border border-red-900/40 border-l-4 border-l-red-500/60 bg-red-950/30 px-4 py-3 text-[13px] text-red-300">⚠️ {err}</div>}
        {okMsg && <div className="mb-4 rounded-xl border border-emerald-900/40 border-l-4 border-l-emerald-500/60 bg-emerald-950/30 px-4 py-3 text-[13px] text-emerald-300">✓ {okMsg}</div>}

        {loading ? (
          <div className="py-8 text-center text-[13px] text-neutral-600">加载中…</div>
        ) : (
          <div className="space-y-6">
            {/* 工具 */}
            <section className="rounded-xl border border-[#26292f] bg-neutral-900/70 p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold">内置工具</h2>
                <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-[11px] text-neutral-400">{tools?.enabled ?? 0} / {tools?.total ?? 0} 启用</span>
              </div>
              <p className="mb-3 text-[11px] text-neutral-600">点击开关启用/禁用工具。禁用后工具不再出现在 LLM 可调用列表且调用被拒。修改即时生效。</p>
              {toolList.length === 0 ? (
                <p className="text-[12px] text-neutral-600">无工具数据 (工具未启用或后端未返回明细)。</p>
              ) : (
                <div className="grid grid-cols-2 gap-1.5">
                  {toolList.map((t) => {
                    const disabled = disabledTools.includes(t.name);
                    const on = t.enabled && !disabled;
                    return (
                      <div key={t.name} className="flex items-center gap-2 rounded-lg bg-neutral-950/50 px-3 py-2">
                        <button
                          onClick={() => toggleTool(t.name, !on)}
                          disabled={saving}
                          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-[#1d5cff]" : "bg-neutral-700"}`}
                          title={on ? `点击禁用 ${t.name}` : `点击启用 ${t.name}`}
                        >
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`}></span>
                        </button>
                        <span className={`truncate text-[12px] ${on ? "text-neutral-300" : "text-neutral-600 line-through"}`}>{t.name}</span>
                        {t.category && <span className="ml-auto shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">{t.category}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* 方法技能 */}
            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold">方法技能</h2>
                <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-[11px] text-neutral-400">{skills.length} 个</span>
              </div>
              {skills.length === 0 ? (
                <p className="text-[12px] text-neutral-600">无方法技能 (skills/ 目录为空或未加载)。</p>
              ) : (
                <div className="space-y-1.5">
                  {skills.map((s) => (
                    <div key={s.id} className="flex items-start gap-2 rounded-lg bg-neutral-950/50 px-3 py-2">
                      <span className="mt-0.5 shrink-0 text-[12px] font-medium text-[#4da3ff]">{s.id}</span>
                      <span className="text-[12px] text-neutral-400">{s.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* MCP 配置 */}
            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold">MCP 服务器</h2>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${mcp?.connected ? "bg-[#0f3d24] text-[#3ddc84]" : "bg-neutral-800 text-neutral-500"}`}>
                  {mcp?.connected ? `已连接 · ${mcp.count ?? 0} 工具` : "未连接"}
                </span>
              </div>
              <p className="mb-4 text-[11px] text-neutral-600">配置 stdio 或 HTTP MCP 服务器。保存后需重启服务生效。</p>

              <div className="mb-4 flex items-center gap-2">
                <input type="checkbox" id="mcp_auto" checked={autoConnect} onChange={(e) => setAutoConnect(e.target.checked)} className="h-4 w-4 accent-[#1d5cff]" />
                <label htmlFor="mcp_auto" className="text-[13px] text-neutral-300">启动时自动连接</label>
              </div>

              {mcpServers.length === 0 ? (
                <p className="mb-3 text-[12px] text-neutral-600">暂无 MCP 服务器。</p>
              ) : (
                <div className="space-y-3">
                  {mcpServers.map((s, i) => (
                    <div key={i} className="rounded-lg bg-neutral-950/50 p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-[12px] font-medium text-[#4da3ff]">#{i + 1}</span>
                        {s.env_set && <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">含环境变量</span>}
                        {s.headers_set && <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">含请求头</span>}
                        <button onClick={() => removeServer(i)} className="ml-auto rounded border border-neutral-800 px-2 py-0.5 text-[11px] text-[#ff6b6b] hover:bg-red-950/30">删除</button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input value={s.name || ""} onChange={(e) => updateServer(i, { name: e.target.value })} placeholder="名称 (可选)" className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[12px] outline-none focus:border-[#1d5cff]" />
                        <input value={s.command || ""} onChange={(e) => updateServer(i, { command: e.target.value })} placeholder="stdio 命令, 如 npx (与 url 二选一)" className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[12px] outline-none focus:border-[#1d5cff]" />
                        <input value={s.url || ""} onChange={(e) => updateServer(i, { url: e.target.value })} placeholder="HTTP URL, 如 https://... (与 command 二选一)" className="col-span-2 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[12px] outline-none focus:border-[#1d5cff]" />
                      </div>
                      {s.command && (
                        <div className="mt-2">
                          <input
                            value={(s.args || []).join(" ")}
                            onChange={(e) => updateServer(i, { args: e.target.value.split(/\s+/).filter(Boolean) })}
                            placeholder="参数 (空格分隔, 如 -y @modelcontextprotocol/server-filesystem)"
                            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[12px] outline-none focus:border-[#1d5cff]"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-4 flex items-center gap-3">
                <button onClick={addServer} className="rounded-lg border border-dashed border-neutral-700 px-4 py-2 text-[12px] text-neutral-300 hover:bg-neutral-800">+ 添加服务器</button>
                <button onClick={saveMcp} disabled={saving} className="rounded-lg bg-[#1d5cff] px-4 py-2 text-[12px] font-medium text-white hover:bg-[#1a4fd8] disabled:opacity-50">{saving ? "保存中…" : "保存 MCP 配置"}</button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
