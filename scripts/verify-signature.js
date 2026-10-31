#!/usr/bin/env node
// scripts/verify-signature.js — 检查 Windows 可执行文件的 Authenticode 签名
//
// 用法:
//   node scripts/verify-signature.js                          # 默认扫 dist-desktop/PPXANS-Harness-Setup-*.exe
//   node scripts/verify-signature.js dist-desktop/Setup.exe
//   node scripts/verify-signature.js dist-desktop --pattern "\\.exe$"
//   node scripts/verify-signature.js --require                # 未签名/签名无效 → 退出码 1
//   node scripts/verify-signature.js --json --out signature.json
//
// 退出码:
//   0  通过 (默认允许未签名; 自签证书仅视为 "未受信任", 不强制失败)
//   1  强制签名 (--require / PPX_REQUIRE_SIGNATURE=1) 但存在未签名/无效文件,
//      或文件缺失、HashMismatch (文件被改动) 等无法验证的情况
//   非 Windows 平台: 报告跳过; 带 --require 时退出码 1。
//
// 只依赖 Windows 自带的 PowerShell + Get-AuthenticodeSignature, 不安装 signtool。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const inputs = [];
let pattern = "";
let out = "";
let json = false;
let requireSignature = process.env.PPX_REQUIRE_SIGNATURE === "1";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--require") requireSignature = true;
  else if (arg === "--json") json = true;
  else if (arg === "--out") out = args[++i] || "";
  else if (arg === "--pattern") pattern = args[++i] || "";
  else if (arg === "--help" || arg === "-h") {
    console.log("用法: node scripts/verify-signature.js [文件或目录...] [--pattern <regex>] [--require] [--json] [--out <文件>]");
    console.log("默认扫描 dist-desktop/PPXANS-Harness-Setup-*.exe。--require: 未签名或签名无效时退出码 1。");
    process.exit(0);
  } else inputs.push(arg);
}
if (!inputs.length) inputs.push("dist-desktop");

const re = pattern ? new RegExp(pattern) : /^PPXANS-Harness-Setup-.*\.exe$/i;
const files = [];
for (const input of inputs) {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) {
    console.error(`[signature] 找不到: ${input}`);
    process.exit(1);
  }
  if (fs.statSync(abs).isDirectory()) {
    for (const name of fs.readdirSync(abs)) {
      const f = path.join(abs, name);
      if (fs.statSync(f).isFile() && re.test(name)) files.push(f);
    }
  } else {
    files.push(abs);
  }
}
files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

if (!files.length) {
  console.log("[signature] 没有匹配的可执行文件, 跳过");
  process.exit(requireSignature ? 1 : 0);
}

if (process.platform !== "win32") {
  console.log("[signature] 非 Windows 平台, 无法读取 Authenticode 签名, 跳过");
  process.exit(requireSignature ? 1 : 0);
}

