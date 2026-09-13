"use client";
// web/src/app/settings/general/page.tsx - 通用设置
// 用户名 / HTTP 端口 / 安全限流 / agent 编排模式
import { useEffect, useState } from "react";
import Link from "next/link";
import { getSettings, saveSettings, type AppSettings } from "../../../lib/api";

export default function GeneralSettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // 表单字段
  const [userName, setUserName] = useState("兄弟");
  const [port, setPort] = useState("8899");
  const [allowAll, setAllowAll] = useState(false);
  const [cmdTimeout, setCmdTimeout] = useState("30000");
  const [mode, setMode] = useState("react");
  const [agentName, setAgentName] = useState("皮皮虾");

  async function refresh() {
    try {
      const r = await getSettings();
      const s = r.settings;
      setSettings(s);
      setUserName(s.user.name);
      setPort(String(s.http.port));
      setAllowAll(s.security.allow_all);
      setCmdTimeout(String(s.security.command_timeout_ms));
      setMode(s.agent.mode);
      setAgentName(s.agent.name);
      setErr(null);
    } catch (e: unknown) {
      setErr((e as Error).message || "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function save() {
    setSaving(true); setErr(null); setOkMsg(null);
    try {
      const patch = {
        user: { name: userName.trim() || "兄弟" },
        http: { port: Number(port) },
        security: { allow_all: allowAll, command_timeout_ms: Number(cmdTimeout) },
        agent: { name: agentName.trim() || "皮皮虾", mode },
      };
      await saveSettings(patch);
      setOkMsg("已保存, 立即生效");
      await refresh();
    } catch (e: unknown) {
      setErr((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[#0f1115] p-8 text-neutral-200">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/" className="field rounded-lg border border-[#2a2e37] px-3 py-1.5 text-[12px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200">← 返回聊天</Link>
          <h1 className="text-lg font-semibold">通用设置</h1>
        </div>
        <p className="mb-6 text-[13px] text-neutral-500">修改后保存, 后端会热重载, 无需重启。设置写入 config/ppx.json。</p>

        {err && <div className="mb-4 rounded-xl border border-red-900/40 border-l-4 border-l-red-500/60 bg-red-950/30 px-4 py-3 text-[13px] text-red-300">⚠️ {err}</div>}
        {okMsg && <div className="mb-4 rounded-xl border border-emerald-900/40 border-l-4 border-l-emerald-500/60 bg-emerald-950/30 px-4 py-3 text-[13px] text-emerald-300">✓ {okMsg}</div>}

        {loading ? (
          <div className="py-8 text-center text-[13px] text-neutral-600">加载中…</div>
        ) : (
          <div className="space-y-6">
            {/* 用户 */}
            <section className="rounded-xl border border-[#26292f] bg-neutral-900/70 p-5 shadow-sm">
              <h2 className="mb-4 text-sm font-semibold">用户</h2>
              <Field label="对用户的称呼" hint="对话时 agent 怎么称呼你, 默认「兄弟」">
                <input value={userName} onChange={(e) => setUserName(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff]" />
              </Field>
            </section>

            {/* HTTP 服务 */}
            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
              <h2 className="mb-4 text-sm font-semibold">HTTP 服务</h2>
              <Field label="端口" hint="HTTP API 监听端口, 默认 8899 (1-65535)">
                <input type="number" value={port} onChange={(e) => setPort(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff]" />
              </Field>
              <div className="text-[12px] text-neutral-600">认证 Token: {settings?.http.auth_token_set ? "已配置 (不显示明文)" : "未配置 (启动时自动生成)"}</div>
            </section>

            {/* 安全 */}
            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
              <h2 className="mb-4 text-sm font-semibold">安全</h2>
              <div className="mb-4 flex items-center gap-2">
                <input type="checkbox" id="allow_all" checked={allowAll} onChange={(e) => setAllowAll(e.target.checked)} className="h-4 w-4 accent-[#1d5cff]" />
                <label htmlFor="allow_all" className="text-[13px] text-neutral-300">允许任意命令 (allow_all)</label>
              </div>
              <p className="mb-3 text-[11px] text-neutral-600">硬黑名单 (rm -rf /、fork bomb、curl|sh 等) 即使开启也拦截。关闭时仅放行白名单前缀命令。</p>
              <Field label="命令超时 (ms)" hint="run_command 最大执行时长, 默认 30000">
                <input type="number" value={cmdTimeout} onChange={(e) => setCmdTimeout(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff]" />
              </Field>
            </section>

            {/* Agent */}
            <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
              <h2 className="mb-4 text-sm font-semibold">Agent</h2>
              <div className="grid grid-cols-2 gap-4">
                <Field label="名称">
                  <input value={agentName} onChange={(e) => setAgentName(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff]" />
                </Field>
                <Field label="编排模式">
                  <select value={mode} onChange={(e) => setMode(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff]">
                    <option value="react">react (工具循环)</option>
                    <option value="single">single (单轮)</option>
                    <option value="plan-exec">plan-exec (计划执行)</option>
                    <option value="router">router (路由)</option>
                    <option value="blackboard">blackboard (黑板)</option>
                    <option value="graph">graph (图)</option>
                    <option value="legion">legion (军团)</option>
                  </select>
                </Field>
              </div>
            </section>

            <div className="flex justify-end">
              <button onClick={save} disabled={saving} className="rounded-lg bg-[#1d5cff] px-6 py-2.5 text-[13px] font-medium text-white hover:bg-[#1a4fd8] disabled:opacity-50">{saving ? "保存中…" : "保存设置"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3.5">
      <label className="mb-1.5 block text-[12px] text-neutral-400">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-neutral-600">{hint}</p>}
    </div>
  );
}
