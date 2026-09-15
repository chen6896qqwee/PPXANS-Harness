// src/tools/document.js - 文档加载器 (对标 LangChain Document Loaders, 零依赖)
// 支持: txt / md / json / csv / html / pdf (文字型, 扫描件需 OCR)
// PDF 零依赖提取: 解压 FlateDecode 流 (zlib) + 提取 Tj/TJ 文本操作符
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { ocrImage } from "./ocr.js";

const MAX_CHARS = 20000; // 单文档返回上限

// 安全路径: 阻止逃出工作目录 (防路径穿越, 与 builtin.js 同策略)
function safePath(root, p) {
  const resolved = path.resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`路径越界拒绝: ${p}`);
  }
  return resolved;
}

// 解码 PDF 文本字符串: 处理 UTF-16BE (FE FF BOM) 与 UTF-8 与转义字符
function decodePdfString(latin1Str) {
  let s = String(latin1Str || "").replace(/\\(\r?\n)/g, ""); // 续行
  const buf = Buffer.from(s, "latin1");
  // UTF-16BE BOM
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.slice(2).toString("utf16le");
  }
  // 字节级反转义 \( \) \\
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x5c && i + 1 < buf.length) {
      const n = buf[i + 1];
      if (n === 0x28 || n === 0x29 || n === 0x5c) { out.push(n); i++; continue; }
    }
    out.push(buf[i]);
  }
  const clean = Buffer.from(out);
  const utf8 = clean.toString("utf8");
  return utf8.includes("\uFFFD") ? clean.toString("latin1") : utf8;
}

// 零依赖 PDF 文本提取: 遍历 stream, FlateDecode 解压, 提取 (text) Tj 与 [(a)(b)] TJ
export function extractPdfText(buf) {
  const raw = buf.toString("latin1");
  const texts = [];
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    let data = m[1];
    // 尝试 FlateDecode 解压 (内容流通常是压缩的)
    try {
      const inf = zlib.inflateSync(Buffer.from(data, "latin1")).toString("latin1");
      if (inf.length > 0) data = inf;
    } catch { /* 未压缩则用原文 */ }
    // (text) Tj
    for (const tm of data.matchAll(/\(([^)]*)\)\s*Tj/g)) {
      const t = decodePdfString(tm[1]).trim();
      if (t) texts.push(t);
    }
    // [(a)(b)] TJ (数组形式)
    for (const tm of data.matchAll(/\[((?:\([^)]*\)[\s<>0-9.-]*)+)\]\s*TJ/g)) {
      for (const pm of tm[1].matchAll(/\(([^)]*)\)/g)) {
        const t = decodePdfString(pm[1]).trim();
        if (t) texts.push(t);
      }
    }
  }
  return texts.join(" ");
}

// 提取 PDF 内嵌 JPEG 图片 (DCTDecode 流, 扫描件 PDF 的页面图), 供 OCR
export function extractPdfJpegs(buf) {
  const raw = buf.toString("latin1");
  const jpegs = [];
  const re = /\/DCTDecode[\s\S]{0,200}?stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const data = Buffer.from(m[1], "latin1");
    // JPEG 魔数 FFD8
    if (data.length > 2 && data[0] === 0xff && data[1] === 0xd8) jpegs.push(data);
  }
  return jpegs;
}

// HTML 转纯文本 (基础 strip, 与 advanced.js fetch_page 同思路)
function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// 按扩展名提取文档文本 (纯函数, 供 read_document 与 ingest_document 复用)
export function extractDocumentText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  const buf = fs.readFileSync(filePath);
  switch (ext) {
    case ".txt": case ".md": case ".csv": case ".json": case ".log":
      return buf.toString("utf8");
    case ".html": case ".htm":
      return htmlToText(buf.toString("utf8"));
    case ".pdf":
      return extractPdfText(buf);
    default:
      throw new Error(`不支持的文档类型: ${ext} (支持 txt/md/csv/json/html/pdf)`);
  }
}

// 分块: 按段落切, 每块约 chunkSize 字 (供 ingest 向量化)
export function splitChunks(text, chunkSize = 500) {
  const clean = String(text || "").replace(/\r/g, "");
  const paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + p).length > chunkSize && cur) {
      chunks.push(cur.trim());
      cur = p;
    } else {
      cur = cur ? cur + "\n" + p : p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter((c) => c.length >= 10);
}

// 从 config 构造 OCR 选项 (未显式关闭时默认启用本地 tesseract 自动 OCR)
function ocrOptsFromConfig(cfg) {
  const c = (cfg && cfg.ocr) || {};
  if (c.auto === false) return null; // 显式关闭自动 OCR
  return { tesseract: c.tesseract || "tesseract", lang: c.lang || "chi_sim", cloud: c.cloud || null };
}

