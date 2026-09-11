// scripts/multimodal-smoke.js - 多模态连通性测试 (本地模型优先用 lmstudio, 读图→image_url→模型回复)
// 用法: node scripts/multimodal-smoke.js [图片路径]
//        默认图片 = 用户剪贴板截图 (LM Studio UI)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LLMClient } from "../src/llm/client.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");

// 默认图片: LM Studio UI 截图 (有清晰的文本/模型名/URL, 便于验证模型真的「看见」了图)
const DEFAULT_IMAGE = "C:\\Users\\chen\\.workbuddy\\clipboard-images\\clipboard-2026-08-16T13-40-17-784Z-5568b0a1.png";
const IMAGE = process.argv[2] || DEFAULT_IMAGE;

// 从 config/ppx.json 找本地/视觉 provider (lmstudio > 其他本地 > qwen-vl 兜底)
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "ppx.json"), "utf8"));
const prov =
  cfg.providers.find((p) => /127\.0\.0\.1|localhost|lm-studio/i.test(p.base_url || "")) ||
  cfg.providers.find((p) => p.vision) ||
  cfg.providers[0];

if (!fs.existsSync(IMAGE)) {
  console.error(`✗ 图片不存在: ${IMAGE}`);
  process.exit(1);
}
const buf = fs.readFileSync(IMAGE);
const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;

const client = new LLMClient(prov);

(async () => {
  console.log(`→ Provider: ${prov.id} | ${prov.base_url}`);
  console.log(`→ Model: ${prov.model}`);
  console.log(`→ Image: ${IMAGE} (${buf.length} bytes, ${Math.round(buf.length / 1024)} KB)`);
  const ok = await client.health();
  console.log(`→ Health: ${ok ? "OK" : "失败"}`);
  if (!ok) process.exit(1);

  console.log(`\n→ 发送多模态请求 (image_url + text)...`);
  const t0 = Date.now();
  const r = await client.chat([
    { role: "user", content: [
      { type: "text", text: "请仔细看这张截图, 用中文简洁描述: 1) 图中是什么软件界面 2) 加载了什么模型(精确到模型名) 3) 本地服务地址是什么" },
      { type: "image_url", image_url: { url: dataUrl } },
    ] },
  ]);
  const dt = Date.now() - t0;
  console.log(`\n✓ 模型回复 (${dt}ms):\n${r.content}`);
  client.close?.();
})().catch((e) => { console.error(`✗ 失败: ${e.message}`); process.exit(1); });