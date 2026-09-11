// src/tools/ocr.js - OCR 光学字符识别 (零依赖, 可插拔)
// 主通道: 本地 tesseract 二进制 (零 key 零网络, 需系统安装)
// 回退: 百度 OCR 云 API (需 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY)
// 用于: 扫描件 PDF / 图片里的文字识别 (read_image 读图后无法理解文字时)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const execFileP = promisify(execFile);

// 检测 tesseract 是否可用 (注入 _exec 便于测试)
export async function tesseractAvailable(bin = "tesseract", _exec = execFileP) {
  try {
    await _exec(bin, ["--version"], { timeout: 5000, windowsHide: true });
    return true;
  } catch { return false; }
}

// tesseract 识别图片 → 文字 (stdout 直接输出识别结果)
export async function ocrWithTesseract(filePath, { bin = "tesseract", lang = "chi_sim", timeoutMs = 30000, _exec = execFileP } = {}) {
  const { stdout, stderr } = await _exec(bin, [filePath, "stdout", "-l", lang], {
    timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true,
  });
  const text = String(stdout || "").trim();
  if (!text && stderr) throw new Error("tesseract 未识别出文字: " + String(stderr).slice(0, 200));
  return text;
}

// 百度 OCR: 取 access_token → 通用文字识别
async function ocrWithBaidu(filePath, { apiKey, secretKey }) {
  const tok = await fetch(
    `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`,
    { method: "POST", signal: AbortSignal.timeout(15000) },
  ).then((r) => r.json());
  if (!tok.access_token) throw new Error("百度 OCR token 获取失败: " + (tok.error_description || tok.error || "未知"));
  const img = fs.readFileSync(filePath).toString("base64");
  const body = new URLSearchParams({ image: img, language_type: "CHN_ENG" });
  const r = await fetch(`https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=${tok.access_token}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error_code) throw new Error("百度 OCR 失败: " + (j.error_msg || j.error_code));
  return (j.words_result || []).map((w) => w.words).join("\n");
}

// OCR 主入口: tesseract 优先, 云 OCR 回退, 都不可用抛中文引导
export async function ocrImage(filePath, { tesseract = "tesseract", lang = "chi_sim", cloud = null, _exec = execFileP } = {}) {
  if (!fs.existsSync(filePath)) throw new Error("文件不存在: " + filePath);
  if (await tesseractAvailable(tesseract, _exec)) {
    return ocrWithTesseract(filePath, { bin: tesseract, lang, _exec });
  }
  if (cloud && cloud.apiKey && cloud.secretKey) {
    return ocrWithBaidu(filePath, { apiKey: cloud.apiKey, secretKey: cloud.secretKey });
  }
  throw new Error("OCR 不可用: 请安装 tesseract (含中文语言包) 或配置 config.ocr 的云 OCR key");
}
