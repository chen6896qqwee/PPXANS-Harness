# 主题化替换: settings 页面硬编码色 -> CSS 变量 (顺序敏感: 长/带透明度先替换)
$files = @(
  "src\app\settings\layout.tsx",
  "src\app\settings\general\page.tsx",
  "src\app\settings\model\page.tsx",
  "src\app\settings\plugins\page.tsx",
  "src\app\settings\presets\page.tsx"
)
$map = [ordered]@{
  'bg-[#0f1115]'        = 'bg-[var(--ppx-bg)]'
  'bg-[#12151b]'        = 'bg-[var(--ppx-sidebar)]'
  'bg-[#171a21]'        = 'bg-[var(--ppx-panel)]'
  'bg-[#1d2a3a]'        = 'bg-[var(--ppx-badge-bg)]'
  'bg-[#0f3d24]'        = 'bg-[var(--ppx-ok-bg)]'
  'bg-[#3d1d1d]'        = 'bg-[var(--ppx-err-bg)]'
  'bg-[#1d5cff]'        = 'bg-[var(--ppx-accent-deep)]'
  'bg-[#1a4fd8]'        = 'bg-[var(--ppx-accent-hover)]'
  'bg-[#3ddc84]'        = 'bg-[var(--ppx-ok)]'
  'bg-[#ff6b6b]'        = 'bg-[var(--ppx-err)]'
  'text-[#4da3ff]'      = 'text-[var(--ppx-accent)]'
  'text-[#3ddc84]'      = 'text-[var(--ppx-ok)]'
  'text-[#ff6b6b]'      = 'text-[var(--ppx-err)]'
  'focus:border-[#1d5cff]' = 'focus:border-[var(--ppx-accent)]'
  'focus:border-[#4da3ff]' = 'focus:border-[var(--ppx-accent)]'
  'border-[#26292f]'    = 'border-[var(--ppx-border)]'
  'border-[#24272e]'    = 'border-[var(--ppx-border)]'
  'border-[#2a2e37]'    = 'border-[var(--ppx-border-soft)]'
  'bg-neutral-900/60'   = 'bg-[var(--ppx-card-soft)]'
  'bg-neutral-900/70'   = 'bg-[var(--ppx-card-soft)]'
  'bg-neutral-900/80'   = 'bg-[var(--ppx-card-soft)]'
  'bg-neutral-900'      = 'bg-[var(--ppx-card)]'
  'bg-neutral-800'      = 'bg-[var(--ppx-card-2)]'
  'border-neutral-800'  = 'border-[var(--ppx-border)]'
  'border-neutral-700'  = 'border-[var(--ppx-border-soft)]'
  'text-neutral-200'    = 'text-[var(--ppx-text)]'
  'text-neutral-300'    = 'text-[var(--ppx-text-2)]'
  'text-neutral-400'    = 'text-[var(--ppx-text-2)]'
  'text-neutral-500'    = 'text-[var(--ppx-text-3)]'
  'text-neutral-600'    = 'text-[var(--ppx-text-3)]'
  'text-neutral-700'    = 'text-[var(--ppx-text-3)]'
  'hover:bg-neutral-800' = 'hover:bg-[var(--ppx-card-2)]'
  'hover:bg-neutral-700' = 'hover:bg-[var(--ppx-card-2)]'
  'hover:border-neutral-700' = 'hover:border-[var(--ppx-border-soft)]'
  'hover:text-neutral-300' = 'hover:text-[var(--ppx-text-2)]'
  'hover:text-neutral-200' = 'hover:text-[var(--ppx-text)]'
  'bg-black/60'         = 'bg-[var(--ppx-overlay)]'
  'bg-black/70'         = 'bg-[var(--ppx-overlay)]'
}
foreach ($f in $files) {
  $p = Join-Path (Get-Location) $f
  $c = Get-Content $p -Raw -Encoding UTF8
  foreach ($k in $map.Keys) { $c = $c.Replace($k, $map[$k]) }
  Set-Content -Path $p -Value $c -Encoding UTF8 -NoNewline
  Write-Host "done: $f"
}
# 验证残留
Write-Host "---- 残留硬编码 hex (settings) ----"
foreach ($f in $files) {
  $p = Join-Path (Get-Location) $f
  $m = Select-String -Path $p -Pattern '#[0-9a-fA-F]{3,8}' -AllMatches
  if ($m) { Write-Host "$f :"; $m | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line.Trim())" } }
}
Write-Host "---- 完成 ----"
