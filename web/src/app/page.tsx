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
  const [tab, setTab] = useState<"scenes" | "memory" | "traces" | "stats" | "tasks">("scenes");
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
  // ---- Codex 细活: 菜单下拉 / 技能请求 / 开始使用 / 面板开关 ----
  const [openMenu, setOpenMenu] = useState<string | null>(null); // 顶部菜单展开项
  const [skillModal, setSkillModal] = useState(false);
  const [skillForm, setSkillForm] = useState({ name: "", desc: "" });
  const [skillOk, setSkillOk] = useState("");
  const [helpOpen, setHelpOpen] = useState(false); // 开始使用折叠区块
  const [aboutModal, setAboutModal] = useState(false);
  const [guideModal, setGuideModal] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true); // 左侧会话栏
  const [rightOpen, setRightOpen] = useState(true); // 右侧面板
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView(); }, [msgs, tools]);

  // 点击菜单外任意处关闭下拉
  useEffect(() => {
    if (!openMenu) return;
    const onDoc = () => setOpenMenu(null);
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [openMenu]);

  function menuGo() {
    setOpenMenu(null);
  }
  async function copyLastAgent() {
    const last = [...msgs].reverse().find((m) => m.role === "agent" && m.content);
    if (!last) return;
    try { await navigator.clipboard.writeText(last.content); } catch { /* 剪贴板不可用时静默 */ }
  }

  // ---- 全局键盘快捷键 (Codex 桌面版细节) ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      // 输入框里不劫持, 除明确全局的 (Ctrl+K)
      const typing = (e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA";
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault(); inputRef.current?.focus(); return;
      }
      if (typing) return;
      if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newSession(); return; }
      if (e.key === "Escape") {
        setOpenMenu(null); setSkillModal(false); setGuideModal(false); setAboutModal(false);
        setSceneModal(false); setTaskModal(false); setHelpOpen(false); return;
      }
      if (mod && (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4" || e.key === "5")) {
        e.preventDefault();
        const idx = Number(e.key) - 1;
        if (sideTabs[idx]) setTab(sideTabs[idx]);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [msgs]); // msgs 供 copyLastAgent 闭包? 无依赖, 仅空数组即可, 但 newSession/switch 均为函数引用稳定

  async function submitSkill() {
    const name = skillForm.name.trim();
    if (!name) return;
    try {
      await mcpTool("ppx.chat.send", { message: `用 refineSkill 创建技能: 名称=${name}${skillForm.desc.trim() ? ", 描述=" + skillForm.desc.trim() : ""}`, sessionId: currentKey });
      setSkillOk("已提交给 agent 处理");
      setSkillForm({ name: "", desc: "" });
      setTimeout(() => { setSkillOk(""); setSkillModal(false); }, 1200);
    } catch (e: any) {
      setSkillOk("提交失败: " + e.message);
    }
  }

  // 顶部菜单配置 (实用动作 + 快捷键提示)
  const menus: { key: string; label: string; items: { label: string; shortcut?: string; action?: () => void; href?: string }[] }[] = [
    {
      key: "file", label: "文件",
      items: [
        { label: "新对话", shortcut: "⌘N", action: () => { menuGo(); newSession(); } },
        { label: "切换会话…", shortcut: "⌘K", action: () => { menuGo(); document.getElementById("ppx-session-select")?.focus(); } },
        { label: "设置", href: "/settings/model" },
      ],
    },
    {
      key: "edit", label: "编辑",
      items: [
        { label: "清空输入框", action: () => { setInput(""); menuGo(); } },
        { label: "复制最后一条回复", action: () => { copyLastAgent(); menuGo(); } },
      ],
    },
    {
      key: "view", label: "视图",
      items: [
        { label: leftOpen ? "隐藏会话列表" : "显示会话列表", action: () => { setLeftOpen(!leftOpen); menuGo(); } },
        { label: rightOpen ? "隐藏右侧面板" : "显示右侧面板", action: () => { setRightOpen(!rightOpen); menuGo(); } },
        { label: "场景", shortcut: "⌘1", action: () => { setTab("scenes"); menuGo(); } },
        { label: "记忆", shortcut: "⌘2", action: () => { setTab("memory"); menuGo(); } },
        { label: "轨迹", shortcut: "⌘3", action: () => { setTab("traces"); menuGo(); } },
        { label: "统计", shortcut: "⌘4", action: () => { setTab("stats"); menuGo(); } },
        { label: "任务", shortcut: "⌘5", action: () => { setTab("tasks"); menuGo(); } },
      ],
    },
    {
      key: "help", label: "帮助",
      items: [
        { label: "快速开始", action: () => { setGuideModal(true); menuGo(); } },
        { label: "关于皮皮虾", action: () => { setAboutModal(true); menuGo(); } },
      ],
    },
  ];

  // 会话列表在左侧栏, 右侧面板不含 sessions tab
  const sideTabs = ["scenes", "memory", "traces", "stats", "tasks"] as const;

  // Codex 桌面版引导卡片 (点击直接发送)
  const codexHints = [
    { icon: "🛠️", title: "生成代码", desc: "让它帮你写一段新的功能代码", prompt: "帮我生成一段代码：" },
    { icon: "🐞", title: "修复 Bug", desc: "描述问题, 让它定位并修复", prompt: "帮我修复这个 Bug：" },
    { icon: "🧪", title: "写单元测试", desc: "为现有代码补测试用例", prompt: "帮我写单元测试：" },
    { icon: "📖", title: "解释代码", desc: "搞不懂某段逻辑? 问它", prompt: "解释一下这段代码：" },
  ];
  function sendHint(p: string) {
    // 点卡片直接开干 (真 Codex 行为)
    setInput(p);
    send(p);
  }

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

  async function send(text?: string) {
    const t = (text ?? input).trim(); if (!t || busy) return;
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
      <div className="msg-in mb-1.5 flex items-center gap-2 rounded-lg border border-[var(--ppx-border)] bg-[var(--ppx-card-2)] px-3 py-1.5 text-[12px] shadow-sm">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ev.status === "start" ? "animate-pulse bg-[var(--ppx-warn)]" : ev.ok ? "bg-[var(--ppx-ok)]" : "bg-[var(--ppx-err)]"}`} />
        <span className="font-medium text-[var(--ppx-text-2)]">{ev.tool}</span>
        {ev.status === "start" ? (
          <span className="text-[var(--ppx-warn)]">调用中…</span>
        ) : (
          <span className={`rounded px-1.5 text-[10px] ${ev.ok ? "bg-[var(--ppx-ok-bg)] text-[var(--ppx-ok)]" : "bg-[var(--ppx-err-bg)] text-[var(--ppx-err)]"}`}>
            {ev.ok ? "✓ 完成" : "✗ 失败"}{ev.durationMs != null ? ` · ${ev.durationMs}ms` : ""}
          </span>
        )}
      </div>
    );
  }

  // 会话列表项 (左侧栏 / 右侧面板共用)
  function SessionItem({ s }: { s: Session }) {
    const active = s.key === currentKey;
    return (
      <div className={`mb-1.5 rounded-lg border p-2.5 transition-colors ${active ? "border-[var(--ppx-accent)] bg-[var(--ppx-tab-active)]" : "border-transparent hover:border-[var(--ppx-border-soft)] hover:bg-[var(--ppx-card-soft)]"}`}>
        <div className="flex items-center gap-2">
          <button onClick={() => switchSession(s.key)} className="flex-1 truncate text-left text-[13px] font-medium text-[var(--ppx-text)] hover:text-[var(--ppx-accent)]" title={s.key}>{s.title || s.key}</button>
          <span className="text-[10px] text-[var(--ppx-text-3)]">{s.count} 条</span>
          <button onClick={() => renameSession(s.key)} className="text-[11px] text-[var(--ppx-text-3)] hover:text-[var(--ppx-text-2)]" title="重命名">✎</button>
          <button onClick={() => deleteSession(s.key)} className="text-[11px] text-[var(--ppx-text-3)] hover:text-[var(--ppx-err)]" title="删除">🗑</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[var(--ppx-bg)] text-[var(--ppx-text)]">
      {/* 左侧栏 (Codex 桌面版导航 + 会话列表) */}
      {leftOpen && (
      <aside className="flex w-60 flex-col border-r border-[var(--ppx-border)] bg-[var(--ppx-sidebar)]">
          <div className="flex items-center gap-2 px-4 py-4">
            <span className="text-[15px] font-bold">皮皮虾</span>
            <span className="rounded-full bg-[var(--ppx-badge-bg)] px-2 py-0.5 text-[10px] text-[var(--ppx-text-2)]">PPX</span>
          </div>
          <nav className="px-2">
            <button onClick={newSession} className="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]">
              <span className="text-[15px]">＋</span>新对话
            </button>
            <button onClick={() => setSkillModal(true)} className="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]">
              <span className="text-[15px]">✨</span>技能请求
            </button>
            <button onClick={() => setTab("tasks")} className="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]">
              <span className="text-[15px]">🕐</span>已安排
            </button>
            <button onClick={() => setTab("traces")} className="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]">
              <span className="text-[15px]">📜</span>轨迹
            </button>
            <Link href="/settings/plugins" className="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]">
              <span className="text-[15px]">🧩</span>插件
            </Link>
          </nav>
          <p className="mt-4 px-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--ppx-text-3)]">会话</p>
          <div className="mt-1 flex-1 overflow-y-auto px-2 pb-3">
            {sessions.map((s) => <SessionItem key={s.key} s={s} />)}
            {sessions.length === 0 && <p className="px-2 pt-4 text-center text-[12px] text-[var(--ppx-text-3)]">暂无会话</p>}
          </div>
          {/* 开始使用 (Codex 桌面版底部区块) */}
          <div className="border-t border-[var(--ppx-border)]">
            <button
              onClick={() => setHelpOpen(!helpOpen)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-[13px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]"
            >
              <span className={`text-[10px] transition-transform ${helpOpen ? "rotate-90" : ""}`}>▶</span>
              <span>开始使用</span>
            </button>
            {helpOpen && (
              <div className="px-2 pb-3">
                <button onClick={() => { setGuideModal(true); setHelpOpen(false); }} className="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]">
                  <span className="text-[15px]">🚀</span>快速开始
                </button>
                <Link href="/settings/model" onClick={() => setHelpOpen(false)} className="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]">
                  <span className="text-[15px]">⚙️</span>设置
                </Link>
                <button onClick={() => { setAboutModal(true); setHelpOpen(false); }} className="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]">
                  <span className="text-[15px]">ℹ️</span>关于皮皮虾
                </button>
              </div>
            )}
          </div>
        </aside>
      )}

      {/* 聊天区 */}
      <main className="flex flex-1 flex-col border-r border-[var(--ppx-border)]">
        {/* Codex 桌面版菜单栏 (真下拉) */}
        <div className="relative z-20 flex items-center gap-0.5 border-b border-[var(--ppx-border)] bg-[var(--ppx-bg)] px-3 py-1 text-[12px] text-[var(--ppx-text-2)] select-none">
          {menus.map((m) => (
            <div key={m.key} className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === m.key ? null : m.key); }}
                className={`cursor-default rounded px-2.5 py-1 hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)] ${openMenu === m.key ? "bg-[var(--ppx-card-2)] text-[var(--ppx-text)]" : ""}`}
              >
                {m.label}
              </button>
              {openMenu === m.key && (
                <div
                  className="absolute left-0 top-full z-30 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-[var(--ppx-border)] bg-[var(--ppx-panel)] py-1 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  {m.items.map((it, i) =>
                    it.href ? (
                      <Link
                        key={i}
                        href={it.href}
                        onClick={() => menuGo()}
                        className="flex items-center justify-between gap-6 px-3.5 py-1.5 text-[12px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]"
                      >
                        <span>{it.label}</span>
                        {it.shortcut && <span className="text-[10px] text-[var(--ppx-text-3)]">{it.shortcut}</span>}
                      </Link>
                    ) : (
                      <button
                        key={i}
                        onClick={it.action}
                        className="flex w-full items-center justify-between gap-6 px-3.5 py-1.5 text-left text-[12px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]"
                      >
                        <span>{it.label}</span>
                        {it.shortcut && <span className="text-[10px] text-[var(--ppx-text-3)]">{it.shortcut}</span>}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <header className="glass sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--ppx-border)] px-5 py-3.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--ppx-brand-grad)] text-lg font-bold text-white shadow-[0_4px_16px_var(--ppx-shadow)]">皮</div>
          <div>
            <h1 className="text-sm font-semibold">皮皮虾</h1>
            <p className="text-[11px] text-[var(--ppx-text-3)]">PPX Agent · 零依赖智能体内核</p>
          </div>
          <span className="ml-auto rounded-full bg-[var(--ppx-badge-bg)] px-2.5 py-0.5 text-[11px] text-[var(--ppx-accent)]">
            {currentKey === DEFAULT_SESSION ? "默认会话" : currentKey.slice(0, 16)}
          </span>
          <Link href="/settings/model" className="field rounded-lg border border-[var(--ppx-border-soft)] px-3 py-1.5 text-[12px] text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)] hover:text-[var(--ppx-text)]">设置</Link>
        </header>
        {activeGuide && (
          <div className="flex items-center gap-3 border-b border-[var(--ppx-guide-bg)] bg-[var(--ppx-guide-bg)] px-5 py-3 text-[12px] text-[var(--ppx-guide-text)]">
            <span>⚠️</span>
            <span className="flex-1">{activeGuide.text}</span>
            <Link href={activeGuide.link} className="rounded-lg bg-[var(--ppx-err)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90">{activeGuide.btn}</Link>
            <button onClick={() => setDismissed((d) => [...d, activeGuide.key])} className="text-[11px] text-[var(--ppx-text-3)] hover:text-[var(--ppx-text-2)]" title="稍后再说">✕</button>
          </div>
        )}
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {msgs.length === 0 && tools.length === 0 && (
            <div className="mx-auto mt-[8vh] max-w-xl text-center">
              <p className="text-[15px] font-medium text-[var(--ppx-text)]">我们要构建什么?</p>
              <div className="mt-6 grid grid-cols-2 gap-3">
                {codexHints.map((h) => (
                  <button
                    key={h.title}
                    onClick={() => sendHint(h.prompt)}
                    className="rounded-xl border border-[var(--ppx-border)] bg-[var(--ppx-card)] p-4 text-left transition-colors hover:border-[var(--ppx-border-soft)] hover:bg-[var(--ppx-card-soft)]"
                  >
                    <span className="text-lg">{h.icon}</span>
                    <p className="mt-2 text-[13px] font-medium text-[var(--ppx-text)]">{h.title}</p>
                    <p className="mt-0.5 text-[12px] text-[var(--ppx-text-3)]">{h.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
          {tools.map((ev, i) => <ToolCard key={i} ev={ev} />)}
          {msgs.map((m, i) => (
            <div key={i} className={`msg-in flex items-start gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "agent" && (
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--ppx-brand-grad)] text-xs font-bold text-white shadow-md">虾</div>
              )}
              <div className="max-w-[78%]">
                {m.role === "agent" && <div className="mb-0.5 text-[10px] text-[var(--ppx-text-3)]">皮皮虾</div>}
                <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${m.role === "user" ? "bg-[var(--ppx-user-grad)] text-[var(--ppx-user-text)] shadow-[0_4px_14px_var(--ppx-shadow)]" : "border border-[var(--ppx-border)] bg-[var(--ppx-card)]"}`}>{m.content}</div>
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        {busyInfo && <div className="border-t border-[var(--ppx-border)] px-5 pt-2 text-[12px] text-[var(--ppx-accent)]">{busyInfo}</div>}
        <footer className="flex gap-2 border-t border-[var(--ppx-border)] p-4">
          <select
            id="ppx-session-select"
            value={currentKey}
            onChange={(e) => switchSession(e.target.value)}
            title="选择会话"
            className="field w-36 shrink-0 rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-3 py-2.5 text-[12px] text-[var(--ppx-text-2)] outline-none"
          >
            {sessions.map((s) => <option key={s.key} value={s.key}>{s.title || s.key}</option>)}
          </select>
          <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="选择项目或输入消息…" className="field flex-1 rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-4 py-2.5 text-sm outline-none" />
          <button onClick={() => send()} disabled={busy} className="rounded-xl bg-[var(--ppx-accent-deep)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_4px_14px_var(--ppx-shadow)] hover:bg-[var(--ppx-accent-hover)] disabled:opacity-40">{busy ? "…" : "发送"}</button>
        </footer>
      </main>

      {/* 右侧面板 */}
      {rightOpen && (
      <aside className="flex w-[320px] flex-col">
        <div className="flex border-b border-[var(--ppx-border)] text-[13px]">
          {sideTabs.map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 py-3 transition-colors hover:text-[var(--ppx-text)] ${tab === t ? "border-b-2 border-[var(--ppx-accent)] bg-[var(--ppx-tab-active)] text-[var(--ppx-accent)]" : "text-[var(--ppx-text-3)]"}`}>
              {t === "scenes" ? "场景" : t === "memory" ? "记忆" : t === "traces" ? "轨迹" : t === "stats" ? "统计" : "任务"}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "scenes" && (
            <div>
              <button onClick={() => setSceneModal(true)} className="mb-3 w-full rounded-xl bg-[var(--ppx-accent-deep)] py-2.5 text-sm font-medium text-white hover:bg-[var(--ppx-accent-hover)]">+ 新建场景</button>
              {scenes.map((s) => (
                <div key={s.id} className="mb-3 rounded-xl border border-[var(--ppx-border)] bg-[var(--ppx-card-soft)] p-3.5 shadow-sm transition-colors hover:border-[var(--ppx-border-soft)]">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{s.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${s.mode === "manual" ? "bg-[var(--ppx-ok-bg)] text-[var(--ppx-ok)]" : "bg-[var(--ppx-card-2)] text-[var(--ppx-text-3)]"}`}>{s.mode === "manual" ? "自定义" : "自动"}</span>
                  </div>
                  {s.description && <p className="mt-2 text-[13px] text-[var(--ppx-text-2)]">{s.description}</p>}
                  {s.canHelp && <p className="mt-1 text-[13px] text-[var(--ppx-accent)]">能帮: {s.canHelp}</p>}
                  <p className="mt-2 text-[11px] text-[var(--ppx-text-3)]">{s.facts} 条记忆 · 更新 {s.lastUpdated}</p>
                </div>
              ))}
              {scenes.length === 0 && <p className="text-center text-sm text-[var(--ppx-text-3)]">暂无场景</p>}
            </div>
          )}
          {tab === "memory" && (
            <div>
              {facts.map((f, i) => <div key={i} className="msg-in mb-2 rounded-xl border border-[var(--ppx-border)] bg-[var(--ppx-card-soft)] p-3 text-[13px]">{f.content}</div>)}
              {facts.length === 0 && <p className="text-center text-sm text-[var(--ppx-text-3)]">暂无记忆</p>}
            </div>
          )}
          {tab === "traces" && (
            <div>
              {traces.map((t, i) => (
                <div key={i} className="msg-in mb-2 rounded-xl border border-[var(--ppx-border)] bg-[var(--ppx-card-soft)] p-3">
                  <div className="flex items-center gap-2 text-[13px]"><span className="font-medium">{t.tool}</span><span className={`rounded px-1.5 text-[10px] ${t.ok ? "bg-[var(--ppx-ok-bg)] text-[var(--ppx-ok)]" : "bg-[var(--ppx-err-bg)] text-[var(--ppx-err)]"}`}>{t.ok ? "OK" : "FAIL"}</span><span className="text-[var(--ppx-text-3)]">{t.durationMs}ms</span></div>
                  <p className="mt-1 truncate text-[11px] text-[var(--ppx-text-3)]">{t.args}</p>
                </div>
              ))}
              {traces.length === 0 && <p className="text-center text-sm text-[var(--ppx-text-3)]">暂无轨迹</p>}
            </div>
          )}
          {tab === "stats" && stats && (
            <div>
              <div className="mb-3 rounded-xl border border-[var(--ppx-border)] bg-[var(--ppx-card)] p-3.5 text-[13px]">
                调用 {stats.count} 次 · 失败 {stats.failed} · 失败率 <span className={Number(stats.failRate) > 10 ? "text-[var(--ppx-err)]" : "text-[var(--ppx-ok)]"}>{stats.failRate}</span>
              </div>
              <div className="rounded-xl border border-[var(--ppx-border)] bg-[var(--ppx-card)] p-3.5">
                <p className="mb-2 text-[12px] text-[var(--ppx-text-3)]">慢工具 Top</p>
                {(stats.slowTools || []).map((s: any, i: number) => <div key={i} className="flex justify-between border-b border-[var(--ppx-border)] py-1.5 text-[13px] last:border-0"><span>{s.tool}</span><span className="text-[var(--ppx-accent)]">{s.avgMs}ms</span></div>)}
              </div>
            </div>
          )}
          {tab === "tasks" && (
            <div>
              <button onClick={() => setTaskModal(true)} className="mb-3 w-full rounded-xl bg-[var(--ppx-accent-deep)] py-2.5 text-sm font-medium text-white hover:bg-[var(--ppx-accent-hover)]">+ 新建任务</button>
              <div className="mb-3 flex gap-2 text-[11px]">
                <span className="rounded-full bg-[var(--ppx-card-2)] px-2 py-0.5 text-[var(--ppx-text-2)]">进行中 {taskCounts.running}</span>
                <span className="rounded-full bg-[var(--ppx-card-2)] px-2 py-0.5 text-[var(--ppx-text-2)]">待处理 {taskCounts.todo}</span>
                <span className="rounded-full bg-[var(--ppx-ok-bg)] px-2 py-0.5 text-[var(--ppx-ok)]">完成 {taskCounts.done}</span>
                <span className="rounded-full bg-[var(--ppx-err-bg)] px-2 py-0.5 text-[var(--ppx-err)]">失败 {taskCounts.failed}</span>
              </div>
              {tasks.map((t) => (
                <div key={t.id} className="mb-3 rounded-xl border border-[var(--ppx-border)] bg-[var(--ppx-card-soft)] p-3.5 shadow-sm transition-colors hover:border-[var(--ppx-border-soft)]">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${t.status === "running" ? "animate-pulse bg-[var(--ppx-warn)]" : t.status === "done" ? "bg-[var(--ppx-ok)]" : t.status === "failed" ? "bg-[var(--ppx-err)]" : "bg-[var(--ppx-text-3)]"}`} />
                    <span className="flex-1 truncate text-sm font-medium">{t.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${t.status === "running" ? "bg-[var(--ppx-warn-bg)] text-[var(--ppx-warn)]" : t.status === "done" ? "bg-[var(--ppx-ok-bg)] text-[var(--ppx-ok)]" : t.status === "failed" ? "bg-[var(--ppx-err-bg)] text-[var(--ppx-err)]" : "bg-[var(--ppx-card-2)] text-[var(--ppx-text-2)]"}`}>
                      {t.status === "running" ? "进行中" : t.status === "done" ? "已完成" : t.status === "failed" ? "失败" : "待处理"}
                    </span>
                  </div>
                  {t.description && <p className="mt-2 text-[12px] text-[var(--ppx-text-2)]">{t.description}</p>}
                  <ol className="mt-2.5 space-y-1.5">
                    {t.steps.map((s, i) => (
                      <li key={i} className="flex items-start gap-2 text-[12px]">
                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] ${s.status === "done" ? "bg-[var(--ppx-ok-bg)] text-[var(--ppx-ok)]" : s.status === "running" ? "bg-[var(--ppx-warn-bg)] text-[var(--ppx-warn)]" : s.status === "failed" ? "bg-[var(--ppx-err-bg)] text-[var(--ppx-err)]" : "bg-[var(--ppx-card-2)] text-[var(--ppx-text-3)]"}`}>
                          {s.status === "done" ? "✓" : s.status === "failed" ? "✗" : i + 1}
                        </span>
                        <span className={s.status === "done" ? "text-[var(--ppx-text-3)] line-through" : s.status === "running" ? "text-[var(--ppx-warn)]" : "text-[var(--ppx-text-2)]"}>{s.title}</span>
                        {s.detail && <span className="ml-auto truncate text-[10px] text-[var(--ppx-text-3)]">{s.detail}</span>}
                      </li>
                    ))}
                  </ol>
                  {t.result && (
                    <details className="mt-2 rounded-lg border border-[var(--ppx-border)] bg-[var(--ppx-code-bg)] p-2">
                      <summary className="cursor-pointer text-[11px] text-[var(--ppx-text-3)] hover:text-[var(--ppx-text-2)]">结果</summary>
                      <pre className="mt-1.5 whitespace-pre-wrap text-[11px] text-[var(--ppx-text-2)]">{t.result}</pre>
                    </details>
                  )}
                  <div className="mt-2.5 flex gap-2">
                    <button onClick={() => runTask(t.id)} disabled={t.status === "running"} className="rounded-lg bg-[var(--ppx-accent-deep)] px-3 py-1 text-[11px] font-medium text-white hover:bg-[var(--ppx-accent-hover)] disabled:opacity-40">
                      {t.status === "running" ? "运行中…" : "▶ 运行"}
                    </button>
                    <button onClick={() => deleteTask(t.id)} className="rounded-lg border border-[var(--ppx-border-soft)] px-3 py-1 text-[11px] text-[var(--ppx-text-2)] hover:border-[var(--ppx-err)] hover:text-[var(--ppx-err)]">删除</button>
                  </div>
                </div>
              ))}
              {tasks.length === 0 && <p className="text-center text-sm text-[var(--ppx-text-3)]">暂无任务, 点上方新建</p>}
            </div>
          )}
        </div>
      </aside>
      )}

      {/* 技能请求 modal */}
      {skillModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ppx-overlay)]" onClick={() => setSkillModal(false)}>
          <div className="w-[440px] rounded-2xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-panel)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-sm font-semibold">技能请求</h2>
            <p className="mb-4 text-[12px] text-[var(--ppx-text-3)]">告诉皮皮虾你想要的新技能, 提交后 agent 会尝试用 refineSkill 创建</p>
            <input
              value={skillForm.name}
              onChange={(e) => setSkillForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="技能名称 (如: 周报生成器)"
              className="mb-3 w-full rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-4 py-2.5 text-sm outline-none focus:border-[var(--ppx-accent)]"
            />
            <textarea
              value={skillForm.desc}
              onChange={(e) => setSkillForm((f) => ({ ...f, desc: e.target.value }))}
              placeholder="技能描述 (它能干什么, 什么时候用)"
              className="mb-4 h-24 w-full resize-none rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-4 py-2.5 text-sm outline-none focus:border-[var(--ppx-accent)]"
            />
            {skillOk && <p className="mb-3 text-[12px] text-[var(--ppx-ok)]">{skillOk}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setSkillModal(false)} className="rounded-xl border border-[var(--ppx-border-soft)] px-4 py-2 text-sm text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)]">取消</button>
              <button onClick={submitSkill} disabled={!skillForm.name.trim()} className="rounded-xl bg-[var(--ppx-accent-deep)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ppx-accent-hover)] disabled:opacity-50">提交请求</button>
            </div>
          </div>
        </div>
      )}

      {/* 快速开始 modal */}
      {guideModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ppx-overlay)]" onClick={() => setGuideModal(false)}>
          <div className="w-[460px] rounded-2xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-panel)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-sm font-semibold">快速开始</h2>
            <ol className="space-y-3 text-[13px] text-[var(--ppx-text-2)]">
              <li className="flex gap-3"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ppx-card-2)] text-[11px] text-[var(--ppx-text-2)]">1</span>在下方输入框输入消息, 回车发送, 皮皮虾自动调用工具完成任务</li>
              <li className="flex gap-3"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ppx-card-2)] text-[11px] text-[var(--ppx-text-2)]">2</span>左侧「会话」切换/新建对话, 底部下拉也可快速切换</li>
              <li className="flex gap-3"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ppx-card-2)] text-[11px] text-[var(--ppx-text-2)]">3</span>右侧面板查看 场景/记忆/轨迹/统计/任务</li>
              <li className="flex gap-3"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ppx-card-2)] text-[11px] text-[var(--ppx-text-2)]">4</span>「技能请求」提交你想要的新能力, agent 会尝试自动创建</li>
            </ol>
            <div className="mt-5 flex justify-end">
              <button onClick={() => setGuideModal(false)} className="rounded-xl bg-[var(--ppx-accent-deep)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ppx-accent-hover)]">知道了</button>
            </div>
          </div>
        </div>
      )}

      {/* 关于皮皮虾 modal */}
      {aboutModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ppx-overlay)]" onClick={() => setAboutModal(false)}>
          <div className="w-[400px] rounded-2xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-panel)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--ppx-brand-grad)] text-lg font-bold text-white">皮</div>
              <div>
                <h2 className="text-sm font-semibold">皮皮虾 PPX Agent</h2>
                <p className="text-[11px] text-[var(--ppx-text-3)]">PPXANS-Harness · 零依赖智能体内核</p>
              </div>
            </div>
            <ul className="space-y-1.5 rounded-xl border border-[var(--ppx-border)] bg-[var(--ppx-card-soft)] p-3.5 text-[12px] text-[var(--ppx-text-2)]">
              <li>45+ 内置工具 · L0–L4 五层记忆 · 审计哈希链</li>
              <li>MCP 服务端+客户端 · 多模型路由 · 自愈 7/7</li>
              <li>web 壳 v2.6.0 · Codex 桌面版风格界面</li>
            </ul>
            <div className="mt-5 flex justify-end">
              <button onClick={() => setAboutModal(false)} className="rounded-xl border border-[var(--ppx-border-soft)] px-4 py-2 text-sm text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)]">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 场景新建 modal (替代 prompt) */}
      {sceneModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ppx-overlay)]" onClick={() => setSceneModal(false)}>
          <div className="w-[420px] rounded-2xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-panel)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-sm font-semibold">新建场景</h2>
            <input value={sceneForm.name} onChange={(e) => setSceneForm((f) => ({ ...f, name: e.target.value }))} placeholder="场景名称 (如: A股交易助手)" className="mb-3 w-full rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-4 py-2.5 text-sm outline-none focus:border-[var(--ppx-accent)]" />
            <input value={sceneForm.desc} onChange={(e) => setSceneForm((f) => ({ ...f, desc: e.target.value }))} placeholder="场景介绍 (这个场景是干嘛的)" className="mb-3 w-full rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-4 py-2.5 text-sm outline-none focus:border-[var(--ppx-accent)]" />
            <input value={sceneForm.canHelp} onChange={(e) => setSceneForm((f) => ({ ...f, canHelp: e.target.value }))} placeholder="能帮用户干什么 (能力清单)" className="mb-4 w-full rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-4 py-2.5 text-sm outline-none focus:border-[var(--ppx-accent)]" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setSceneModal(false)} className="rounded-xl border border-[var(--ppx-border-soft)] px-4 py-2 text-sm text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)]">取消</button>
              <button onClick={createScene} disabled={!sceneForm.name || !sceneForm.desc || !sceneForm.canHelp} className="rounded-xl bg-[var(--ppx-accent-deep)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ppx-accent-hover)] disabled:opacity-50">创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 任务新建 modal */}
      {taskModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ppx-overlay)]" onClick={() => setTaskModal(false)}>
          <div className="w-[460px] rounded-2xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-panel)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
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
              className="mb-3 w-full rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-4 py-2.5 text-sm outline-none focus:border-[var(--ppx-accent)]"
            >
              <option value="">自定义任务 (手填步骤)</option>
              {taskTemplates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <input value={taskForm.title} onChange={(e) => setTaskForm((f) => ({ ...f, title: e.target.value }))} placeholder="任务标题 (如: 技能/项目合规性评估)" className="mb-3 w-full rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-4 py-2.5 text-sm outline-none focus:border-[var(--ppx-accent)]" />
            <input value={taskForm.desc} onChange={(e) => setTaskForm((f) => ({ ...f, desc: e.target.value }))} placeholder="任务描述 (可选)" className="mb-3 w-full rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-4 py-2.5 text-sm outline-none focus:border-[var(--ppx-accent)]" />
            <textarea value={taskForm.steps} onChange={(e) => setTaskForm((f) => ({ ...f, steps: e.target.value }))} placeholder={"执行步骤 (每行一步, 可选)\n如:\n读取 README 与流程设计说明\n精读 SKILL.md 与全部 references\n检查安装脚本与目录结构规范性"} className="mb-4 h-32 w-full resize-none rounded-xl border border-[var(--ppx-border-soft)] bg-[var(--ppx-input)] px-4 py-2.5 text-sm outline-none focus:border-[var(--ppx-accent)]" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setTaskModal(false)} className="rounded-xl border border-[var(--ppx-border-soft)] px-4 py-2 text-sm text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)]">取消</button>
              <button onClick={createTask} disabled={!taskForm.title.trim()} className="rounded-xl bg-[var(--ppx-accent-deep)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--ppx-accent-hover)] disabled:opacity-50">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
