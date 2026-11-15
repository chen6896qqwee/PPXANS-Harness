#!/usr/bin/env node
// scripts/pricing-audit.js - 价格表覆盖审计闸门 (2026-11-12, 零依赖)
//
// 动机:
//   2026-11 实测发现"账上 $0.08 / 实际远高"——内置价格表停在上代模型名上:
//   DeepSeek 2026-07 已把 chat/reasoner 换成 deepseek-flash/v4-pro, 新模型全部
//   落到"未知 → $0"; 硅基流动的 vendor/model 形式、Claude 3.x 的"族名在型号后"
//   也永远匹配不到。价格表是手写的, 而 CI 里没有任何闸门看着它。
//
// 做法:
//   ① 覆盖闸门: src/llm/presets.js 里每个云厂商预设模型都必须能解析出价格
//      (免费档算已定价; 本地预设 lmstudio/ollama 免 Key 免计费, 不要求)。
//   ② 表体检: 单价必须有限非负; tiers 必须升序且有可用档位。
//   ③ 打印内置表 (USD + 人民币估算) 与配置里出现的未定价模型, 供人工核对。
//
// 用法:
//   node scripts/pricing-audit.js            # 打印报表 (不拦)
//   node scripts/pricing-audit.js --check    # 预设有未定价模型/表非法 → 非零退出
//   node scripts/pricing-audit.js --json     # 机读输出
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PROVIDER_PRESETS, presetModelIds } from "../src/llm/presets.js";
import { PRICING_META, priceTable, resolvePrice, isPriced } from "../src/llm/pricing.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");
const JSON_OUT = process.argv.includes("--json");

const rows = priceTable();

// ---- ① 预设覆盖 ----
const missing = [];
for (const p of PROVIDER_PRESETS) {
  if (p.cloud === false) continue;
  for (const id of presetModelIds(p)) {
    if (!isPriced(id)) missing.push({ preset: p.id, model: id });
  }
}

// ---- ② 表体检 ----
const invalid = [];
const seen = new Map();
for (const e of rows) {
  const prices = [e.prompt, e.completion, e.cached,
    ...(e.peak ? [e.peak.prompt, e.peak.completion, e.peak.cached] : []),
    ...(e.tiers || []).flatMap((t) => [t.prompt, t.completion, t.cached])];
  if (prices.some((n) => n == null || !Number.isFinite(n) || n < 0)) invalid.push(`${e.prefix}: 单价非法/为负`);
  if (seen.has(e.prefix)) invalid.push(`${e.prefix}: 前缀重复 (${seen.get(e.prefix)} 行)`);
  seen.set(e.prefix, true);
  if (e.tiers) {
    for (let i = 1; i < e.tiers.length; i++) {
      if (e.tiers[i].minInput <= e.tiers[i - 1].minInput) invalid.push(`${e.prefix}: tiers 未按 minInput 升序`);
    }
  }
}

// ---- ③ 本地配置里出现的未定价模型 (只提示, 不拦: 私有网关可能故意不配价) ----
function configuredModels() {
  const f = path.join(ROOT, "config", "ppx.json");
  if (!fs.existsSync(f)) return [];
  try {
    const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
    const out = [];
    const isLocalUrl = (u) => /\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(String(u || ""));
    for (const p of Array.isArray(cfg.providers) ? cfg.providers : []) {
      if (!p || isLocalUrl(p.base_url)) continue;
      const models = new Set([p.model, ...(Array.isArray(p.models) ? p.models.map((m) => (typeof m === "string" ? m : m?.id)) : [])]
        .filter(Boolean));
      for (const m of models) if (!isPriced(m, cfg.budget?.model_prices)) out.push({ provider: p.id || "?", model: m });
    }
    return out;
  } catch { return []; }
}
const unpricedConfigured = configuredModels();

// USD 单价展示: 0 显示 free, 其余按量级自适应, 避免 0.007 被 toFixed(2) 吃掉
function usd(n) {
  if (!n) return "free";
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  return n.toFixed(4);
}
const cny = (n) => (n * PRICING_META.cny_per_usd).toFixed(2);

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: missing.length === 0 && invalid.length === 0,
    meta: PRICING_META,
    table: rows,
    missing,
    invalid,
    unpricedConfigured,
  }, null, 2));
} else {
  console.log(`价格表快照 ${PRICING_META.updated} · 汇率假设 1 USD = ${PRICING_META.cny_per_usd} CNY`);
  console.log(`${PRICING_META.note}\n`);
  console.log("前缀                    prompt(USD)  completion  cached      ≈prompt(CNY)");
  for (const e of rows) {
    console.log(`  ${e.prefix.padEnd(22)} ${usd(e.prompt).padStart(10)} ${usd(e.completion).padStart(11)} `
      + `${usd(e.cached).padStart(9)} ${cny(e.prompt).padStart(12)}`);
    if (e.tiers) {
      for (const t of e.tiers) {
        console.log(`    └ 输入 ≥ ${String(t.minInput).padStart(7)} tok 起: ${usd(t.prompt)} / ${usd(t.completion)} (cached ${usd(t.cached)})`);
      }
    }
    if (e.peak) console.log(`    └ 高峰: ${usd(e.peak.prompt)} / ${usd(e.peak.completion)} (cached ${usd(e.peak.cached)})`);
  }
  console.log("");
  if (missing.length) {
    console.log(`未定价的云端预设模型 (${missing.length}):`);
    for (const m of missing) console.log(`  ✗ ${m.preset}: ${m.model}`);
  } else {
    console.log("✓ 全部云端预设模型都有价格");
  }
  if (invalid.length) {
    console.log(`\n价格表非法条目 (${invalid.length}):`);
    for (const s of invalid) console.log(`  ✗ ${s}`);
  }
  if (unpricedConfigured.length) {
    console.log(`\n本地配置里的未定价模型 (仅提示, 可用 budget.model_prices / assume_price 覆盖):`);
    for (const m of unpricedConfigured) console.log(`  · ${m.provider}: ${m.model}  (估算价 ${usd(resolvePrice(m.model)?.prompt ?? 0)})`);
  }
}

if (CHECK && (missing.length || invalid.length)) {
  console.error(`\n价格覆盖审计失败: ${missing.length} 个云端预设模型无价格, ${invalid.length} 个表条目非法`);
  console.error("修复: 在 src/llm/pricing.js 的 PRICES 补齐条目 (国内厂商可直接写 currency: \"CNY\")");
  process.exitCode = 1;
}
