// test/ocr.test.js - OCR (tesseract 主通道 + 云回退)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tesseractAvailable, ocrWithTesseract, ocrImage } from "../src/tools/ocr.js";
import { registerDocumentTools } from "../src/tools/document.js";
import { ToolCatalog } from "../src/tools/catalog.js";

test("tesseractAvailable: 真实检测本地 tesseract", async () => {
  // 本机已装 tesseract (C:/Program Files/Tesseract-OCR), 若未装此测试仍不崩 (返回 false)
  const ok = await tesseractAvailable();
  assert.equal(typeof ok, "boolean");
});

test("ocrWithTesseract: 注入 _exec 测识别逻辑", async () => {
  const fakeExec = async (bin, args) => {
    assert.ok(args.includes("stdout"), "应输出到 stdout");
    return { stdout: "识别出的中文文字", stderr: "" };
  };
  const text = await ocrWithTesseract("/tmp/a.png", { _exec: fakeExec });
  assert.equal(text, "识别出的中文文字");
});

test("ocrImage: tesseract 可用走本地, 不用云", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ocr-"));
  const f = path.join(root, "a.png");
  fs.writeFileSync(f, "fake");
  const fakeExec = async (bin, args) => {
    if (args.includes("--version")) return { stdout: "tesseract 5.5", stderr: "" };
    return { stdout: "本地OCR结果", stderr: "" };
  };
  const text = await ocrImage(f, { _exec: fakeExec });
  assert.equal(text, "本地OCR结果");
});

test("ocrImage: tesseract 不可用回退云 OCR (mock fetch)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ocr2-"));
  const f = path.join(root, "a.png");
  fs.writeFileSync(f, "fake");
  const fakeExec = async () => { throw new Error("not found"); }; // tesseract 不可用
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.includes("/token")) return { json: async () => ({ access_token: "AT_1" }) };
    return { json: async () => ({ words_result: [{ words: "云端识别文字" }] }) };
  };
  try {
    const text = await ocrImage(f, { _exec: fakeExec, cloud: { apiKey: "k", secretKey: "s" } });
    assert.equal(text, "云端识别文字");
  } finally {
    globalThis.fetch = orig;
  }
});

test("ocrImage: 都不可用抛中文引导", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ocr3-"));
  const f = path.join(root, "a.png");
  fs.writeFileSync(f, "fake");
  const fakeExec = async () => { throw new Error("not found"); };
  await assert.rejects(() => ocrImage(f, { _exec: fakeExec }), /OCR 不可用/);
});

test("ocr_image 工具: 注册且路径越界拒绝", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ocr4-"));
  const catalog = new ToolCatalog();
  registerDocumentTools(catalog, { rootDir: root });
  const r = await catalog.call("ocr_image", { path: "../etc/passwd" }, { agent: { config: {} } });
  assert.ok(r.includes("越界") || r.includes("失败"), `越界应被拒, 实际: ${r}`);
});
