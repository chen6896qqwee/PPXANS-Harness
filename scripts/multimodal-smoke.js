// scripts/multimodal-smoke.js - 多模态连通性测试 (本地模型优先用 lmstudio, 读图→image_url→模型回复)
// 用法: node scripts/multimodal-smoke.js [图片路径]
//        默认图片 = 用户剪贴板截图 (LM Studio UI)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LLMClient } from "../src/llm/client.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

// 默认图片: 仓库内置测试图 (红/绿/蓝三色条带, 便于验证模型真的「看见」了图)
const DEFAULT_IMAGE = path.join(ROOT, "scripts", "assets", "test-vision.png");
const IMAGE = process.argv[2] || DEFAULT_IMAGE;

// 从 config/ppx.json 找本地/视觉 provider: 候选链 = 本地(lmstudio) → vision 厂商 → 其余, 探活失败自动降级
// (2026-10-02 修复: 原先只选一个, 本地不在就硬退出)
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "ppx.json"), "utf8"));
const isLocal = (p) => /127\.0\.0\.1|localhost|lm-studio/i.test(p.base_url || "");
const candidates = [
  ...cfg.providers.filter(isLocal),
  ...cfg.providers.filter((p) => !isLocal(p) && p.vision),
  ...cfg.providers.filter((p) => !isLocal(p) && !p.vision),
];

if (!fs.existsSync(IMAGE)) {
  console.error(`✗ 图片不存在: ${IMAGE}`);
  process.exit(1);
}
const buf = fs.readFileSync(IMAGE);
const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;

const client0 = null; // 占位: 候选链探活后确定 client

(async () => {
  let client = null;
  let prov = null;
  for (const cand of candidates) {
    const c = new LLMClient(cand);
    const ok = await c.health().catch(() => false);
    console.log(`→ 探活 ${cand.id} | ${cand.base_url} : ${ok ? "OK" : "失败, 降级下一个"}`);
    if (ok) { client = c; prov = cand; break; }
    c.close?.();
  }
  if (!client) { console.error("✗ 所有候选 provider 均不可用"); process.exit(1); }

  console.log(`→ Provider: ${prov.id} | Model: ${prov.model}`);
  console.log(`→ Image: ${IMAGE} (${buf.length} bytes, ${Math.round(buf.length / 1024)} KB)`);

  console.log(`\n→ 发送多模态请求 (image_url + text)...`);
  const t0 = Date.now();
  const r = await client.chat([
    { role: "user", content: [
      { type: "text", text: "请仔细看这张图, 用中文回答: 图中从上到下有哪几种颜色条带? 只列颜色名。" },
      { type: "image_url", image_url: { url: dataUrl } },
    ] },
  ]).catch((e) => ({ content: "请求异常: " + e.message }));
  const dt = Date.now() - t0;
  console.log(`\n✓ 模型回复 (${dt}ms):\n${r.content}`);
  // 可行动诊断: 区分「模型不支持图像」与「视觉识别失败」
  if (/不支持|UnsupportedModel|数据不完整|已损坏|cannot|not support/i.test(r.content)) {
    console.error(`\n✗ 诊断: 当前模型 (${prov.model}) 不支持图像输入或端点拒绝了图片。`);
    console.error(`  修复: 在 config/ppx.json 前置一个视觉模型 provider, 例如:`);
    console.error(`  - 智谱 glm-4v-flash (免费额度, base_url=https://open.bigmodel.cn/api/paas/v4)`);
    console.error(`  - 阿里 qwen-vl-max (base_url=https://dashscope.aliyuncs.com/compatible-mode/v1)`);
    console.error(`  (注: 编程特化模型的 Key 往往不含视觉能力, 视觉需单独配 vision provider, 见 docs/MODEL-SETUP.md)`);
    client.close?.();
    process.exit(2);
  }
  const seen = ["红", "绿", "蓝"].filter((k) => r.content.includes(k));
  console.log(`→ 视觉验证: 命中 ${seen.length}/3 种颜色${seen.length >= 2 ? " ✓ 视觉链路正常" : " (命中过少, 请人工复核)"}`);
  client.close?.();
})().catch((e) => { console.error(`✗ 失败: ${e.message}`); process.exit(1); });