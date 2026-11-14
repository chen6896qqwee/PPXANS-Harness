// src/tools/voice.js - 语音工具 (TTS + ASR)
// TTS 平台策略: Windows = SAPI (系统内置, 免安装) / macOS = say / Linux = espeak (需装)。
// ASR 双路 (2026-11-14 补全本地兜底): 云端走 OpenAI 兼容 /audio/transcriptions;
//   本地 backend=local + bin 走外部 whisper 二进制 (openai-whisper CLI / whisper.cpp),
//   零依赖内核不内置二进制 —— 缺失时诚实报错并给配置指引, 不编结果。
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
  // 本地 backend=local + bin 走外部 whisper 二进制 (openai-whisper / whisper.cpp)。
  catalog.register({
    name: "voice_transcribe",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "语音转文字 (ASR): 把音频文件转成文本。云端: config.voice.asr 配 base_url + api_key (OpenAI 兼容端点); 本地: backend=local + bin 指向外部 whisper 二进制 (openai-whisper / whisper.cpp)。可选 voice.asr_fallback 兜底块: 主路失败自动切换。",
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
      try {
        const r = await transcribeAudio(cfg, abs, args.language);
        info(`[voice_transcribe] engine=${r.engine} chars=${String(r.text || "").length}`);
        return JSON.stringify(r);
      } catch (e) {
        return JSON.stringify({ error: `ASR 转写失败: ${e.message}` });
      }
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

// ---- 本地 ASR (2026-11-14): 外部 whisper 二进制兜底 ----

// 本地 ASR 命令构建 (纯函数, 导出供测试)。两种 flavor:
//   "cli" (默认): openai-whisper CLI —— whisper <audio> --model <m> --output_format txt --output_dir <dir> [--language <l>]
//   "whispercpp": whisper.cpp 的 whisper-cli —— --model <m> [--language <l>] --output-txt --output-dir <dir> <audio>
// 模型解析: model_path (本地模型文件) 优先, 否则 model 名 (openai-whisper 接受模型名或 .pt 路径)。
export function buildWhisperArgs(flavor, { bin, audioPath, modelPath, model, language, outDir } = {}) {
  const m = String(modelPath || model || "small");
  if (String(flavor || "").toLowerCase() === "whispercpp") {
    const args = ["--model", m];
    if (language) args.push("--language", String(language));
    args.push("--output-txt", "--output-dir", String(outDir), String(audioPath));
    return { cmd: String(bin), args };
  }
  const args = [String(audioPath), "--model", m, "--output_format", "txt", "--output_dir", String(outDir)];
  if (language) args.push("--language", String(language));
  return { cmd: String(bin), args };
}

// 本地转写: 跑外部 whisper 二进制, 读回输出的 .txt。
// _execFile 依赖注入 (测试用假二进制; 生产为默认 promisify(execFile)), 沿 shell.js 同款惯例。
export async function localTranscribe(cfg, absPath, language, { _execFile = pExecFile } = {}) {
  if (!cfg || !cfg.bin) {
    throw new Error("本地 ASR 需要 voice.asr.bin (whisper 可执行文件路径)。安装 openai-whisper (pip install openai-whisper) 后设 bin 为 whisper, 或配 whisper.cpp 的 whisper-cli。");
  }
  const flavor = cfg.flavor === "whispercpp" ? "whispercpp" : "cli";
  const modelPath = cfg.modelPath || cfg.model_path || "";
  if (flavor === "whispercpp" && !modelPath) {
    throw new Error("whispercpp flavor 需要 voice.asr.model_path (ggml 模型文件路径)");
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-asr-"));
  try {
    const { cmd, args } = buildWhisperArgs(flavor, {
      bin: cfg.bin,
      audioPath: absPath,
      modelPath,
      model: cfg.model,
      language: language || cfg.defaultLanguage || cfg.default_language,
      outDir,
    });
    await _execFile(cmd, args, { timeout: cfg.timeoutMs || 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const txt = path.join(outDir, path.basename(absPath).replace(/\.[^.]+$/, "") + ".txt");
    if (!fs.existsSync(txt)) {
      throw new Error(`whisper 未产出转写文本 (期望 ${txt}); 检查 voice.asr.flavor 与二进制是否匹配 (openai-whisper=cli / whisper.cpp=whispercpp)`);
    }
    return fs.readFileSync(txt, "utf8").trim();
  } catch (e) {
    if (e && (e.code === "ENOENT" || /ENOENT/.test(String(e.message)))) {
      throw new Error(`本地 ASR 二进制未找到 (${cfg.bin})。安装 openai-whisper (pip install openai-whisper) 或 whisper.cpp, 并把可执行文件路径配到 voice.asr.bin`);
    }
    throw e;
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不阻断 */ }
  }
}

// 统一转写入口 (工具与 HTTP 端点共用, 防两处实现漂移):
//   主路: voice.asr 云端或本地 (单块内互斥, backend 标定);
//   兜底块: voice.asr_fallback (与 asr 同构, 可选) —— 主路失败时才走, engine 注明 "(fallback)"。
//   都没配 → 指引错误, 不编结果。
export async function transcribeAudio(config, absPath, language, di = {}) {
  const pick = (block) => {
    const cloud = resolveVoice(config, block);
    if (cloud) return { kind: "cloud", cfg: cloud };
    const local = resolveLocalAsr(config, block);
    if (local) return { kind: "local", cfg: local };
    return null;
  };
  const run = async (route) => route.kind === "cloud"
    ? { text: await cloudTranscribe(route.cfg, absPath, language), engine: "cloud" }
    : { text: await localTranscribe(route.cfg, absPath, language, di), engine: "local" };
  const primary = pick("asr");
  if (primary) {
    try {
      return { ok: true, ...(await run(primary)) };
    } catch (e) {
      const fb = pick("asr_fallback");
      if (!fb) throw e;
      const r = await run(fb);
      return { ok: true, ...r, engine: `${r.engine} (fallback)`, primaryError: e.message };
    }
  }
  const fb = pick("asr_fallback");
  if (fb) return { ok: true, ...(await run(fb)) };
  throw new Error("ASR 未配置: 需在 config.voice.asr 设 base_url + api_key (云端 OpenAI 兼容端点), 或 backend=local + bin (外部 whisper 二进制)");
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
 * bin: whisper 可执行文件 (必填; openai-whisper 的 whisper / whisper.cpp 的 whisper-cli);
 * flavor: "cli" (openai-whisper, 默认) | "whispercpp" (whisper.cpp, 需 model_path);
 * timeout_ms: 转写超时 (默认 120000)。
 * @param {string} kind 配置块名 (默认 "asr"; 兜底块传 "asr_fallback")
 * @returns {object|null} 非本地后端 → null
 */
export function resolveLocalAsr(config = {}, kind = "asr") {
  const c = config && config.voice && config.voice[kind];
  if (!c || typeof c !== "object") return null;
  if (String(c.backend || "").toLowerCase() !== "local") return null;
  const out = {
    backend: "local",
    model: String(c.model || "small"),
    defaultLanguage: String(c.language || c.default_language || ""),
    flavor: String(c.flavor || "cli").toLowerCase() === "whispercpp" ? "whispercpp" : "cli",
    timeoutMs: Number(c.timeout_ms) || 120000,
  };
  if (c.model_path || c.modelPath) out.modelPath = String(c.model_path || c.modelPath);
  if (c.bin || c.binary) out.bin = String(c.bin || c.binary);
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
