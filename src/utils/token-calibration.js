// src/llm/token-calibration.js - estimateTokens 自校准 (2026-10-31)
// 动机: 内置启发式估算 (CJK 0.85/字, ASCII/4) 与真实 tokenizer 有模型相关偏差 (±30% 常见),
//   而 compaction 触发点 / 历史预算 / system 预算全都吃这个估算 —— 偏差直接变成预算失真。
// 机制: 上游返回真值 usage.completion_tokens 时, 与同一段回复文本的**基础估算**做比值,
//   EWMA 收敛出一个全局校正系数; estimateTokens (utils/text.js) 对内置启发式路径乘上它。
// 设计约束:
//   - 只采**纯文本回复** (调用方负责): tool_calls 的 JSON 参数计入 completion_tokens 但
//     不走文本估算路径, 混入会失真;
//   - 样本闸: 比值落在 [0.2, 5] 之外视为离群 (截断/异常计费) 直接丢弃;
//   - 收敛闸: <3 个样本不生效 (单样本噪声太大), 系数钳位 [0.5, 2.5] (保留"宁高估勿低估"的保守方向);
//   - 零持久化: 进程内 EWMA, 重启后 ~3 次调用重新收敛 (成本低到不值得落盘);
//   - 用户自带真 tokenizer (setTokenEstimator) 时, estimateTokens 不再乘系数 (不扭曲真值)。

let _factor = 1;    // 原始 EWMA 比值 (observed / estimatedBase)
let _samples = 0;

// 喂一个校准样本; estimatedBase 必须是**未乘系数**的基础估算 (utils/text.js estimateTokensBase)
export function recordTokenSample({ observed, estimatedBase }) {
  const o = Number(observed);
  const b = Number(estimatedBase);
  if (!(o > 0) || !(b > 0)) return false;
  const ratio = o / b;
  if (ratio < 0.2 || ratio > 5) return false; // 离群闸
  _samples++;
  _factor = _samples === 1 ? ratio : _factor * 0.8 + ratio * 0.2;
  return true;
}

// 当前生效系数 (样本不足 → 1 = 不校正); 钳位 [0.5, 2.5]
export function tokenCalibrationFactor() {
  if (_samples < 3) return 1;
  return Math.min(2.5, Math.max(0.5, _factor));
}

// 可观测: 样本数 / 生效系数 / 原始 EWMA 值 (诊断用, 不进决策)
export function tokenCalibrationStats() {
  return { samples: _samples, factor: tokenCalibrationFactor(), rawFactor: _factor };
}

// 仅供测试: 归零
export function _resetTokenCalibration() {
  _factor = 1;
  _samples = 0;
}
