// src/tools/voice.js - 语音 TTS 工具 (2026-10-03, 开箱即用)
// 平台策略: Windows = SAPI (系统内置, 免安装) / macOS = say / Linux = espeak (需装)。
// 诚实边界: 合成出声依赖本机 TTS 引擎; ASR (语音转文字) 需云厂商 Key, 不在本工具开箱范围。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { info } from "../utils/logger.js";

const pExecFile = promisify(execFile);

// PowerShell 单引号转义: ' → '' (防注入; 文本永远作为参数传入, 不拼 shell 字符串)
export function escapePS(text) {
  return String(text).replace(/'/g, "''");
}

// 平台命令构建 (导出供测试; platform 可注入, 实际执行在 speakText)
export function buildTTSCommand(text, { rate = 0, voice = "" } = {}, platform = os.platform()) {
  if (platform === "win32") {
    const rateN = Math.max(-10, Math.min(10, Math.round(Number(rate) || 0)));
    const voiceLine = voice ? `$s.SelectVoice('${escapePS(voice)}');` : "";
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command",
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voiceLine} $s.Rate = ${rateN}; $s.Speak('${escapePS(text)}')`],
    };
  }
  if (platform === "darwin") {
    return { cmd: "say", args: voice ? ["-v", voice, String(text)] : [String(text)] };
  }
  // linux 及其他
  const rateWpm = Math.max(80, Math.min(300, 175 + Math.round(Number(rate) || 0) * 20));
  return { cmd: "espeak", args: ["-s", String(rateWpm), String(text)] };
}

export async function speakText(text, opts = {}) {
  const { cmd, args } = buildTTSCommand(text, opts);
  try {
    await pExecFile(cmd, args, { timeout: 30000, windowsHide: true });
    return { ok: true, engine: cmd };
  } catch (e) {
    return { ok: false, engine: cmd, error: e.message };
  }
}

export function registerVoiceTools(catalog) {
  catalog.register({
    name: "tts",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "system" },
    description: "文字转语音并朗读 (开箱即用: Windows 用系统内置 SAPI, macOS 用 say, Linux 用 espeak)。适合把结论/提醒读出来。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要朗读的文本 (建议 ≤500 字)" },
        rate: { type: "number", description: "语速 -10~10 (0=正常), 仅 Windows/Linux 生效" },
        voice: { type: "string", description: "指定发音人名称 (可选, 如 Microsoft Huihui)" },
      },
      required: ["text"],
    },
    execute: async (args) => {
      const text = String(args.text || "").slice(0, 2000);
      if (!text.trim()) return JSON.stringify({ error: "text 不能为空" });
      const r = await speakText(text, { rate: args.rate, voice: args.voice });
      info(`[tts] engine=${r.engine} ok=${r.ok}`);
      return JSON.stringify(r.ok
        ? { ok: true, engine: r.engine, chars: text.length }
        : { error: `本机 TTS 引擎不可用 (${r.engine}): ${r.error}。Linux 需安装 espeak; 或配置云 TTS 厂商。` });
    },
  });

  // voice_transcribe (ASR): 语音转文字。云端走 OpenAI 兼容 /audio/transcriptions,
  // 本地 (backend=local) 需外部 whisper 二进制, 零依赖内核不内置 → 诚实提示。
  catalog.register({
    name: "voice_transcribe",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "语音转文字 (ASR): 把音频文件转成文本。需 config.voice.asr 配云端 (base_url + api_key, OpenAI 兼容 /audio/transcriptions 端点); 本地 backend=local 需外部 whisper。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "音频文件路径 (wav/mp3/m4a)" },
        language: { type: "string", description: "识别语言 (可选, 如 zh/en)" },
      },
      required: ["path"],
    },
    execute: async (args, ctx) => {
      const cfg = (ctx && ctx.agent && ctx.agent.config) || {};
      const p = String(args.path || "");
      if (!p) return JSON.stringify({ error: "voice_transcribe: 需要 path" });
      const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
      if (!fs.existsSync(abs)) return JSON.stringify({ error: `音频文件不存在: ${p}` });
      const cloud = resolveVoice(cfg, "asr");
      if (cloud) {
        try {
          const text = await cloudTranscribe(cloud, abs, args.language);
          return JSON.stringify({ ok: true, text, engine: "cloud" });
        } catch (e) {
          return JSON.stringify({ error: `云端 ASR 转写失败: ${e.message}` });
        }
      }
      if (resolveLocalAsr(cfg)) {
        return JSON.stringify({ error: "本地 ASR (backend=local) 需外部 whisper 二进制, 零依赖内核未内置。请改配云端 ASR, 或手动调用 whisper 转写。" });
      }
      return JSON.stringify({ error: "ASR 未配置: 需在 config.voice.asr 设 base_url + api_key (云端 OpenAI 兼容端点), 或 backend=local (需外部 whisper)。" });
    },
  });
}

// 云端 ASR 转写: OpenAI 兼容 /audio/transcriptions (multipart), 零依赖 (Node 原生 fetch/FormData)
// 2026-10-11: export —— Web UI 语音输入端点 (POST /api/voice/transcribe) 直接复用此实现
export async function cloudTranscribe(cfg, absPath, language) {
  const base = String(cfg.base_url || "").replace(/\/+$/, "");
  const url = /\/audio\/transcriptions$/.test(base) ? base : `${base}/audio/transcriptions`;
  const buf = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const mime = ext === ".mp3" ? "audio/mpeg" : ext === ".m4a" || ext === ".mp4" ? "audio/mp4" : "audio/wav";
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), path.basename(absPath));
  form.append("model", cfg.model || "whisper-1");
  if (language) form.append("language", String(language));
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.api_key}` },
    body: form,
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const j = await resp.json();
  return typeof j.text === "string" ? j.text : JSON.stringify(j);
}

