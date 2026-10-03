// src/tools/voice.js - 语音能力 (ASR 语音转文本 + TTS 文本转语音)
// 设计原则: 零运行时依赖 —— 走 OpenAI 兼容 HTTP 端点
//   ASR: POST {base_url}/audio/transcriptions  (multipart/form-data)
//   TTS: POST {base_url}/audio/speech          (返回二进制音频)
// multipart 用 Node 内置的 FormData + Blob (18+ 全局), 不引入任何 npm 包。
// 兼容: OpenAI / 硅基流动 / 火山 / 智谱 / 本地 whisper.cpp server 等任意 OpenAI 兼容端点。
import fs from "node:fs";
import path from "node:path";
import { TOOL_ERROR_PREFIX } from "./seam.js";
import { info } from "../utils/logger.js";

// 常见音频扩展名 (用于路径与格式校验)
const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".webm", ".mp4", ".amr", ".silk"]);
const MAX_ASR_BYTES = 25 * 1024 * 1024; // 25MB: OpenAI 兼容端点通用上限

function err(name, msg) {
  return `${TOOL_ERROR_PREFIX} ${name}: ${msg}`;
}

// 从配置解析一段语音端点 (asr / tts); 传入**完整 config**, 内部读 config.voice[kind]。
// 返回 {baseUrl, apiKey, model, ...} 或 null (未配置 / 声明了 key 环境变量但没设值)
// v3.1: voice.asr 支持 backend:"local" —— 走本地 whisper 绑定 (nodejs-whisper, 可选依赖),
//       配 local 时 resolveVoice 返回 null 不影响本地路径 (本地判定在 resolveLocalAsr)。
export function resolveVoice(config = {}, kind = "asr") {
  const sec = config?.voice?.[kind];
  if (!sec || typeof sec !== "object") return null;
  if (sec.backend === "local") return null; // 本地后端不走 OpenAI 兼容端点
  const baseUrl = String(sec.base_url || "").replace(/\/+$/, "");
  if (!baseUrl) return null;
  const apiKey = sec.api_key || (sec.api_key_env ? process.env[sec.api_key_env] : "") || "";
  if (sec.api_key_env && !apiKey) return null; // 声明了 key 环境变量但没设 → 视为未配置
  return {
    baseUrl,
    apiKey,
    model: String(sec.model || (kind === "asr" ? "whisper-1" : "tts-1")),
    voice: String(sec.voice || "alloy"),
    format: String(sec.format || "mp3"),
    timeoutMs: Number(sec.timeout_ms) || 120000,
  };
}

// 本地 ASR 配置解析 (v3.1): voice.asr = { backend: "local", model, model_root_path?, auto_download?, language? }
// 依赖 nodejs-whisper (可选依赖, 动态 import; 未安装时报错并给出安装指引)
export function resolveLocalAsr(config = {}) {
  const sec = config?.voice?.asr;
  if (!sec || typeof sec !== "object" || sec.backend !== "local") return null;
  return {
    model: String(sec.model || "base"),
    modelRootPath: sec.model_root_path ? String(sec.model_root_path) : undefined,
    autoDownload: sec.auto_download !== false,
    defaultLanguage: sec.language ? String(sec.language) : undefined,
    timeoutMs: Number(sec.timeout_ms) || 300000, // 本地 CPU 推理给足 5 分钟
  };
}

// 本地转写实现: 优先 nodejs-whisper (whisper.cpp 绑定, 全格式自动转 WAV), 失败给出可执行的安装指引
async function localTranscribe(abs, opts, language) {
  try {
    const mod = await import("nodejs-whisper");
    const out = await mod.nodewhisper(abs, {
      modelName: opts.model,
      modelRootPath: opts.modelRootPath,
      autoDownloadModelName: opts.autoDownload ? opts.model : undefined,
      whisperOptions: { outputInJson: true, wordTimestamps: false, ...(language ? { } : {}) },
    });
    // nodejs-whisper 的 JSON 输出为分段数组 [{start,end,text}], 拼接; 字符串则直用
    if (Array.isArray(out)) {
      return out.map((s) => (s && (s.text || s.speech)) || "").join("").trim();
    }
    return String(out || "").trim();
  } catch (e) {
    const hint = e?.code === "ERR_MODULE_NOT_FOUND" || String(e?.message || "").includes("Cannot find package")
      ? "本地 ASR 依赖未安装。安装: npm i nodejs-whisper (Windows 需先装 MinGW-w64/MSYS2 提供 make), 或改用云端端点 voice.asr { base_url, api_key_env }"
      : `本地转写失败: ${e.message || e}`;
    throw new Error(hint);
  }
}

// 语音能力是否就绪 (供 list_capabilities / 诊断展示)
export function voiceStatus(config = {}) {
  const asrSec = config?.voice?.asr;
  return {
    asr: asrSec?.backend === "local" ? "local" : !!resolveVoice(config, "asr"),
    tts: !!resolveVoice(config, "tts"),
    enabled: config?.voice?.enabled !== false,
  };
}

const MIME = {
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/opus", ".webm": "audio/webm",
  ".mp4": "audio/mp4", ".amr": "audio/amr", ".silk": "audio/silk",
};

