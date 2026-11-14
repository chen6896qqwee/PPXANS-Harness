// src/tools/desktop.js - 桌面控制 (computer 工具)
// 定位: 让皮皮虾能"看见并操作"宿主桌面 —— 截图、鼠标、键盘、打开程序/文件/网址、窗口切换、剪贴板。
// 实现: 固定动作集, 每个动作由本文件拼参数、调一个内置 PowerShell 脚本完成 (零 npm 依赖)。
//   模型只能选动作 + 填坐标/文本, 不能提交任意脚本 —— 与 run_command 的白名单边界互补。
// 开关: 默认关闭, 需 config.security.computer_control = true 显式开启 (与 code_act 同款 opt-in)。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileP = promisify(execFile);

const ACTIONS = [
  "screens", "screenshot", "move", "click", "drag", "scroll",
  "type", "key", "open", "windows", "activate", "clipboard_get", "clipboard_set",
];

// open 的目标若是解释器/脚本宿主, 等于绕开"只能选动作"的边界, 一律拒绝
const INTERPRETERS = new Set([
  "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe",
  "wscript", "wscript.exe", "cscript", "cscript.exe", "mshta", "mshta.exe",
  "rundll32", "rundll32.exe", "regsvr32", "regsvr32.exe",
  "bash", "bash.exe", "sh", "node", "node.exe", "python", "python.exe", "py",
]);

// 内置脚本 (只经由 -EncodedCommand 传入; 不落盘, 不接受模型提供的代码)
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PPXNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[PPXNative]::SetProcessDPIAware() | Out-Null

$action = $env:PPX_DC_ACTION
$raw = $env:PPX_DC_ARGS
if ([string]::IsNullOrWhiteSpace($raw)) { $a = @{} } else { $a = $raw | ConvertFrom-Json }

function Out-Result($obj) { $obj | ConvertTo-Json -Compress -Depth 6 }
function Num($v, $d) { if ($null -eq $v) { return [int]$d } else { return [int]$v } }

