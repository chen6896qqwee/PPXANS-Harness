"use client";
// web/src/app/settings/layout.tsx - 设置页布局 (左侧子导航)
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/settings/model", label: "模型" },
  { href: "/settings/general", label: "通用设置" },
  { href: "/settings/plugins", label: "插件与能力" },
  { href: "/settings/presets", label: "智能体预设" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="flex h-screen bg-[var(--ppx-bg)] text-[var(--ppx-text)]">
      <aside className="flex w-56 flex-col border-r border-[var(--ppx-border)] bg-[var(--ppx-sidebar)] p-4">
        <Link href="/" className="mb-6 flex items-center gap-2 text-[13px] text-[var(--ppx-text-2)] transition-colors hover:text-[var(--ppx-text)]">
          ← 返回聊天
        </Link>
        <nav className="space-y-1">
          {TABS.map((t) => {
            const active = path === t.href || (t.href === "/settings/model" && path?.startsWith("/settings/model"));
            return (
              <Link key={t.href} href={t.href} className={`block rounded-lg px-3 py-2 text-[13px] transition-colors ${active ? "bg-[var(--ppx-tab-active)] text-[var(--ppx-accent)]" : "text-[var(--ppx-text-2)] hover:bg-[var(--ppx-card-2)]/60 hover:text-[var(--ppx-text)]"}`}>
                {t.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto rounded-lg border border-[var(--ppx-border)] bg-[var(--ppx-card-soft)] p-3 text-[11px] text-[var(--ppx-text-3)] leading-relaxed">
          设置仅作用于本机 <code className="rounded bg-[var(--ppx-badge-bg)]/60 px-1.5 py-0.5 text-[var(--ppx-accent)]">config/ppx.json</code>, 改动即热重载, 无需重启。
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}