export function registerVoiceTools(catalog, { config = {}, rootDir = process.cwd() } = {}) {
  // ---- ASR: 语音转文本 ----
  catalog.register({
    name: "voice_transcribe",
    description: "把语音/音频文件转成文字 (ASR)。支持 wav/mp3/m4a/flac/ogg/webm 等, 上限 25MB。用于处理语音消息、会议录音、口述笔记。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "音频文件路径 (相对工作目录或绝对路径)" },
        language: { type: "string", description: "语言代码 (如 zh / en), 留空自动检测" },
        prompt: { type: "string", description: "提示词: 引导术语/人名/专有名词的识别 (可选)" },
      },
      required: ["path"],
    },
    category: "net",
    power: "user",
    idempotent: true,
    capability: { readOnly: true, riskLevel: "low", sideEffect: "network" },
    execute: async (args) => {
      // v3.1: 本地 ASR 后端 (voice.asr.backend="local") —— 零 API key, 离线可用
      const localOpts = resolveLocalAsr(config);
      if (localOpts) {
        const abs = path.isAbsolute(args.path) ? args.path : path.resolve(rootDir, args.path);
        if (!fs.existsSync(abs)) return err("voice_transcribe", `文件不存在: ${args.path}`);
        const st = fs.statSync(abs);
        if (st.size > MAX_ASR_BYTES) {
          return err("voice_transcribe", `文件过大 (${(st.size / 1048576).toFixed(1)}MB > 25MB), 请先切片`);
        }
        const ext = path.extname(abs).toLowerCase();
        if (!AUDIO_EXT.has(ext)) return err("voice_transcribe", `不支持的音频格式: ${ext}`);
        try {
          const text = await localTranscribe(abs, localOpts, args.language || localOpts.defaultLanguage);
          info(`[voice] 本地 ASR 完成: ${path.basename(abs)} (${(st.size / 1024).toFixed(0)}KB)`);
          return text || "(识别结果为空)";
        } catch (e) {
          return err("voice_transcribe", e.message || String(e));
        }
      }
      const v = resolveVoice(config, "asr");
      if (!v) {
        return err("voice_transcribe", "未配置 ASR。二选一: ① 云端 config/ppx.json → voice.asr { base_url, api_key_env, model }; ② 本地 voice.asr { backend: \"local\", model: \"base\" } (需 npm i nodejs-whisper)");
      }
      const abs = path.isAbsolute(args.path) ? args.path : path.resolve(rootDir, args.path);
      if (!fs.existsSync(abs)) return err("voice_transcribe", `文件不存在: ${args.path}`);
      const st = fs.statSync(abs);
      if (st.size > MAX_ASR_BYTES) {
        return err("voice_transcribe", `文件过大 (${(st.size / 1048576).toFixed(1)}MB > 25MB), 请先切片`);
      }
      const ext = path.extname(abs).toLowerCase();
      if (!AUDIO_EXT.has(ext)) return err("voice_transcribe", `不支持的音频格式: ${ext}`);

      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(abs)], { type: MIME[ext] || "application/octet-stream" }), path.basename(abs));
      form.append("model", v.model);
      if (args.language) form.append("language", String(args.language));
      if (args.prompt) form.append("prompt", String(args.prompt).slice(0, 800));

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), v.timeoutMs);
      try {
        const res = await fetch(`${v.baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: v.apiKey ? { Authorization: `Bearer ${v.apiKey}` } : {},
          body: form,
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) return err("voice_transcribe", `HTTP ${res.status}: ${text.slice(0, 300)}`);
        let out = text;
        try {
          const j = JSON.parse(text);
          out = j.text ?? j.result ?? text;
        } catch { /* 非 JSON 就直接用原文 */ }
        info(`[voice] ASR 完成: ${path.basename(abs)} (${(st.size / 1024).toFixed(0)}KB)`);
        return String(out).trim() || "(识别结果为空)";
      } catch (e) {
        return err("voice_transcribe", e.name === "AbortError" ? `请求超时 (${v.timeoutMs}ms)` : String(e.message || e));
      } finally {
        clearTimeout(timer);
      }
    },
  });

  // ---- TTS: 文本转语音 ----
  catalog.register({
    name: "voice_speak",
    description: "把文字合成语音文件 (TTS)。返回保存路径。用于生成语音播报、回复语音消息、口播稿试听。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要合成的文本" },
        out: { type: "string", description: "输出文件路径 (默认 data/voice/tts-<时间戳>.<格式>)" },
        voice: { type: "string", description: "音色名 (默认取配置, 如 alloy / zh-CN-XiaoxiaoNeural)" },
        format: { type: "string", enum: ["mp3", "wav", "opus", "aac", "flac"], description: "音频格式, 默认 mp3" },
      },
      required: ["text"],
    },
    category: "net",
    power: "user",
    capability: { riskLevel: "low", sideEffect: "filesystem+network" },
    execute: async (args) => {
      const v = resolveVoice(config, "tts");
      if (!v) {
        return err("voice_speak", "未配置 TTS 端点。在 config/ppx.json 里加 voice.tts { base_url, api_key_env, model, voice }");
      }
      const text = String(args.text || "").trim();
      if (!text) return err("voice_speak", "text 不能为空");
      if (text.length > 4000) return err("voice_speak", `文本过长 (${text.length} > 4000 字), 请分段合成`);
      const format = String(args.format || v.format || "mp3");

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), v.timeoutMs);
      try {
        const res = await fetch(`${v.baseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(v.apiKey ? { Authorization: `Bearer ${v.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: v.model, input: text, voice: args.voice || v.voice, response_format: format }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const t = await res.text();
          return err("voice_speak", `HTTP ${res.status}: ${t.slice(0, 300)}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const out = args.out
          ? (path.isAbsolute(args.out) ? args.out : path.resolve(rootDir, args.out))
          : path.join(rootDir, "data", "voice", `tts-${Date.now()}.${format}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, buf);
        info(`[voice] TTS 完成: ${buf.length} 字节 → ${out}`);
        return JSON.stringify({ ok: true, path: out, bytes: buf.length, format, chars: text.length });
      } catch (e) {
        return err("voice_speak", e.name === "AbortError" ? `请求超时 (${v.timeoutMs}ms)` : String(e.message || e));
      } finally {
        clearTimeout(timer);
      }
    },
  });

  return catalog;
}