switch ($action) {
  'screens' {
    $list = @()
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
      $list += @{ name = $s.DeviceName; primary = $s.Primary; x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }
    }
    Out-Result @{ ok = $true; screens = $list }
  }
  'screenshot' {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
    $out = [string]$a.path
    $dir = Split-Path -Parent $out
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Out-Result @{ ok = $true; path = $out; x = $vs.Left; y = $vs.Top; width = $vs.Width; height = $vs.Height }
  }
  'move' {
    [PPXNative]::SetCursorPos((Num $a.x 0), (Num $a.y 0)) | Out-Null
    $p = [System.Windows.Forms.Cursor]::Position
    Out-Result @{ ok = $true; x = $p.X; y = $p.Y }
  }
  'click' {
    if ($null -ne $a.x -and $null -ne $a.y) { [PPXNative]::SetCursorPos((Num $a.x 0), (Num $a.y 0)) | Out-Null }
    $down = 0x0002; $up = 0x0004
    if ($a.button -eq 'right') { $down = 0x0008; $up = 0x0010 }
    elseif ($a.button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
    $times = 1
    if ($a.double) { $times = 2 }
    for ($i = 0; $i -lt $times; $i++) {
      [PPXNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
      [PPXNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      if ($times -gt 1) { Start-Sleep -Milliseconds 80 }
    }
    $p = [System.Windows.Forms.Cursor]::Position
    Out-Result @{ ok = $true; x = $p.X; y = $p.Y; button = [string]$a.button; clicks = $times }
  }
  'drag' {
    $x1 = Num $a.from_x 0; $y1 = Num $a.from_y 0; $x2 = Num $a.to_x 0; $y2 = Num $a.to_y 0
    [PPXNative]::SetCursorPos($x1, $y1) | Out-Null
    Start-Sleep -Milliseconds 60
    [PPXNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
      $nx = [int]($x1 + ($x2 - $x1) * $i / $steps)
      $ny = [int]($y1 + ($y2 - $y1) * $i / $steps)
      [PPXNative]::SetCursorPos($nx, $ny) | Out-Null
      Start-Sleep -Milliseconds 25
    }
    [PPXNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Out-Result @{ ok = $true; from = @{ x = $x1; y = $y1 }; to = @{ x = $x2; y = $y2 } }
  }
  'scroll' {
    if ($null -ne $a.x -and $null -ne $a.y) { [PPXNative]::SetCursorPos((Num $a.x 0), (Num $a.y 0)) | Out-Null }
    $delta = Num $a.delta -120
    [PPXNative]::mouse_event(0x0800, 0, 0, $delta, [UIntPtr]::Zero)
    Out-Result @{ ok = $true; delta = $delta }
  }
  'type' {
    $text = [string]$a.text
    Set-Clipboard -Value $text
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Out-Result @{ ok = $true; chars = $text.Length; via = 'clipboard+ctrl-v' }
  }
  'key' {
    $keys = [string]$a.keys
    [System.Windows.Forms.SendKeys]::SendWait($keys)
    Out-Result @{ ok = $true; keys = $keys }
  }
  'open' {
    $target = [string]$a.target
    if ([string]::IsNullOrWhiteSpace($target)) { throw 'target 不能为空' }
    if ($a.arguments) { Start-Process -FilePath $target -ArgumentList ([string]$a.arguments) }
    else { Start-Process -FilePath $target }
    Out-Result @{ ok = $true; target = $target }
  }
  'windows' {
    $list = @()
    foreach ($p in Get-Process | Where-Object { $_.MainWindowTitle } | Sort-Object ProcessName) {
      $list += @{ pid = $p.Id; process = $p.ProcessName; title = $p.MainWindowTitle }
    }
    Out-Result @{ ok = $true; windows = $list }
  }
  'activate' {
    $ws = New-Object -ComObject WScript.Shell
    if ($a.pid) {
      $ok = $ws.AppActivate([int]$a.pid)
      Out-Result @{ ok = [bool]$ok; pid = [int]$a.pid }
    } else {
      $needle = [string]$a.window
      $hit = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like "*$needle*" } | Select-Object -First 1
      if (-not $hit) { Out-Result @{ ok = $false; error = 'window not found' } }
      else {
        $ok = $ws.AppActivate($hit.Id)
        Out-Result @{ ok = [bool]$ok; pid = $hit.Id; title = $hit.MainWindowTitle }
      }
    }
  }
  'clipboard_get' {
    $t = Get-Clipboard -Raw
    if ($null -eq $t) { $t = '' }
    if ($t.Length -gt 4000) { $t = $t.Substring(0, 4000) }
    Out-Result @{ ok = $true; text = $t }
  }
  'clipboard_set' {
    $text = [string]$a.text
    Set-Clipboard -Value $text
    Out-Result @{ ok = $true; chars = $text.Length }
  }
  default { Out-Result @{ ok = $false; error = ('unknown action: ' + $action) } }
}
`;

function encodedScript() {
  return Buffer.from(PS_SCRIPT, "utf16le").toString("base64");
}

function err(msg) {
  return JSON.stringify({ error: msg });
}

function isInterpreter(target) {
  const base = String(target || "").trim().toLowerCase().replace(/^.*[\\/]/, "");
  return INTERPRETERS.has(base);
}

// 动作级参数校验: 只做"能不能执行"的判定, 不替模型纠正意图
function validate(action, args) {
  const n = (v) => Number.isFinite(Number(v));
  if (!ACTIONS.includes(action)) return `未知动作: ${action} (可用: ${ACTIONS.join("/")})`;
  if ((action === "move" || action === "click") && args.x != null && !n(args.x)) return "x 必须是数字";
  if ((action === "move" || action === "click") && args.y != null && !n(args.y)) return "y 必须是数字";
  if (action === "drag" && ![args.from_x, args.from_y, args.to_x, args.to_y].every(n)) return "drag 需要 from_x/from_y/to_x/to_y 四个数字";
  if (action === "scroll" && args.delta != null && !n(args.delta)) return "delta 必须是数字";
  if ((action === "type" || action === "clipboard_set") && typeof args.text !== "string") return "需要 text 字符串";
  if ((action === "type" || action === "clipboard_set") && args.text && args.text.length > 4000) return "text 超过 4000 字符, 请分段";
  if (action === "key" && !args.keys) return "需要 keys (SendKeys 语法, 如 {ENTER} / ^s / %{F4})";
  if (action === "open") {
    if (!args.target) return "需要 target (网址/文件路径/程序名)";
    if (args.arguments && isInterpreter(args.target)) {
      return `拒绝用 open 启动解释器并带参数 (${args.target}): 这是任意脚本执行入口, 请改用 run_command 走白名单/审批`;
    }
  }
  if (action === "activate" && !args.pid && !args.window) return "需要 pid 或 window (标题子串)";
  return null;
}

export function registerDesktopTools(catalog, { rootDir, config } = {}) {
  catalog.register({
    name: "computer",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "system", destructive: true },
    description: "控制宿主桌面 (Windows): 截图/鼠标/键盘/打开程序/窗口/剪贴板。默认关闭, 需 security.computer_control=true。"
      + " 动作: screens(显示器布局) screenshot(全屏截图→PNG路径) move/click/drag/scroll, type(剪贴板粘贴, 支持中文),"
      + " key(SendKeys 组合键), open(打开网址/文件/程序), windows(列出窗口) activate(切窗口) clipboard_get/clipboard_set。"
      + " 盲操作前先 screenshot + read_image 看清屏幕; 点击坐标用截图的虚拟屏坐标。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ACTIONS, description: "要执行的动作" },
        x: { type: "number", description: "屏幕 x 坐标" },
        y: { type: "number", description: "屏幕 y 坐标" },
        from_x: { type: "number", description: "drag 起点 x" },
        from_y: { type: "number", description: "drag 起点 y" },
        to_x: { type: "number", description: "drag 终点 x" },
        to_y: { type: "number", description: "drag 终点 y" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "鼠标键, 默认 left" },
        double: { type: "boolean", description: "click 是否双击" },
        delta: { type: "number", description: "滚轮增量, 负=向下 (默认 -120)" },
        text: { type: "string", description: "type/clipboard_set 的文本" },
        keys: { type: "string", description: "SendKeys 组合键, 如 {ENTER} / ^s / %{F4} / {TAB}" },
        target: { type: "string", description: "open 的目标: http(s) 网址 / 文件路径 / 程序名" },
        arguments: { type: "string", description: "open 时传给程序的参数 (解释器类目标会被拒绝)" },
        pid: { type: "number", description: "activate 的进程号" },
        window: { type: "string", description: "activate 的窗口标题子串" },
      },
      required: ["action"],
    },
    category: "system",
    power: "user",
    execute: async (args, ctx) => {
      const sec = (ctx?.agent?.config && ctx.agent.config.security) || (config && config.security) || {};
      if (!sec.computer_control) {
        return err("computer 未开启: 在 config/ppx.json 的 security 里设置 computer_control: true 后重启。默认关闭, 因为它能代替你点击和输入。");
      }
      if (process.platform !== "win32") return err("computer 目前只支持 Windows (依赖 PowerShell + Win32 API)");
      const action = String(args?.action || "");
      const bad = validate(action, args || {});
      if (bad) return err(bad);
      const payload = { ...(args || {}) };
      delete payload.action;
      let rel = null;
      if (action === "screenshot") {
        const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        rel = path.join("data", "ui-shots", `desktop-${ts}.png`);
        const abs = path.join(rootDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        payload.path = abs;
      }
      const b64 = encodedScript();
      try {
        const { stdout, stderr } = await execFileP("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64,
        ], {
          cwd: rootDir,
          timeout: 20000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, PPX_DC_ACTION: action, PPX_DC_ARGS: JSON.stringify(payload) },
        });
        const text = String(stdout || "").trim();
        if (!text) return err(`脚本无输出${stderr ? `: ${String(stderr).trim()}` : ""}`);
        if (action === "screenshot" && rel) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.ok) {
              parsed.path = rel.replace(/\\/g, "/");
              parsed.abs = parsed.path && path.join(rootDir, rel);
              parsed.hint = "这是虚拟屏坐标原点的全屏截图; 用 read_image 查看, 点击时坐标直接用截图上的像素坐标。";
            }
            return JSON.stringify(parsed);
          } catch { /* 非 JSON 原样返回 */ }
        }
        return text;
      } catch (e) {
        const msg = String(e?.stderr || e?.message || e).trim();
        return err(`桌面动作失败: ${msg.slice(0, 1200)}`);
      }
    },
  });
}
