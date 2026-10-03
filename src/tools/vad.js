// src/tools/vad.js - 语音活动检测 (VAD, 零依赖)
//
// 用途: 语音消息/音频切分 —— 找出"有人说话"的片段, 供 ASR 只转写有效段 (省时省钱),
//       或语音通道做"说到停"的断句。
//
// 双后端:
//   energy (默认, 零依赖): 解析 WAV (PCM 16bit) → 按帧算 RMS → 能量阈值 + 滞回判定语音段。
//     对干净录音效果够用; 嘈杂环境弱于神经网络方案。
//   silero (可选): 动态 import onnxruntime-node 跑 Silero-VAD ONNX 模型 —— 包或模型缺失时
//     返回明确错误 (不静默降级, 让调用方自己选能量版)。
//     模型: silero_vad.onnx (https://github.com/snakers4/silero-vad), config 路径传入。
import fs from "node:fs";
import path from "node:path";
import { TOOL_ERROR_PREFIX } from "./seam.js";

function err(name, msg) {
  return `${TOOL_ERROR_PREFIX} ${name}: ${msg}`;
}

// ---- WAV 解析 (16-bit PCM only, 零依赖) ----
export function parseWavPcm16(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是 WAV (RIFF) 文件");
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (id === "data") {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV 缺少 fmt/data 块");
  if (fmt.format !== 1) throw new Error(`仅支持 PCM (format=1), 当前 format=${fmt.format}`);
  if (fmt.bitsPerSample !== 16) throw new Error(`仅支持 16-bit (当前 ${fmt.bitsPerSample}-bit), 请先转码`);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples: data };
}

// 16-bit 交错样本 → 单声道 Float32 (-1..1)
function toMono(samples, channels) {
  const n = Math.floor(samples.length / 2 / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += samples.readInt16LE((i * channels + c) * 2);
    out[i] = acc / channels / 32768;
  }
  return out;
}

// ---- 能量 VAD: 按帧 RMS + 滞回 (进入阈值 > 退出阈值, 防抖) ----
export function energyVad(pcm, { sampleRate = 16000, frameMs = 30, threshold = 0.015, hangoverMs = 300, minSpeechMs = 120 } = {}) {
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const hangFrames = Math.max(1, Math.round(hangoverMs / frameMs));
  const minSpeechFrames = Math.max(1, Math.round(minSpeechMs / frameMs));
  const frames = [];
  for (let i = 0; i + frameLen <= pcm.length; i += frameLen) {
    let sum = 0;
    for (let j = 0; j < frameLen; j++) { const v = pcm[i + j]; sum += v * v; }
    frames.push(Math.sqrt(sum / frameLen)); // RMS
  }
  // 自适应底噪: 取最安静的 20% 帧均值, 阈值 = max(固定下限, 底噪×4)
  const sorted = [...frames].sort((a, b) => a - b);
  const noise = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.2))).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(sorted.length * 0.2));
  const enterAt = Math.max(threshold, noise * 4);
  const exitAt = Math.max(threshold * 0.6, noise * 2.5);
  const segments = [];
  let inSpeech = false, start = 0, quietRun = 0;
  frames.forEach((rms, idx) => {
    if (!inSpeech && rms > enterAt) { inSpeech = true; start = idx; quietRun = 0; }
    else if (inSpeech) {
      if (rms < exitAt) { quietRun++; if (quietRun >= hangFrames) { inSpeech = false; if ((idx - quietRun + 1 - start) >= minSpeechFrames) segments.push([start, idx - quietRun + 1]); } }
      else quietRun = 0;
    }
  });
  if (inSpeech && frames.length - start >= minSpeechFrames) segments.push([start, frames.length]);
  const speechFrames = segments.reduce((a, [s, e]) => a + (e - s), 0);
  return {
    backend: "energy",
    durationMs: Math.round((frames.length * frameMs)),
    noiseFloor: Number(noise.toFixed(5)),
    threshold: Number(enterAt.toFixed(5)),
    speechRatio: frames.length ? Number((speechFrames / frames.length).toFixed(3)) : 0,
    segments: segments.map(([s, e]) => ({ startMs: Math.round(s * frameMs), endMs: Math.round(e * frameMs) })),
  };
}

