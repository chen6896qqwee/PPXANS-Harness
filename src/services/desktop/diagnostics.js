// src/services/desktop/diagnostics.js — 桌面端诊断包 (2026-11-03; 2026-11-12 并入 services)
// 目标: 用户遇到问题时能一键导出"足够定位、但不泄漏密钥"的材料。
// 边界: 只收日志/脱敏配置/健康快照/版本信息; 不收会话正文、记忆、审计数据、uploads。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SECRET_KEY_RE = /(api[_-]?key|apikey|secret|token|password|passwd|authorization|cookie|credential|private[_-]?key)/i;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;

// 单行文本脱敏 (日志里常见: sk-xxx / Bearer xxx / api_key=xxx)
export function redactText(text) {
  let s = String(text == null ? "" : text);
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-***");
  s = s.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***");
  s = s.replace(/((?:api[_-]?key|apikey|token|secret|password|passwd|authorization|cookie|credential)\s*["']?\s*[:=]\s*["']?)(?!Bearer\b)([^\s"',}]{4,})/gi, "$1***");
  return s;
}

// 结构化配置脱敏: 命中键名的值整体替换; 其余字符串走 redactText
export function redactValue(value, depth = 0) {
  if (depth > 12) return "[depth-limit]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? "***REDACTED***" : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function readCapped(file, maxBytes) {
  const st = fs.statSync(file);
  if (st.size <= maxBytes) return fs.readFileSync(file, "utf8");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, Math.max(0, st.size - maxBytes));
    return `[truncated: 保留最后 ${maxBytes} 字节 / 共 ${st.size}]\n` + buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function writeJson(outDir, name, value) {
  const file = path.join(outDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

// 收集诊断材料到 outDir; 返回 manifest (文件清单 + 元信息)。
export function collectDiagnostics({
  root,
  userData,
  outDir,
  appVersion = "",
  electronVersion = "",
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.version,
  health = null,
  now = new Date(),
} = {}) {
  if (!outDir) throw new Error("缺少 outDir");
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const add = (file) => { files.push({ file: path.relative(outDir, file), bytes: fs.statSync(file).size }); };

  add(writeJson(outDir, "meta.json", {
    generatedAt: now.toISOString(),
    appVersion, electronVersion, platform, arch, nodeVersion,
    root, userData,
  }));

  if (health != null) add(writeJson(outDir, "health.json", redactValue(health)));

  const cfg = root && path.join(root, "config", "ppx.json");
  if (cfg && fs.existsSync(cfg)) {
    const raw = readCapped(cfg, MAX_CONFIG_BYTES);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 损坏配置原样脱敏留证 */ }
    const target = path.join(outDir, "config", "ppx.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, parsed ? JSON.stringify(redactValue(parsed), null, 2) : redactText(raw));
    add(target);
  }

  const logsDir = userData && path.join(userData, "logs");
  if (logsDir && fs.existsSync(logsDir)) {
    const logs = fs.readdirSync(logsDir)
      .filter((f) => /\.log$/i.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 5);
    for (const { f } of logs) {
      const target = path.join(outDir, "logs", f);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, redactText(readCapped(path.join(logsDir, f), MAX_LOG_BYTES)));
      add(target);
    }
  }

  for (const [name, dir] of [
    [".desktop-seed.json", userData],
    ["update-check.json", userData],
    ["desktop-prefs.json", userData],
    ["window-state.json", userData],
  ]) {
    const src = dir && path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    const target = path.join(outDir, name);
    let text = readCapped(src, MAX_CONFIG_BYTES);
    try { text = JSON.stringify(redactValue(JSON.parse(text)), null, 2); } catch { text = redactText(text); }
    fs.writeFileSync(target, text);
    add(target);
  }

  const readme = path.join(outDir, "README.txt");
  fs.writeFileSync(readme, [
    "PPXANS-Harness 诊断包",
    `生成时间: ${now.toISOString()}`,
    "",
    "内容: 版本/环境信息、health 快照、脱敏后的配置、最近日志。",
    "不包含: 对话正文、记忆、审计链数据、uploads 附件。",
    "密钥类字段已替换为 ***REDACTED*** / ***；日志中的 token 形态也已脱敏。",
    "",
    "反馈时请附: 复现步骤、预期结果、实际结果。",
    "",
  ].join("\n"));
  add(readme);

  const manifest = {
    generatedAt: now.toISOString(),
    appVersion, platform, arch,
    files,
  };
  add(writeJson(outDir, "manifest.json", manifest));
  return { ...manifest, dir: outDir };
}

// 打包目录。Windows 优先用系统 bsdtar (Git Bash 的 GNU tar 会把 "C:" 当成远端主机);
//   Windows 用 bsdtar 的 zip 自动识别 (-a), 其他平台用 tar.gz。
function tarBinary() {
  if (process.platform === "win32") {
    const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(sys)) return sys;
  }
  return "tar";
}

export function archiveDirectory(dir, outFile) {
  const isZip = /\.zip$/i.test(outFile);
  const args = isZip
    ? ["-a", "-c", "-f", outFile, "-C", dir, "."]
    : ["-czf", outFile, "-C", dir, "."];
  const r = spawnSync(tarBinary(), args, { windowsHide: true, encoding: "utf8" });
  if (r.status === 0 && fs.existsSync(outFile)) return { ok: true, file: outFile };
  return { ok: false, error: String((r.stderr || r.error?.message || "tar 打包失败")).slice(0, 300) };
}
