"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getApiBase, getAuthToken } from "../lib/api";
import { mcpTool, mcpResource } from "../lib/mcp";

type Msg = { role: "user" | "agent"; content: string };
type Scene = { id: string; name: string; mode: string; description: string; canHelp: string; facts: number; lastUpdated: string };
type Trace = { tool: string; ok: boolean; durationMs: number; args: string };
type Fact = { content: string; score: number; type: string };
type ToolEv = { tool: string; status: "start" | "done"; args?: unknown; ok?: boolean; durationMs?: number };
type Session = { key: string; count: number; lastTs: number; title: string };
type Provider = { id: string; base_url?: string; model?: string; vision?: boolean; api_key_set?: boolean; mjs?: string; dsh_root?: string };
type TaskStep = { title: string; status: "pending" | "running" | "done" | "failed"; detail?: string };
type Task = { id: string; title: string; description: string; status: "todo" | "running" | "done" | "failed"; steps: TaskStep[]; result?: string; createdAt: number; updatedAt: number };
type TaskList = { tasks: Task[]; counts: { todo: number; running: number; done: number; failed: number } };

const DEFAULT_SESSION = "default";

export default function Home() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyInfo, setBusyInfo] = useState(""); // 推理轮次/工具调用状态提示
  const [tools, setTools] = useState<ToolEv[]>([]); // 本轮工具调用卡片
  const [tab, setTab] = useState<"sessions" | "scenes" | "memory" | "traces" | "stats" | "tasks">("sessions");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskCounts, setTaskCounts] = useState({ todo: 0, running: 0, done: 0, failed: 0 });
  const [taskModal, setTaskModal] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: "", desc: "", steps: "", templateId: "" });
  const [taskTemplates, setTaskTemplates] = useState<{ id: string; label: string; steps: string[] }[]>([]);
  const [snum, setSnum] = useState(-1);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentKey, setCurrentKey] = useState(DEFAULT_SESSION);
  const [sceneModal, setSceneModal] = useState(false); // 场景新建 modal (替代 prompt)
  const [sceneForm, setSceneForm] = useState({ name: "", desc: "", canHelp: "" });
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView(); }, [msgs, tools]);

  // 首启检测: 模型未配 / MCP 未连 时显示对应引导 (可分别关闭)
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [mcpConfigured, setMcpConfigured] = useState(false);
  useEffect(() => {
    // v2.6.0: 全部走 MCP 协议 (替代旧 REST /api/*)
    mcpTool<any>("ppx.providers.list").then((r) => setProviders(r.providers || [])).catch(() => {});
    mcpTool<any>("ppx.settings.get").then((r) => setMcpConfigured((r.settings?.mcp?.servers?.length || 0) > 0)).catch(() => {});
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

  // ---- 会话管理 (MCP) ----
  async function loadSessions() {
    try {
      const j = await mcpTool<Session[]>("ppx.sessions.list");
      setSessions(j || []);
    } catch { /* 内核未启动时静默 */ }
  }
  const loadHistory = useCallback(async (key: string) => {
    try {
      const j = await mcpTool<Msg[]>("ppx.sessions.history", { key });
      setMsgs(j || []);
    } catch { setMsgs([]); }
  }, []);
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
      await mcpTool("ppx.sessions.rename", { from: key, to });
      if (key === currentKey) setCurrentKey(to);
      await loadSessions();
    } catch { /* 目标已存在等错误静默 */ }
  }
  async function deleteSession(key: string) {
    if (!confirm("删除会话「" + (sessions.find((s) => s.key === key)?.title || key) + "」? 该会话历史将不可恢复。")) return;
    try {
      await mcpTool("ppx.sessions.delete", { key });
      if (key === currentKey) { setCurrentKey(DEFAULT_SESSION); await loadHistory(DEFAULT_SESSION); }
      await loadSessions();
    } catch { /* 静默 */ }
  }

  useEffect(() => { loadSessions(); }, []);

  async function send() {
    const t = input.trim(); if (!t || busy) return;
    setMsgs((m) => [...m, { role: "user", content: t }]);
    setInput(""); setBusy(true); setBusyInfo(""); setTools([]);
    // 占位 agent 消息, delta 往里追加 (打字机效果)
    setMsgs((m) => [...m, { role: "agent", content: "" }]);
    const updateAgent = (text: string) => setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: "agent", content: text }; return c; });
    try {
      // v2.6.0: 对话走 MCP 工具 ppx.chat.stream — SSE 流式: progress 通知承载 delta, message 通知承载工具/轮次事件
      const base = getApiBase();
      const tok = getAuthToken();
      const body = JSON.stringify({
        jsonrpc: "2.0", id: Date.now(), method: "tools/call",
        params: {
          name: "ppx.chat.stream", arguments: { message: t, sessionId: currentKey },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "ppx-web", version: "2.6.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      });
      const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "text/event-stream, application/json", "MCP-Protocol-Version": "2026-07-28" };
      if (tok) headers["Authorization"] = `Bearer ${tok}`;
      const r = await fetch(base + "/mcp", { method: "POST", headers, body });
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
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
          // progress 通知 -> delta 文本
          if (ev.method === "notifications/progress") {
            const m = ev.params?.message;
            if (typeof m === "string") { agentText += m; updateAgent(agentText); }
          }
          // message 通知 -> 结构化工具/轮次事件 (data 为对象时)
          else if (ev.method === "notifications/message") {
            const d = ev.params?.data;
            if (d && typeof d === "object") {
              if (d.type === "tool") {
                if (d.status === "start") { setTools((ts) => [...ts, { tool: d.tool, status: "start", args: d.args }]); }
                else { setTools((ts) => [...ts, { tool: d.tool, status: "done", ok: d.ok, durationMs: d.durationMs }]); }
                setBusyInfo(d.status === "start" ? `调用工具 ${d.tool}` : `工具完成 ${d.tool}${d.durationMs ? " · " + d.durationMs + "ms" : ""}`);
              } else if (d.type === "step") {
                setBusyInfo(`推理中 · 第 ${(d.round || 0) + 1}/${d.maxRounds || 0} 轮`);
              }
            }
          }
          // 最终 JSON-RPC 响应
          else if (ev.id != null && ev.result) {
            const text = (ev.result.content || []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
            if (text && text !== agentText) { agentText = text; updateAgent(agentText); }
            setBusyInfo("");
          }
          else if (ev.error) { throw new Error(ev.error.message || "MCP 错误"); }
        }
      }
      await loadSessions(); // 会话列表更新
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "agent", content: "请求失败: " + e.message }]);
      setBusyInfo("");
    }
    setBusy(false);
  }

  async function loadScene() {
    const j = await mcpResource("memory://scenes");
    setScenes(Array.isArray(j) ? j : []);
    const f = await mcpResource("memory://facts");
    setFacts(Array.isArray(f) ? f : []);
  }
  async function loadTraces() {
    const j = await mcpResource("traces://recent");
    setTraces(Array.isArray(j) ? j : []);
  }
  async function loadStats() {
    const j = await mcpResource("stats://overview");
    setStats(j || null);
  }
  async function loadTasks() {
    try {
      const j = await mcpTool<TaskList>("ppx.task.list");
      setTasks(j.tasks || []);
      setTaskCounts(j.counts || { todo: 0, running: 0, done: 0, failed: 0 });
    } catch { /* 内核未启动时静默 */ }
  }
  useEffect(() => { loadScene(); }, []);
  useEffect(() => { if (tab === "traces") loadTraces(); if (tab === "stats") loadStats(); if (tab === "tasks") loadTasks(); }, [tab, snum]);

  // 场景新建: modal 表单 (替代 prompt, 对齐 v0.4.3)
  async function createScene() {
    const { name, desc, canHelp } = sceneForm;
    if (!name || !desc || !canHelp) return;
    try {
      await mcpTool("ppx.chat.send", { message: `用 scene_create 创建场景: 名称=${name}, 介绍=${desc}, 能帮=${canHelp}`, sessionId: currentKey });
    } catch { /* 静默 */ }
    setSceneModal(false); setSceneForm({ name: "", desc: "", canHelp: "" });
    loadScene();
  }

  // ---- 任务面板 (MCP ppx.task.*) ----
  useEffect(() => {
    mcpTool<any>("ppx.task.templates").then((r) => setTaskTemplates(Array.isArray(r) ? r : [])).catch(() => {});
  }, []);
  async function createTask() {
    const { title, desc, steps, templateId } = taskForm;
    if (!title.trim()) return;
    try {
      const stepArr = steps.split(/\n/).map((s) => s.trim()).filter(Boolean);
      const args: Record<string, unknown> = { title: title.trim(), description: desc.trim() };
      if (templateId) args.template_id = templateId;
      else if (stepArr.length) args.steps = stepArr;
      await mcpTool("ppx.task.create", args);
    } catch (e: any) { alert("创建任务失败: " + e.message); }
    setTaskModal(false); setTaskForm({ title: "", desc: "", steps: "", templateId: "" });
    loadTasks();
  }
  async function runTask(id: string) {
    try {
      await mcpTool("ppx.task.run", { id });
    } catch (e: any) { alert("运行任务失败: " + e.message); }
    loadTasks();
  }
  async function deleteTask(id: string) {
    if (!confirm("删除任务?")) return;
    try { await mcpTool("ppx.task.delete", { id }); } catch { /* 静默 */ }
    loadTasks();
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
          {(["sessions","scenes","memory","traces","stats","tasks"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 py-3 transition-colors hover:text-neutral-200 ${tab === t ? "border-b-2 border-[#4da3ff] bg-[#16202b] text-[#4da3ff]" : "text-neutral-500"}`}>
              {t === "sessions" ? "会话" : t === "scenes" ? "场景" : t === "memory" ? "记忆" : t === "traces" ? "轨迹" : t === "stats" ? "统计" : "任务"}
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
          {tab === "tasks" && (
            <div>
              <button onClick={() => setTaskModal(true)} className="mb-3 w-full rounded-xl bg-[#1d5cff] py-2.5 text-sm font-medium text-white hover:bg-[#1a4fd8]">+ 新建任务</button>
              <div className="mb-3 flex gap-2 text-[11px]">
                <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-neutral-400">进行中 {taskCounts.running}</span>
                <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-neutral-400">待处理 {taskCounts.todo}</span>
                <span className="rounded-full bg-[#0f3d24] px-2 py-0.5 text-[#3ddc84]">完成 {taskCounts.done}</span>
                <span className="rounded-full bg-[#3d1d1d] px-2 py-0.5 text-[#ff6b6b]">失败 {taskCounts.failed}</span>
              </div>
              {tasks.map((t) => (
                <div key={t.id} className="mb-3 rounded-xl border border-[#26292f] bg-neutral-900/70 p-3.5 shadow-sm transition-colors hover:border-[#2f3440]">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${t.status === "running" ? "animate-pulse bg-[#f0b429]" : t.status === "done" ? "bg-[#3ddc84]" : t.status === "failed" ? "bg-[#ff6b6b]" : "bg-neutral-600"}`} />
                    <span className="flex-1 truncate text-sm font-medium">{t.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${t.status === "running" ? "bg-[#3d2f1d] text-[#f0b429]" : t.status === "done" ? "bg-[#0f3d24] text-[#3ddc84]" : t.status === "failed" ? "bg-[#3d1d1d] text-[#ff6b6b]" : "bg-neutral-800 text-neutral-400"}`}>
                      {t.status === "running" ? "进行中" : t.status === "done" ? "已完成" : t.status === "failed" ? "失败" : "待处理"}
                    </span>
                  </div>
                  {t.description && <p className="mt-2 text-[12px] text-neutral-400">{t.description}</p>}
                  <ol className="mt-2.5 space-y-1.5">
                    {t.steps.map((s, i) => (
                      <li key={i} className="flex items-start gap-2 text-[12px]">
                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] ${s.status === "done" ? "bg-[#0f3d24] text-[#3ddc84]" : s.status === "running" ? "bg-[#3d2f1d] text-[#f0b429]" : s.status === "failed" ? "bg-[#3d1d1d] text-[#ff6b6b]" : "bg-neutral-800 text-neutral-500"}`}>
                          {s.status === "done" ? "✓" : s.status === "failed" ? "✗" : i + 1}
                        </span>
                        <span className={s.status === "done" ? "text-neutral-500 line-through" : s.status === "running" ? "text-[#f0b429]" : "text-neutral-300"}>{s.title}</span>
                        {s.detail && <span className="ml-auto truncate text-[10px] text-neutral-600">{s.detail}</span>}
                      </li>
                    ))}
                  </ol>
                  {t.result && (
                    <details className="mt-2 rounded-lg border border-neutral-800 bg-[#12151a] p-2">
                      <summary className="cursor-pointer text-[11px] text-neutral-500 hover:text-neutral-300">结果</summary>
                      <pre className="mt-1.5 whitespace-pre-wrap text-[11px] text-neutral-400">{t.result}</pre>
                    </details>
                  )}
                  <div className="mt-2.5 flex gap-2">
                    <button onClick={() => runTask(t.id)} disabled={t.status === "running"} className="rounded-lg bg-[#1d5cff] px-3 py-1 text-[11px] font-medium text-white hover:bg-[#1a4fd8] disabled:opacity-40">
                      {t.status === "running" ? "运行中…" : "▶ 运行"}
                    </button>
                    <button onClick={() => deleteTask(t.id)} className="rounded-lg border border-neutral-700 px-3 py-1 text-[11px] text-neutral-400 hover:border-[#ff6b6b] hover:text-[#ff6b6b]">删除</button>
                  </div>
                </div>
              ))}
              {tasks.length === 0 && <p className="text-center text-sm text-neutral-600">暂无任务, 点上方新建</p>}
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

      {/* 任务新建 modal */}
      {taskModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setTaskModal(false)}>
          <div className="w-[460px] rounded-2xl border border-neutral-700 bg-[#15181d] p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-sm font-semibold">新建任务</h2>
            <select
              value={taskForm.templateId}
              onChange={(e) => {
                const tpl = taskTemplates.find((t) => t.id === e.target.value);
                setTaskForm((f) => ({
                  ...f,
                  templateId: e.target.value,
                  // 选模板自动填充标题/步骤 (可再改)
                  title: tpl ? tpl.label.split(" (")[0] : f.title,
                  steps: tpl ? tpl.steps.join("\n") : f.steps,
                }));
              }}
              className="mb-3 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-[#1d5cff]"
            >
              <option value="">自定义任务 (手填步骤)</option>
              {taskTemplates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <input value={taskForm.title} onChange={(e) => setTaskForm((f) => ({ ...f, title: e.target.value }))} placeholder="任务标题 (如: 技能/项目合规性评估)" className="mb-3 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-[#1d5cff]" />
            <input value={taskForm.desc} onChange={(e) => setTaskForm((f) => ({ ...f, desc: e.target.value }))} placeholder="任务描述 (可选)" className="mb-3 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-[#1d5cff]" />
            <textarea value={taskForm.steps} onChange={(e) => setTaskForm((f) => ({ ...f, steps: e.target.value }))} placeholder={"执行步骤 (每行一步, 可选)\n如:\n读取 README 与流程设计说明\n精读 SKILL.md 与全部 references\n检查安装脚本与目录结构规范性"} className="mb-4 h-32 w-full resize-none rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-[#1d5cff]" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setTaskModal(false)} className="rounded-xl border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800">取消</button>
              <button onClick={createTask} disabled={!taskForm.title.trim()} className="rounded-xl bg-[#1d5cff] px-4 py-2 text-sm font-medium text-white hover:bg-[#1a4fd8] disabled:opacity-50">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
