"use client";
// web/src/app/settings/model/page.tsx - 模型设置页面
// 列出 / 添加 / 编辑 / 删除 / 测试连接 提供方
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  listProviders, addProvider, updateProvider, deleteProvider, testProvider,
  type Provider,
} from "../../../lib/api";

type Status = { healthy?: boolean; detail?: string; checking?: boolean };

const PRESETS: Array<Partial<Provider> & { name: string }> = [
  { id: "openai", name: "OpenAI", backend: "http", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY", model: "gpt-4o-mini" },
  { id: "deepseek", name: "DeepSeek", backend: "http", base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
  { id: "dashscope", name: "通义千问", backend: "http", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key_env: "DASHSCOPE_API_KEY", model: "qwen-turbo" },
  { id: "volcengine", name: "火山方舟", backend: "http", base_url: "https://ark.cn-beijing.volces.com/api/v3", api_key_env: "VOLCENGINE_API_KEY", model: "" },
  { id: "qwen-vl", name: "通义千问 视觉", backend: "http", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key_env: "DASHSCOPE_API_KEY", model: "qwen-vl-max", vision: true },
  { id: "lmstudio", name: "LM Studio (本地)", backend: "http", base_url: "http://127.0.0.1:1234/v1", api_key: "lm-studio", model: "" },
];

export default function ModelSettingsPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [editing, setEditing] = useState<Provider | null>(null);
  const [creating, setCreating] = useState<false | "preset" | "custom">(false);

  async function refresh() {
    try {
      const r = await listProviders();
      setProviders(r.providers);
      setDefaultId(r.default_id);
      setErr(null);
    } catch (e: unknown) {
      setErr((e as Error).message || "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function handleTest(p: Provider) {
    setStatus((s) => ({ ...s, [p.id]: { checking: true } }));
    try {
      const r = await testProvider(p.id);
      setStatus((s) => ({ ...s, [p.id]: { healthy: r.healthy, detail: r.detail } }));
    } catch (e: unknown) {
      setStatus((s) => ({ ...s, [p.id]: { healthy: false, detail: (e as Error).message } }));
    }
  }

  async function handleDelete(p: Provider) {
    if (!confirm(`确定删除提供方「${p.id}」？`)) return;
    try { await deleteProvider(p.id); await refresh(); } catch (e: unknown) { alert((e as Error).message); }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[#0f1115] p-8 text-neutral-200">
      <div className="mx-auto w-full max-w-3xl">
        {/* 返回 + 标题 */}
        <div className="mb-6 flex items-center gap-3">
          <Link href="/" className="field rounded-lg border border-[#2a2e37] px-3 py-1.5 text-[12px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200">← 返回聊天</Link>
          <h1 className="text-lg font-semibold">模型</h1>
        </div>
        <p className="mb-6 text-[13px] text-neutral-500">填入各提供方的 API 密钥即可使用其模型。带绿点表示已就绪；红点表示需要配置密钥或端点。</p>

        {err && <div className="mb-4 rounded-xl border border-red-900/40 border-l-4 border-l-red-500/60 bg-red-950/30 px-4 py-3 text-[13px] text-red-300">⚠️ {err}（请确认后端已启动, 或在浏览器控制台通过 localStorage 设置 ppx_auth_token）</div>}

        {/* 提供方列表 */}
        <div className="space-y-3">
          {loading && <div className="text-center text-[13px] text-neutral-600 py-8">加载中…</div>}
          {!loading && providers.length === 0 && (
            <div className="rounded-xl border border-dashed border-neutral-700 bg-neutral-900/30 p-8 text-center text-[13px] text-neutral-500">
              暂无提供方。请使用下方按钮添加。
            </div>
          )}
          {providers.map((p) => {
            const ready = !!p.api_key_set || !!p.mjs || !!p.dsh_root;
            const st = status[p.id];
            return (
              <div key={p.id} className="flex items-center gap-4 rounded-xl border border-[#26292f] bg-neutral-900/70 px-4 py-3.5">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{p.id}</span>
                    <span className={`h-2 w-2 rounded-full ${ready ? "bg-[#3ddc84]" : "bg-[#ff6b6b]"}`} title={ready ? "已就绪" : "未配置"}></span>
                    {p.id === defaultId && <span className="rounded-full bg-[#0f3d24] px-2 py-0.5 text-[10px] text-[#3ddc84]">默认</span>}
                    {p.backend && p.backend !== "http" && <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400">{p.backend}</span>}
                    {p.vision && <span className="rounded-full bg-[#1d2a3a] px-2 py-0.5 text-[10px] text-[#4da3ff]">视觉</span>}
                  </div>
                  <div className="mt-1 text-[11px] text-neutral-600 truncate">
                    {p.base_url ? `${p.base_url} · ${p.model || "(未选模型)"}` : p.mjs ? `openclaw: ${p.mjs}` : p.dsh_root ? `dsh: ${p.dsh_root}` : "(无端点)"}
                    {p.api_key_env && ` · env=${p.api_key_env}`}
                  </div>
                  {st && (
                    <div className={`mt-1 text-[11px] ${st.healthy ? "text-[#3ddc84]" : st.checking ? "text-neutral-500" : "text-[#ff6b6b]"}`}>
                      {st.checking ? "探测中…" : st.healthy ? `✓ ${st.detail}` : `✗ ${st.detail}`}
                    </div>
                  )}
                </div>
                <button onClick={() => handleTest(p)} disabled={st?.checking} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[12px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50">{st?.checking ? "测试中" : "测试连接"}</button>
                <button onClick={() => setEditing(p)} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[12px] text-neutral-300 hover:bg-neutral-800">编辑</button>
                <button onClick={() => handleDelete(p)} className="rounded-lg border border-neutral-800 px-3 py-1.5 text-[12px] text-[#ff6b6b] hover:bg-red-950/30">删除</button>
              </div>
            );
          })}
        </div>

        {/* 添加按钮 */}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button onClick={() => setCreating("preset")} className="rounded-xl border border-dashed border-neutral-700 bg-transparent py-4 text-[13px] text-neutral-300 hover:bg-neutral-900">+ 添加提供方（常用模板）</button>
          <button onClick={() => setCreating("custom")} className="rounded-xl border border-dashed border-neutral-700 bg-transparent py-4 text-[13px] text-neutral-300 hover:bg-neutral-900">+ 添加自定义提供方</button>
        </div>
      </div>

      {(creating || editing) && (
        <ProviderDialog
          initial={editing}
          presetMode={creating === "preset"}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={async () => { setCreating(false); setEditing(null); await refresh(); }}
          presets={PRESETS}
        />
      )}
    </div>
  );
}

// ---- 添加 / 编辑 对话框 ----
function ProviderDialog({
  initial, presetMode, onClose, onSaved, presets,
}: {
  initial: Provider | null;
  presetMode: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  presets: typeof PRESETS;
}) {
  const isEdit = !!initial;
  const [form, setForm] = useState<Partial<Provider>>(initial || (presetMode ? {} : {}));
  const [presetName, setPresetName] = useState<string>(presets[0]?.id || "");
  const [apiKey, setApiKey] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (presetMode && !isEdit) {
      const p = presets.find((x) => x.id === presetName);
      if (p) setForm({ ...p });
    }
  }, [presetMode, presetName, isEdit, presets]);

  function up<K extends keyof Provider>(k: K, v: Provider[K]) { setForm((f) => ({ ...f, [k]: v })); }

  async function save() {
    setErr(null); setSaving(true);
    try {
      // 注入 api_key 字段 (后端不通过 api_key_env 时必须有 api_key)
      const payload = { ...form };
      if (apiKey) payload.api_key = apiKey;
      if (isEdit && initial) {
        await updateProvider(initial.id, payload);
      } else {
        await addProvider(payload);
      }
      await onSaved();
    } catch (e: unknown) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-neutral-800 bg-[#171a21] p-6">
        <h2 className="mb-1 text-base font-semibold">{isEdit ? `编辑提供方 ${initial?.id}` : "添加提供方"}</h2>
        <p className="mb-5 text-[12px] text-neutral-500">{isEdit ? "修改字段后保存, 后端会热重载客户端。" : "填好字段后保存, 后端会热重载客户端。"}</p>

        {!isEdit && presetMode && (
          <div className="mb-4">
            <label className="mb-1.5 block text-[12px] text-neutral-400">模板</label>
            <select value={presetName} onChange={(e) => setPresetName(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff]">
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.base_url}</option>)}
            </select>
          </div>
        )}

        <Field label="提供方 ID（Provider ID）" hint="小写字母开头, 仅含字母/数字/横线/下划线, 2-30 字符">
          <input disabled={isEdit} value={form.id || ""} onChange={(e) => up("id", e.target.value)} placeholder="如 deepseek" className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff] disabled:opacity-50" />
        </Field>

        <Field label="API 地址">
          <input value={form.base_url || ""} onChange={(e) => up("base_url", e.target.value)} placeholder="https://gateway.example/v1" className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff]" />
        </Field>

        <Field label="默认模型" hint="如 gpt-4o-mini / deepseek-chat / qwen-turbo">
          <input value={form.model || ""} onChange={(e) => up("model", e.target.value)} placeholder="gpt-4o-mini" className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff]" />
        </Field>

        <Field label="API 密钥" hint={isEdit ? "留空表示不变; 输入新值覆盖" : "直接填 key, 或留空并在下面设置 api_key_env 让 agent 从环境变量读"}>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff]" />
        </Field>

        <Field label="或环境变量名">
          <input value={form.api_key_env || ""} onChange={(e) => up("api_key_env", e.target.value)} placeholder="OPENAI_API_KEY" className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] outline-none focus:border-[#1d5cff]" />
        </Field>

        <div className="mb-5 flex items-center gap-2">
          <input type="checkbox" id="vision" checked={!!form.vision} onChange={(e) => up("vision", e.target.checked)} className="h-4 w-4 accent-[#1d5cff]" />
          <label htmlFor="vision" className="text-[13px] text-neutral-300">支持视觉（多模态）</label>
        </div>

        {err && <div className="mb-3 rounded-lg border border-red-900/40 border-l-4 border-l-red-500/60 bg-red-950/30 px-3 py-2 text-[12px] text-red-300">⚠️ {err}</div>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="field rounded-lg border border-[#2a2e37] px-4 py-2 text-[13px] text-neutral-300 hover:bg-neutral-800">取消</button>
          <button onClick={save} disabled={saving} className="rounded-lg bg-[#1d5cff] px-4 py-2 text-[13px] font-medium text-white hover:bg-[#1a4fd8] disabled:opacity-50">{saving ? "保存中…" : isEdit ? "保存" : "创建提供方"}</button>
        </div>
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