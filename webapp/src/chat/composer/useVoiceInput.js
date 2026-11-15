// webapp/src/chat/composer/useVoiceInput.js - 语音输入: 云端 ASR 优先, 浏览器识别兜底
//
// 从 Composer.vue 抽出来 (2026-11-13)。两条链路:
//   · 云端 ASR (settings 里配了 asr): MediaRecorder 录 webm → 重采样 16k WAV → base64 上传
//   · 浏览器识别 (SpeechRecognition): 没有云端时用它, 明确提示"浏览器识别"
// 两者都没有就如实说"语音未配置", 不假装在听。录音短于 400ms 直接丢弃, 不浪费一次转写。
import { ref } from "vue";
import { chat } from "../../stores/chat.js";
import { showToast } from "../../stores/toast.js";
import { voiceTranscribeApi } from "../../api/endpoints.js";

/**
 * @param {import("vue").Ref<HTMLTextAreaElement|null>} inp 输入框 ref (转写结果落回光标处)
 */
export function useVoiceInput(inp) {
  const rec = { active: false, media: null, chunks: [], stream: null, t0: 0, sr: null };
  const micRec = ref(false);

  function encodeWav(float32, rate) {
    const len = float32.length;
    const buf = new ArrayBuffer(44 + len * 2);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); ws(8, "WAVE");
    ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }
  async function blobToWav16k(blob) {
    const ab = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try {
      const audio = await ctx.decodeAudioData(ab);
      const sr = 16000;
      const len = Math.max(1, Math.round(audio.duration * sr));
      const off = new OfflineAudioContext(1, len, sr);
      const src = off.createBufferSource();
      src.buffer = audio;
      src.connect(off.destination);
      src.start();
      const rendered = await off.startRendering();
      return encodeWav(rendered.getChannelData(0), 16000);
    } finally {
      try { ctx.close(); } catch { /* 忽略 */ }
    }
  }
  function blobToB64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] || "");
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }
  function insertToInput(text) {
    chat.input = (chat.input ? chat.input.replace(/\s*$/, " ") : "") + text;
    inp.value && inp.value.focus();
  }
  function browserSR() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = "zh-CN"; r.interimResults = false; r.maxAlternatives = 1;
    return r;
  }
  function startMic() {
    const status = (chat.llm && chat.llm.voice) || {};
    if (status.asr) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        rec.stream = stream; rec.chunks = []; rec.t0 = Date.now();
        const mr = new MediaRecorder(stream);
        mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
        mr.onstop = async () => {
          const blob = new Blob(rec.chunks, { type: mr.mimeType || "audio/webm" });
          rec.stream.getTracks().forEach((t) => t.stop());
          micRec.value = false;
          if (Date.now() - rec.t0 < 400) { showToast("录音太短"); return; }
          showToast("转写中…");
          try {
            const wav = await blobToWav16k(blob).catch(() => blob);
            const b64 = await blobToB64(wav);
            const r = await voiceTranscribeApi({ name: "voice.wav", data: b64, language: "zh" });
            if (r && r.text) { insertToInput(r.text); showToast("已转写"); }
            else showToast("没有识别到内容", true);
          } catch (e) {
            showToast("转写失败: " + e.message, true);
          }
        };
        rec.media = mr; mr.start(); rec.active = true;
        micRec.value = true; showToast("开始录音 · 再点一下结束");
      }).catch((e) => showToast("麦克风不可用: " + ((e && e.message) || e), true));
      return;
    }
    const sr = browserSR();
    if (sr) {
      rec.sr = sr; rec.active = true; micRec.value = true;
      sr.onresult = (ev) => {
        const txt = ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript;
        if (txt) { insertToInput(txt); showToast("已转写"); }
      };
      sr.onerror = (ev) => showToast("浏览器识别失败: " + ((ev && ev.error) || "未知") + " (可在 设置 → 通用设置 配云端 ASR)", true);
      sr.onend = () => { rec.active = false; micRec.value = false; };
      try { sr.start(); showToast("正在聆听… (浏览器识别)"); } catch (e) { showToast("无法启动识别: " + e.message, true); micRec.value = false; rec.active = false; }
      return;
    }
    showToast("语音未配置: 浏览器不支持识别, 且 设置 → 通用设置 未设云端 ASR", true);
  }
  function stopMic() {
    if (rec.media && rec.media.state !== "inactive") rec.media.stop();
    if (rec.sr) { try { rec.sr.stop(); } catch { /* 忽略 */ } }
    if (rec.stream) { try { rec.stream.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ } }
    rec.active = false; micRec.value = false;
  }
  function micClick() { if (rec.active) stopMic(); else startMic(); }

  return { micRec, micClick };
}
