import { createHash } from "node:crypto";

export const EVAL_STRATA_KEYS = Object.freeze(["business", "complexity", "language", "toolchain", "risk"]);
export const DEFAULT_EVAL_SAMPLE_RATE = 0.05;

function unknownText(value) {
  if (value == null || value === "") return "unknown";
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "unknown";
}

export function normalizeEvalStrata(value = null) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(EVAL_STRATA_KEYS.map((key) => [key, unknownText(source[key])]));
}

export function normalizeEvalSampleRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_EVAL_SAMPLE_RATE;
}

export function sampleEvalTask(taskId, strata = null, rate = DEFAULT_EVAL_SAMPLE_RATE) {
  const normalized = normalizeEvalStrata(strata);
  const probability = normalizeEvalSampleRate(rate);
  if (probability === 1) return { sampled: true, sampleWeight: 1, sampleReason: "stratified" };
  if (probability === 0) return { sampled: false, sampleWeight: 0, sampleReason: "stratified" };
  const digest = createHash("sha256").update(`${JSON.stringify(normalized)}\n${unknownText(taskId)}`).digest();
  const bucket = digest.readUInt32BE(0) / 0x100000000;
  return {
    sampled: bucket < probability,
    sampleWeight: bucket < probability ? 1 / probability : 0,
    sampleReason: "stratified",
  };
}
