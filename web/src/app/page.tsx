"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listProviders, getSettings, getAuthToken, type Provider } from "../lib/api";

type Msg = { role: "user" | "agent"; content: string };
type Scene = { id: string; name: string; mode: string; description: string; canHelp: string; facts: number; lastUpdated: string };
type Trace = { tool: string; ok: boolean; durationMs: number; args: string };
type Fact = { content: string; score: number; type: string };
type ToolEv = { tool: string; status: "start" | "done"; args?: unknown; ok?: boolean; durationMs?: number };
type Session = { key: string; count: number; lastTs: number; title: string };

const DEFAULT_SESSION = "default";

export default function Home() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyInfo, setBusyInfo] = useState(""); // 推理轮次/工具调用状态提示
  const [tools, setTools] = useState<ToolEv[]>([]); // 本轮工具调用卡片
  const [tab, setTab] = useState<"sessions" | "scenes" | "memory" | "traces" | "stats">("sessions");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [snum, setSnum] = useState(-1);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentKey, setCurrentKey] = useState(DEFAULT_SESSION);
  const [sceneModal, setSceneModal] = useState(false); // 场景新建 modal (替代 prompt)
  const [sceneForm, setSceneForm] = useState({ name: "", desc: "", canHelp: "" });
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView(); }, [msgs, tools]);

  // 带鉴权的相对路径请求 (经 Next.js 代理到内核; /message/* 与 /sessions/* 均已配 rewrites)
  const authedFetch = useCallback((url: string, opts: RequestInit = {}) => {
    const tok = getAuthToken();
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
    return fetch(url, { ...opts, headers });
  }, []);

  // 首启检测: 模型未配 / MCP 未连 时显示对应引导 (可分别关闭)
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [mcpConfigured, setMcpConfigured] = useState(false);
  useEffect(() => {
    listProviders().then((r) => setProviders(r.providers)).catch(() => {});
    // MCP 是否已配置 (settings.mcp.servers 非空)
    getSettings().then((r) => setMcpConfigured((r.settings.mcp?.servers?.length || 0) > 0)).catch(() => {});
  }, []);
  const hasReady = providers.some((p) => p.api_key_set || p.mjs || p.dsh_root);

  // 引导项: 模型未配最优先; 模型已配但 MCP 未配时提示扩展能力
  const guides = [];
  if (!hasReady && !dismissed.includes("model")) {
    guides.push({ key: "model", text: "还没有配置任何模型, 皮皮虾现在无法对话。先去设置 → 模型 连一个模型吧。", link: "/settings/model", btn: "前往配置" });
  } else if (hasReady && !mcpConfigured && !dismissed.includes("mcp")) {
    guides.push({ key: "mcp", text: "未配置 MCP 服务器。在 设置 → 插件与能力 中添加, 扩展 agent 工具能力。", link: "/settings/plugins", btn: "去配置" });
  }
  const activeGuide = guides[0] || null;

  // ---- 会话管理 ----
  async function loadSessions() {
    try {
      const r = await authedFetch("/sessions");
      if (!r.ok) return;
      const j = await r.json();
      setSessions((j.sessions || []).map((s: Session) => s));
    } catch { /* 内核未启动时静默 */ }
  }
  const loadHistory = useCallback(async (key: string) => {
    try {
      const r = await authedFetch("/sessions/" + encodeURIComponent(key) + "/history");
      if (!r.ok) { setMsgs([]); return; }
      const j = await r.json();
      setMsgs((j.messages || []).map((m: Msg) => m));
    } catch { setMsgs([]); }
  }, [authedFetch]);
  async function switchSession(key: string) {
    setCurrentKey(key);
    setTools([]);
    await loadHistory(key);
  }
  async function newSession() {
    const key = "s_" + Date.now().toString(36);
    setCurrentKey(key);
    setMsgs([]);
    setTools([]);
    await loadSessions();
  }
  async function renameSession(key: string) {
    const name = prompt("新会话名称 (将作为 key 前缀)");
    if (!name) return;
    const to = key === DEFAULT_SESSION ? name : (name.replace(/[^\w.-]/g, "_"));
    if (to === key) return;
    try {
      await authedFetch("/sessions/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: key, to }) });
      if (key === currentKey) setCurrentKey(to);
      await loadSessions();
    } catch { /* 目标已存在等错误静默 */ }
  }
  async function deleteSession(key: string) {
    if (!confirm("删除会话「" + (sessions.find((s) => s.key === key)?.title || key) + "」? 该会话历史将不可恢复。")) return;
    try {
      await authedFetch("/sessions/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
      if (key === currentKey) { setCurrentKey(DEFAULT_SESSION); await loadHistory(DEFAULT_SESSION); }
      await loadSessions();
    } catch { /* 静默 */ }
  }

  useEffect(() => { loadSessions(); }, [authedFetch]);

  async function send() {
    const t = input.trim(); if (!t || busy) return;
    setMsgs((m) => [...m, { role: "user", content: t }]);
    setInput(""); setBusy(true); setBusyInfo(""); setTools([]);
    try {
      const r = await authedFetch("/message/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t, sessionId: currentKey }) });
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
      // 占位 agent 消息, delta 往里追加
      setMsgs((m) => [...m, { role: "agent", content: "" }]);
      const updateAgent = (text: string) => setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: "agent", content: text }; return c; });
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", agentText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let ev: any; try { ev = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (ev.type === "delta") { agentText += ev.content || ""; updateAgent(agentText); }
          else if (ev.type === "step") { setBusyInfo(`推理中 · 第 ${(ev.round || 0) + 1}/${ev.maxRounds || 0} 轮`); }
          else if (ev.type === "tool") {
            // 工具调用卡片: start→占位, done→更新状态/耗时/结果
            if (ev.status === "start") { setTools((ts) => [...ts, { tool: ev.tool, status: "start", args: ev.args }]); }
            else { setTools((ts) => [...ts, { tool: ev.tool, status: "done", ok: ev.ok, durationMs: ev.durationMs }]); }
            setBusyInfo(ev.status === "start" ? `调用工具 ${ev.tool}` : `工具完成 ${ev.tool}${ev.durationMs ? " · " + ev.durationMs + "ms" : ""}`);
          }
          else if (ev.type === "done") { if (ev.content && ev.content !== agentText) updateAgent(ev.content); setBusyInfo(""); }
        }
      }
      await loadSessions(); // 会话列表更新 (新会话条目/时间)
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "agent", content: "请求失败: " + e.message }]);
      setBusyInfo("");
    }
    setBusy(false);
  }

  async function loadScene() {
    const r = await authedFetch("/api/memory"); const j = await r.json();
    setScenes(j.scenes || []); setFacts(j.facts || []);
  }
  async function loadTraces() {
    const r = await authedFetch("/api/traces?limit=50"); setTraces(await r.json());
  }
  async function loadStats() {
    const r = await authedFetch("/api/stats"); setStats(await r.json());
  }
  useEffect(() => { loadScene(); }, []);
  useEffect(() => { if (tab === "traces") loadTraces(); if (tab === "stats") loadStats(); }, [tab, snum]);

  // 场景新建: modal 表单 (替代 prompt, 对齐 v0.4.3)
  async function createScene() {
    const { name, desc, canHelp } = sceneForm;
    if (!name || !desc || !canHelp) return;
    try {
      await authedFetch("/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: `用 scene_create 创建场景: 名称=${name}, 介绍=${desc}, 能帮=${canHelp}`, sessionId: currentKey }) });
    } catch { /* 静默 */ }
    setSceneModal(false); setSceneForm({ name: "", desc: "", canHelp: "" });
    loadScene();
  }

  // 工具调用卡片渲染 (本轮)
  function ToolCard({ ev }: { ev: ToolEv }) {
    return (
      <div className="msg-in mb-1.5 flex items-center gap-2 rounded-lg border border-[#26292f] bg-[#181c23] px-3 py-1.5 text-[12px] shadow-sm">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ev.status === "start" ? "animate-pulse bg-[#f0b429]" : ev.ok ? "bg-[#3ddc84]" : "bg-[#ff6b6b]"}`} />
        <span className="font-medium text-neutral-300">{ev.tool}</span>
        {ev.status === "start" ? (
          <span className="text-[#f0b429]">调用中…</span>
        ) : (
          <span className={`rounded px-1.5 text-[10px] ${ev.ok ? "bg-[#0f3d24] text-[#3ddc84]" : "bg-[#3d1d1d] text-[#ff6b6b]"}`}>
            {ev.ok ? "✓ 完成" : "✗ 失败"}{ev.durationMs != null ? ` · ${ev.durationMs}ms` : ""}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#0f1115] text-neutral-200">
      {/* 聊天区 */}
      <main className="flex flex-1 flex-col border-r border-neutral-800">
        <header className="glass sticky top-0 z-10 flex items-center gap-3 border-b border-[#26292f] px-5 py-3.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#28b894] to-[#3b82f6] text-lg font-bold text-white shadow-lg shadow-cyan-500/20">皮</div>
          <div>
            <h1 className="text-sm font-semibold">皮皮虾</h1>
            <p className="text-[11px] text-neutral-500">PPX Agent · 零依赖智能体内核</p>
          </div>
          <span className="ml-auto rounded-full bg-[#1d2a3a] px-2.5 py-0.5 text-[11px] text-[#4da3ff]">
            {currentKey === DEFAULT_SESSION ? "默认会话" : currentKey.slice(0, 16)}
          </span>
          <Link href="/settings/model" className="field rounded-lg border border-[#2a2e37] px-3 py-1.5 text-[12px] text-neutral-300 hover:bg-neutral-800 hover:text-neutral-200">设置</Link>
        </header>
        {activeGuide && (
          <div className="flex items-center gap-3 border-b border-[#5e2b2b] bg-[#2b1616] px-5 py-3 text-[12px] text-[#ffb4b4]">
            <span>⚠️</span>
            <span className="flex-1">{activeGuide.text}</span>
            <Link href={activeGuide.link} className="rounded-lg bg-[#ff6b6b] px-3 py-1 text-[11px] font-medium text-white hover:bg-[#e25555]">{activeGuide.btn}</Link>
            <button onClick={() => setDismissed((d) => [...d, activeGuide.key])} className="text-[11px] text-neutral-500 hover:text-neutral-300" title="稍后再说">✕</button>
          </div>
        )}
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {msgs.length === 0 && tools.length === 0 && <div className="mt-16 text-center">
    <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#28b894]/15 to-[#3b82f6]/15 text-2xl">🦐</div>
    <p className="text-sm text-neutral-500">和皮皮虾聊聊吧</p>
    <p className="mt-1 text-[11px] text-neutral-700">支持工具调用 · 多会话 · 记忆 · 轨迹</p>
  </div>}
          {tools.map((ev, i) => <ToolCard key={i} ev={ev} />)}
          {msgs.map((m, i) => (
            <div key={i} className={`msg-in flex items-start gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "agent" && (
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#28b894] to-[#3b82f6] text-xs font-bold text-white shadow-md shadow-cyan-500/10">虾</div>
              )}
              <div className="max-w-[78%]">
                {m.role === "agent" && <div className="mb-0.5 text-[10px] text-neutral-600">皮皮虾</div>}
                <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${m.role === "user" ? "bg-gradient-to-br from-[#1d5cff] to-[#2563eb] text-white shadow-blue-500/20" : "border border-[#26292f] bg-[#1a1d24]"}`}>{m.content}</div>
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        {busyInfo && <div className="border-t border-neutral-800 px-5 pt-2 text-[12px] text-[#4da3ff]">{busyInfo}</div>}
        <footer className="flex gap-2 border-t border-neutral-800 p-4">
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="输入消息，回车发送" className="field flex-1 rounded-xl border border-[#2a2e37] bg-neutral-900 px-4 py-2.5 text-sm outline-none" />
          <button onClick={send} disabled={busy} className="rounded-xl bg-gradient-to-br from-[#1d5cff] to-[#2563eb] px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 hover:from-[#1b4fd8] hover:to-[#2b6af0] disabled:opacity-40">{busy ? "…" : "发送"}</button>
        </footer>
      </main>

      {/* 右侧面板 */}
      <aside className="flex w-[380px] flex-col">
        <div className="flex border-b border-neutral-800 text-[13px]">
          {(["sessions","scenes","memory","traces","stats"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 py-3 transition-colors hover:text-neutral-200 ${tab === t ? "border-b-2 border-[#4da3ff] bg-[#16202b] text-[#4da3ff]" : "text-neutral-500"}`}>
              {t === "sessions" ? "会话" : t === "scenes" ? "场景" : t === "memory" ? "记忆" : t === "traces" ? "轨迹" : "统计"}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "sessions" && (
            <div>
              <button onClick={newSession} className="mb-3 w-full rounded-xl bg-[#1d5cff] py-2.5 text-sm font-medium text-white hover:bg-[#1a4fd8]">+ 新建会话</button>
              {sessions.map((s) => (
                <div key={s.key} className={`mb-2 rounded-xl border p-3 transition-colors ${s.key === currentKey ? "border-[#4da3ff] bg-[#14202e]" : "border-[#26292f] bg-neutral-900/70 hover:border-[#2f3440]"}`}>
                  <div className="flex items-center gap-2">
                    <button onClick={() => switchSession(s.key)} className="flex-1 truncate text-left text-sm font-medium text-neutral-200 hover:text-[#4da3ff]" title={s.key}>{s.title || s.key}</button>
                    <span className="text-[10px] text-neutral-600">{s.count} 条</span>
                    <button onClick={() => renameSession(s.key)} className="text-[11px] text-neutral-500 hover:text-neutral-300" title="重命名">✎</button>
                    <button onClick={() => deleteSession(s.key)} className="text-[11px] text-neutral-500 hover:text-[#ff6b6b]" title="删除">🗑</button>
                  </div>
                </div>
              ))}
              {sessions.length === 0 && <p className="text-center text-sm text-neutral-600">暂无会话</p>}
            </div>
          )}
          {tab === "scenes" && (
            <div>
              <button onClick={() => setSceneModal(true)} className="mb-3 w-full rounded-xl bg-[#1d5cff] py-2.5 text-sm font-medium text-white hover:bg-[#1a4fd8]">+ 新建场景</button>
              {scenes.map((s) => (
                <div key={s.id} className="mb-3 rounded-xl border border-[#26292f] bg-neutral-900/70 p-3.5 shadow-sm transition-colors hover:border-[#2f3440]">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{s.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${s.mode === "manual" ? "bg-[#0f3d24] text-[#3ddc84]" : "bg-neutral-800 text-neutral-500"}`}>{s.mode === "manual" ? "自定义" : "自动"}</span>
                  </div>
                  {s.description && <p className="mt-2 text-[13px] text-neutral-300">{s.description}</p>}
                  {s.canHelp && <p className="mt-1 text-[13px] text-[#4da3ff]">能帮: {s.canHelp}</p>}
                  <p className="mt-2 text-[11px] text-neutral-600">{s.facts} 条记忆 · 更新 {s.lastUpdated}</p>
                </div>
              ))}
              {scenes.length === 0 && <p className="text-center text-sm text-neutral-600">暂无场景</p>}
            </div>
          )}
          {tab === "memory" && (
            <div>
              {facts.map((f, i) => <div key={i} className="msg-in mb-2 rounded-xl border border-[#26292f] bg-neutral-900/70 p-3 text-[13px]">{f.content}</div>)}
              {facts.length === 0 && <p className="text-center text-sm text-neutral-600">暂无记忆</p>}
            </div>
          )}
          {tab === "traces" && (
            <div>
              {traces.map((t, i) => (
                <div key={i} className="msg-in mb-2 rounded-xl border border-[#26292f] bg-neutral-900/70 p-3">
                  <div className="flex items-center gap-2 text-[13px]"><span className="font-medium">{t.tool}</span><span className={`rounded px-1.5 text-[10px] ${t.ok ? "bg-[#0f3d24] text-[#3ddc84]" : "bg-[#3d1d1d] text-[#ff6b6b]"}`}>{t.ok ? "OK" : "FAIL"}</span><span className="text-neutral-500">{t.durationMs}ms</span></div>
                  <p className="mt-1 truncate text-[11px] text-neutral-600">{t.args}</p>
                </div>
              ))}
              {traces.length === 0 && <p className="text-center text-sm text-neutral-600">暂无轨迹</p>}
            </div>
          )}
          {tab === "stats" && stats && (
            <div>
              <div className="mb-3 rounded-xl border border-neutral-800 bg-neutral-900 p-3.5 text-[13px]">
                调用 {stats.count} 次 · 失败 {stats.failed} · 失败率 <span className={Number(stats.failRate) > 10 ? "text-[#ff6b6b]" : "text-[#3ddc84]"}>{stats.failRate}</span>
              </div>
              <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3.5">
                <p className="mb-2 text-[12px] text-neutral-500">慢工具 Top</p>
                {(stats.slowTools || []).map((s: any, i: number) => <div key={i} className="flex justify-between border-b border-neutral-800 py-1.5 text-[13px] last:border-0"><span>{s.tool}</span><span className="text-[#4da3ff]">{s.avgMs}ms</span></div>)}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* 场景新建 modal (替代 prompt) */}
      {sceneModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setSceneModal(false)}>
          <div className="w-[420px] rounded-2xl border border-neutral-700 bg-[#15181d] p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-sm font-semibold">新建场景</h2>
            <input value={sceneForm.name} onChange={(e) => setSceneForm((f) => ({ ...f, name: e.target.value }))} placeholder="场景名称 (如: A股交易助手)" className="mb-3 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-[#1d5cff]" />
            <input value={sceneForm.desc} onChange={(e) => setSceneForm((f) => ({ ...f, desc: e.target.value }))} placeholder="场景介绍 (这个场景是干嘛的)" className="mb-3 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-[#1d5cff]" />
            <input value={sceneForm.canHelp} onChange={(e) => setSceneForm((f) => ({ ...f, canHelp: e.target.value }))} placeholder="能帮用户干什么 (能力清单)" className="mb-4 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-[#1d5cff]" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setSceneModal(false)} className="rounded-xl border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800">取消</button>
              <button onClick={createScene} disabled={!sceneForm.name || !sceneForm.desc || !sceneForm.canHelp} className="rounded-xl bg-[#1d5cff] px-4 py-2 text-sm font-medium text-white hover:bg-[#1a4fd8] disabled:opacity-50">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
