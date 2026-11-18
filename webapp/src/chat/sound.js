// webapp/src/chat/sound.js - 回合完成提示音 (WebAudio, 无音频资源文件)
// 双音上行短促 ("做完了"的听觉隐喻); 失败用下行三连音。AudioContext 惰性创建 ——
// 后台标签页 AudioContext 仍可出声, 但浏览器策略下首次必须由用户手势解锁过一次。
let ctx = null;

function ensureCtx() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

function tone(ac, freq, at, dur, gain) {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, ac.currentTime + at);
  g.gain.linearRampToValueAtTime(gain, ac.currentTime + at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + at + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(ac.currentTime + at);
  osc.stop(ac.currentTime + at + dur + 0.05);
}

/** 完成提示: G5→C6 两音, 约 0.35s, 音量克制 (后台提醒不吓人) */
export function playChime() {
  const ac = ensureCtx();
  if (!ac) return;
  try {
    tone(ac, 784, 0, 0.18, 0.12);
    tone(ac, 1046, 0.16, 0.22, 0.10);
  } catch { /* 出声失败不影响对话 */ }
}

/** 失败提示: C5→A4→E4 下行, 提示需要回头看一眼 */
export function playFail() {
  const ac = ensureCtx();
  if (!ac) return;
  try {
    tone(ac, 523, 0, 0.15, 0.10);
    tone(ac, 440, 0.15, 0.15, 0.10);
    tone(ac, 330, 0.30, 0.22, 0.10);
  } catch { /* 出声失败不影响对话 */ }
}