// ---- Silero 后端 (可选): onnxruntime-node + silero_vad.onnx ----
async function sileroVad(abs, opts) {
  let ort;
  try { ort = await import("onnxruntime-node"); } catch {
    return err("vad_detect", "silero 后端需要 onnxruntime-node (npm i onnxruntime-node), 未安装。改用默认 energy 后端 (零依赖)");
  }
  if (!opts.model) return err("vad_detect", "silero 后端需指定模型路径: args.model = silero_vad.onnx 的绝对路径");
  const wav = parseWavPcm16(fs.readFileSync(abs));
  const mono = toMono(wav.samples, wav.channels);
  const session = await ort.InferenceSession.create(opts.model);
  // Silero-VAD v4/v5: 逐帧 (512 样本 @16k) 推理, state (h/c) 迭代传递
  const frame = 512;
  let h = new ort.Tensor("float32", new Float32Array(2 * 64), [2, 1, 64]);
  let c = new ort.Tensor("float32", new Float32Array(2 * 64), [2, 1, 64]);
  const probs = [];
  for (let i = 0; i + frame <= mono.length; i += frame) {
    const input = new ort.Tensor("float32", mono.subarray(i, i + frame), [1, frame]);
    const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(wav.sampleRate)]), []);
    const feeds = { input, h, c, sample_rate: sr };
    const out = await session.run(feeds);
    probs.push(out.output?.data?.[0] ?? 0);
    h = out.hn || h; c = out.cn || c;
  }
  const enterAt = opts.threshold ?? 0.5;
  const segments = [];
  let inSpeech = false, start = 0, quiet = 0;
  const frameMs = Math.round((frame / wav.sampleRate) * 1000);
  probs.forEach((p, idx) => {
    if (!inSpeech && p > enterAt) { inSpeech = true; start = idx; quiet = 0; }
    else if (inSpeech) {
      if (p < enterAt * 0.6) { quiet++; if (quiet >= Math.round(300 / frameMs)) { inSpeech = false; segments.push([start, idx - quiet + 1]); } }
      else quiet = 0;
    }
  });
  if (inSpeech) segments.push([start, probs.length]);
  return JSON.stringify({
    backend: "silero",
    durationMs: Math.round((mono.length / wav.sampleRate) * 1000),
    speechRatio: probs.length ? Number((segments.reduce((a, [s, e]) => a + (e - s), 0) / probs.length).toFixed(3)) : 0,
    segments: segments.map(([s, e]) => ({ startMs: s * frameMs, endMs: e * frameMs })),
  });
}

export function registerVadTools(catalog, { rootDir = process.cwd() } = {}) {
  catalog.register({
    name: "vad_detect",
    description: "语音活动检测 (VAD): 找出音频里有人说话的时间段。默认零依赖能量算法 (16-bit PCM WAV); 可选 silero 神经网络后端 (需 onnxruntime-node + onnx 模型)。用于 ASR 前切分、语音断句。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "WAV 文件路径 (16-bit PCM; 其他格式请先转码)" },
        backend: { type: "string", enum: ["energy", "silero"], description: "energy=零依赖能量阈值 (默认); silero=神经网络 (需 onnxruntime-node)" },
        model: { type: "string", description: "silero 后端: silero_vad.onnx 模型路径" },
        threshold: { type: "number", description: "能量后端: RMS 进入阈值 (默认 0.015 自适应底噪); silero 后端: 概率阈值 (默认 0.5)" },
      },
      required: ["path"],
    },
    category: "net",
    power: "user",
    idempotent: true,
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    execute: async (args) => {
      const abs = path.isAbsolute(args.path) ? args.path : path.resolve(rootDir, args.path);
      if (!fs.existsSync(abs)) return err("vad_detect", `文件不存在: ${args.path}`);
      if (args.backend === "silero") return sileroVad(abs, args);
      let wav;
      try {
        wav = parseWavPcm16(fs.readFileSync(abs));
      } catch (e) {
        return err("vad_detect", `${e.message} (仅支持 16-bit PCM WAV; mp3/m4a 请先转码: ffmpeg -i in.mp3 -acodec pcm_s16le -ar 16000 out.wav)`);
      }
      if (wav.sampleRate < 8000 || wav.sampleRate > 192000) return err("vad_detect", `采样率异常: ${wav.sampleRate}Hz`);
      const mono = toMono(wav.samples, wav.channels);
      const r = energyVad(mono, { sampleRate: wav.sampleRate, threshold: Number(args.threshold) || 0.015 });
      return JSON.stringify(r);
    },
  });
  return catalog;
}
