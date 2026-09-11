// src/utils/pii.js - PII / 凭证检测与脱敏 (架构参考 openhanako pii-guard)
const HARD_PATTERNS = [
  { name: "api_key", regex: /\b(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|gsk_[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]{20,}|xoxb-[a-zA-Z0-9-]+)\b/g },
  // v1.0.8: 放宽 inline_secret 值域 (含 :/# 等) + 8 位起, 短密钥不漏检 (原 16+ 位且不含 :#)
  { name: "inline_secret", regex: /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|bearer)\s*[:=]\s*["']?([a-zA-Z0-9_/+=\-.:#]{8,})["']?/gi },
  { name: "private_key", regex: /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: "credit_card", regex: /\b(?:\d{4}[- ]?){3}\d{4}\b/g },
  { name: "id_card", regex: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // v1.0.8: 邮箱 + 中国大陆手机号 (11 位, 1[3-9] 开头)
  { name: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "phone", regex: /\b1[3-9]\d{9}\b/g },
];

export function scrubPII(text) {
  if (!text) return { cleaned: text, detected: [] };
  const detected = [];
  let cleaned = text;
  for (const { name, regex } of HARD_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(cleaned)) {
      detected.push(name);
      regex.lastIndex = 0;
      cleaned = cleaned.replace(regex, "[REDACTED]");
    }
  }
  return { cleaned, detected };
}

export function hasPII(text) {
  if (!text) return false;
  for (const { regex } of HARD_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}