// 读文档文本, PDF 无文本层(扫描件)时自动提取内嵌图片 OCR (_ocrFn 供测试注入)
export async function readDocumentText(filePath, ocrOpts, _ocrFn = ocrImage) {
  let text = extractDocumentText(filePath);
  if (path.extname(filePath).toLowerCase() === ".pdf" && !text.trim() && ocrOpts) {
    const jpegs = extractPdfJpegs(fs.readFileSync(filePath));
    if (jpegs.length) {
      const parts = [];
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ocr-pdf-"));
      try {
        for (let i = 0; i < jpegs.length; i++) {
          const tmp = path.join(tmpDir, `page-${i + 1}.jpg`);
          fs.writeFileSync(tmp, jpegs[i]);
          try { parts.push(await _ocrFn(tmp, ocrOpts)); } catch {}
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      text = parts.filter(Boolean).join("\n").trim();
    }
  }
  return text;
}

// 注册文档工具
export function registerDocumentTools(catalog, { rootDir }) {
  // 1. 读文档 (加载器, PDF 扫描件自动 OCR)
  catalog.register({
    name: "read_document",
    description: "读取本地文档并转纯文本。支持 .txt/.md/.json/.csv/.html/.pdf (文字型 PDF 直接提取, 扫描件 PDF 自动 OCR)。用于读文档/报告/数据文件后回答问题。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文档路径 (相对工作目录)" },
        maxChars: { type: "number", description: "返回最大字符数, 默认 20000" },
      },
      required: ["path"],
    },
    execute: async (args, ctx) => {
      try {
        const p = safePath(rootDir, args.path);
        const cfg = (ctx && ctx.agent && ctx.agent.config) || {};
        const text = await readDocumentText(p, ocrOptsFromConfig(cfg));
        const max = Math.min(args.maxChars || MAX_CHARS, 40000);
        const truncated = text.length > max ? text.slice(0, max) + `\n...[已截断, 共 ${text.length} 字符]` : text;
        return truncated || "(文档无文本内容, 且未识别出扫描件文字)";
      } catch (e) {
        return JSON.stringify({ error: "read_document 失败: " + e.message });
      }
    },
  });

  // 2. OCR 识别图片/扫描件文字
  catalog.register({
    name: "ocr_image",
    description: "识别图片或扫描件里的文字 (OCR)。需系统安装 tesseract (含中文语言包) 或配置 config.ocr 云 key。用于 read_image/read_document 读到图片却无法理解文字时。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "图片或扫描件路径 (相对工作目录)" },
        lang: { type: "string", description: "识别语言, 默认 chi_sim (中文)" },
      },
      required: ["path"],
    },
    execute: async (args, ctx) => {
      const agent = ctx && ctx.agent;
      const cfg = (agent && agent.config && agent.config.ocr) || {};
      try {
        const p = safePath(rootDir, args.path);
        const text = await ocrImage(p, {
          tesseract: cfg.tesseract || "tesseract",
          lang: args.lang || cfg.lang || "chi_sim",
          cloud: cfg.cloud || null,
        });
        return text || "(未识别出文字)";
      } catch (e) {
        return JSON.stringify({ error: "ocr_image 失败: " + e.message });
      }
    },
  });

  // 3. 文档入库 (RAG): 读文档 → 分块 → 存记忆 (带 scope 隔离)
  catalog.register({
    name: "ingest_document",
    description: "读取文档, 分块后写入长期记忆 (RAG 入库), 之后可被语义检索命中。scope 用于隔离文档来源 (如 '公司制度'/'项目文档'), 避免与其他记忆混淆。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文档路径 (相对工作目录)" },
        scope: { type: "string", description: "文档来源标签 (可选, 便于按来源检索)" },
      },
      required: ["path"],
    },
    execute: async (args, ctx) => {
      const agent = ctx && ctx.agent;
      if (!agent || !agent.facts) return JSON.stringify({ error: "ingest_document: 缺少 agent 上下文" });
      try {
        const p = safePath(rootDir, args.path);
        const text = await readDocumentText(p, ocrOptsFromConfig(agent.config));
        const chunks = splitChunks(text, 500);
        if (!chunks.length) return JSON.stringify({ error: "文档无可入库的文本 (可能是扫描件 PDF, 且 OCR 不可用)" });
        let added = 0;
        for (const c of chunks) {
          const f = agent.facts.add(c, { source: "document", scope: args.scope || null, dedupe: false });
          if (f) added++;
        }
        return JSON.stringify({ ok: true, chunks: chunks.length, added, scope: args.scope || null });
      } catch (e) {
        return JSON.stringify({ error: "ingest_document 失败: " + e.message });
      }
    },
  });

  return catalog;
}
