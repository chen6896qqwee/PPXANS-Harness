// test/token-calibration.test.js — estimateTokens 自校准 (2026-10-31)
// 真值 usage.completion_tokens 反馈 → EWMA 系数 → estimateTokens 内置启发式路径收敛到
// 当前模型的真实 tokenizer 口径; 钉住: 收敛闸/离群闸/钳位/纯度 (base 不受污染)。
import test from "node:test";
import assert from "node:assert";
import {
  recordTokenSample,
  tokenCalibrationFactor,
  tokenCalibrationStats,
  _resetTokenCalibration,
} from "../src/utils/token-calibration.js";
import { estimateTokens, estimateTokensBase, setTokenEstimator } from "../src/utils/text.js";

test("estimateTokensBase: 纯启发式 (CJK 0.85/字, ASCII/4), 不受校准系数污染", () => {
  _resetTokenCalibration();
  // 喂 5 个 1.5x 样本把系数拉上去
  for (let i = 0; i < 5; i++) recordTokenSample({ observed: 150, estimatedBase: 100 });
  assert.ok(tokenCalibrationFactor() > 1, "系数已生效");
  assert.equal(estimateTokensBase("hello"), 2, "base 恒为纯启发式 (5 ascii → ceil(5/4)=2)");
  assert.ok(estimateTokens("hello") >= estimateTokensBase("hello"), "factored ≥ base");
});

test("样本 <3 不生效 (系数恒 1)", () => {
  _resetTokenCalibration();
  recordTokenSample({ observed: 130, estimatedBase: 100 });
  recordTokenSample({ observed: 130, estimatedBase: 100 });
  assert.equal(tokenCalibrationFactor(), 1, "单/双样本噪声太大, 不校正");
  recordTokenSample({ observed: 130, estimatedBase: 100 });
  assert.ok(tokenCalibrationFactor() > 1, "第 3 个样本起生效");
});

test("EWMA 收敛: 稳定 1.3x 的模型, estimateTokens 输出贴近 1.3x base", () => {
  _resetTokenCalibration();
  for (let i = 0; i < 20; i++) recordTokenSample({ observed: 130, estimatedBase: 100 });
  const f = tokenCalibrationFactor();
  assert.ok(Math.abs(f - 1.3) < 0.02, `EWMA 收敛到 ~1.3, 实际 ${f}`);
  const text = "hello world, this is a calibration test sentence";
  const base = estimateTokensBase(text);
  assert.equal(estimateTokens(text), Math.max(1, Math.ceil(base * f)), "estimateTokens = base × 系数");
});

test("离群闸: 比值 <0.2 或 >5 的样本被丢弃 (截断/异常计费)", () => {
  _resetTokenCalibration();
  for (let i = 0; i < 4; i++) recordTokenSample({ observed: 100, estimatedBase: 100 });
  const before = tokenCalibrationStats();
  assert.equal(recordTokenSample({ observed: 1000, estimatedBase: 100 }), false, "10x 离群拒绝");
  assert.equal(recordTokenSample({ observed: 5, estimatedBase: 100 }), false, "0.05x 离群拒绝");
  const after = tokenCalibrationStats();
  assert.equal(after.samples, before.samples, "样本数不增");
  assert.equal(after.rawFactor, before.rawFactor, "EWMA 不动");
});

test("非法样本 (0/负值) 被拒绝", () => {
  _resetTokenCalibration();
  assert.equal(recordTokenSample({ observed: 0, estimatedBase: 100 }), false);
  assert.equal(recordTokenSample({ observed: 50, estimatedBase: 0 }), false);
  assert.equal(recordTokenSample({ observed: -1, estimatedBase: 100 }), false);
  assert.equal(tokenCalibrationStats().samples, 0);
});

test("钳位 [0.5, 2.5]: 极端一致的偏差也不会把预算放大/缩小超过保护带", () => {
  _resetTokenCalibration();
  for (let i = 0; i < 30; i++) recordTokenSample({ observed: 480, estimatedBase: 100 }); // 4.8x
  assert.equal(tokenCalibrationFactor(), 2.5, "高侧钳位");
  _resetTokenCalibration();
  for (let i = 0; i < 30; i++) recordTokenSample({ observed: 25, estimatedBase: 100 }); // 0.25x
  assert.equal(tokenCalibrationFactor(), 0.5, "低侧钳位 (保留保守方向)");
});

test("estimateTokens 与 base 在无样本时逐位一致 (零回归契约)", () => {
  _resetTokenCalibration();
  const samples = ["", "hello", "你好世界", "mixed 中英文 123!", "🎉emoji", "a".repeat(1000)];
  for (const s of samples) assert.equal(estimateTokens(s), estimateTokensBase(s));
});

test("用户注入真 tokenizer 时不受校准系数影响 (不扭曲真值)", () => {
  _resetTokenCalibration();
  for (let i = 0; i < 6; i++) recordTokenSample({ observed: 200, estimatedBase: 100 }); // 系数 ~2
  try {
    setTokenEstimator((s) => String(s || "").length); // 假"真 tokenizer": 1 字符 = 1 token
    assert.equal(estimateTokens("abcd"), 4, "真 tokenizer 路径零系数介入");
    assert.equal(estimateTokens(""), 0);
  } finally {
    setTokenEstimator(null);
    _resetTokenCalibration();
  }
});

test("EWMA 平滑: 单个偶发样本不会把系数带跑 (80/20 权重)", () => {
  _resetTokenCalibration();
  for (let i = 0; i < 10; i++) recordTokenSample({ observed: 100, estimatedBase: 100 }); // 稳定 1.0
  const stable = tokenCalibrationStats().rawFactor;
  recordTokenSample({ observed: 300, estimatedBase: 100 }); // 偶发 3x
  const after = tokenCalibrationStats().rawFactor;
  assert.ok(Math.abs(after - stable) < 0.45, `偶发样本只挪动 20%, 实际挪动 ${Math.abs(after - stable)}`);
});