/* ======================= 语音服务配置解析 (v3.1) ======================= */
// 两条路: 云端 (base_url + api_key) 与本地 (backend=local)。两条路的判定必须互斥 ——
// backend=local 时一律不走云端解析, 反过来没配 backend 但给了云地址的也不算本地。

/**
 * 解析云端语音服务配置。
 * @param {object} config 完整配置
 * @param {"asr"|"tts"} kind
 * @returns {object|null} 未配置 / backend=local / 缺地址或密钥 → null
 */
export function resolveVoice(config = {}, kind = "asr") {
  const v = (config && config.voice) || {};
  const c = v[kind];
  if (!c || typeof c !== "object") return null;
  if (String(c.backend || "").toLowerCase() === "local") return null; // 本地不走云端解析
  if (!c.base_url || !c.api_key) return null;                          // 云端缺地址/密钥 = 未配置
  return { ...c };
}

/**
 * 解析本地 ASR 配置 (backend=local 时生效)。
 * @returns {object|null} 非本地后端 → null
 */
export function resolveLocalAsr(config = {}) {
  const c = config && config.voice && config.voice.asr;
  if (!c || typeof c !== "object") return null;
  if (String(c.backend || "").toLowerCase() !== "local") return null;
  const out = {
    backend: "local",
    model: String(c.model || "small"),
    defaultLanguage: String(c.language || c.default_language || ""),
  };
  if (c.model_path || c.modelPath) out.modelPath = String(c.model_path || c.modelPath);
  return out;
}

/**
 * 语音能力状态速览 (供诊断/自检): 每项为 "local" (本地后端) / true (云端已配) / false (未配)。
 */
export function voiceStatus(config = {}) {
  const v = (config && config.voice) || {};
  const stateOf = (kind) => {
    const c = v[kind];
    if (!c || typeof c !== "object") return false;
    if (String(c.backend || "").toLowerCase() === "local") return "local";
    return !!(c.base_url && c.api_key);
  };
  return { asr: stateOf("asr"), tts: stateOf("tts") };
}