// 输出 UTF-8, 避免中文系统下 PowerShell 用 GBK 写坏 JSON。
const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$files = ConvertFrom-Json $env:PPX_SIGN_FILES
foreach ($f in @($files)) {
  $item = [ordered]@{
    path = [string]$f
    status = 'Error'
    statusMessage = ''
    signerSubject = $null
    signerThumbprint = $null
    issuer = $null
    timestamped = $false
    timestampSubject = $null
    signatureType = $null
  }
  try {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) {
      $item.status = 'Missing'
      $item.statusMessage = 'file not found'
    } else {
      $sig = Get-AuthenticodeSignature -LiteralPath $f
      $item.status = [string]$sig.Status
      $item.statusMessage = [string]$sig.StatusMessage
      $item.signatureType = [string]$sig.SignatureType
      if ($null -ne $sig.SignerCertificate) {
        $item.signerSubject = [string]$sig.SignerCertificate.Subject
        $item.signerThumbprint = [string]$sig.SignerCertificate.Thumbprint
        $item.issuer = [string]$sig.SignerCertificate.Issuer
      }
      if ($null -ne $sig.TimeStamperCertificate) {
        $item.timestamped = $true
        $item.timestampSubject = [string]$sig.TimeStamperCertificate.Subject
      }
    }
  } catch {
    $item.status = 'Error'
    $item.statusMessage = [string]$_.Exception.Message
  }
  ConvertTo-Json -InputObject $item -Compress -Depth 4
}
`;

const ps = spawnSync(
  "powershell",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
  {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PPX_SIGN_FILES: JSON.stringify(files) },
  },
);

const records = [];
for (const line of `${ps.stdout || ""}`.split(/\r?\n/)) {
  const text = line.trim();
  if (!text.startsWith("{")) continue;
  try {
    records.push(JSON.parse(text));
  } catch {
    // PowerShell 偶发警告行, 忽略
  }
}
if (ps.error || ps.status !== 0 || records.length !== files.length) {
  const detail = `${ps.stderr || ""}`.trim() || `${ps.stdout || ""}`.trim();
  console.error(`[signature] 调用 PowerShell 失败 (exit ${ps.status}): ${detail || ps.error?.message || "无输出"}`);
  process.exit(1);
}

const MISSING = new Set(["Missing", "Error", "UnknownError", "NotSupported", "Incompatible"]);
const summary = {
  total: records.length,
  valid: 0,
  unsigned: 0,
  untrusted: 0,
  broken: 0,
};
for (const r of records) {
  if (r.status === "Valid") summary.valid++;
  else if (r.status === "NotSigned") summary.unsigned++;
  else if (r.status === "NotTrusted") summary.untrusted++;
  else summary.broken++;
}

const statusText = (r) => {
  if (r.status === "Valid") return "有效 (Valid)";
  if (r.status === "NotSigned") return "未签名 (NotSigned)";
  if (r.status === "NotTrusted") return "证书不受信任 (NotTrusted)";
  if (r.status === "HashMismatch") return "签名与文件不匹配 (HashMismatch)";
  if (r.status === "Missing") return "文件缺失 (Missing)";
  return `${r.status || "Error"}${r.statusMessage ? ` — ${r.statusMessage}` : ""}`;
};

const lines = ["Authenticode 签名检查", ""];
for (const r of records) {
  lines.push(`  ${r.path}`);
  lines.push(`    状态   : ${statusText(r)}`);
  if (r.signerSubject) lines.push(`    签名者 : ${r.signerSubject}`);
  if (r.issuer) lines.push(`    颁发者 : ${r.issuer}`);
  if (r.signerThumbprint) lines.push(`    指纹   : ${r.signerThumbprint}`);
  if (r.timestamped) {
    lines.push(`    时间戳 : 有${r.timestampSubject ? ` (${r.timestampSubject})` : ""}`);
  }
  lines.push("");
}
lines.push(`共 ${summary.total} 个文件: 有效 ${summary.valid}, 未签名 ${summary.unsigned}, 不受信任 ${summary.untrusted}, 无效/无法读取 ${summary.broken}`);
if (summary.unsigned || summary.untrusted) {
  lines.push("提示: 未签名安装包首次运行会有 SmartScreen“未知发布者”提示; 签名方案见 docs/SIGNING.md。");
}
if (requireSignature && (summary.valid !== summary.total || summary.total === 0)) {
  lines.push("失败: 已要求签名 (--require / PPX_REQUIRE_SIGNATURE=1), 但并非所有文件签名有效。");
}

const report = json
  ? JSON.stringify({ requireSignature, summary, files: records }, null, 2)
  : lines.join("\n").trimEnd() + "\n";
console.log(report);
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), report, "utf8");
  console.log(`[signature] 报告已写入 ${path.resolve(out)}`);
}

let failed = false;
if (requireSignature && summary.valid !== summary.total) failed = true;
if (records.some((r) => r.status === "HashMismatch" || MISSING.has(r.status))) failed = true;
process.exitCode = failed ? 1 : 0;
