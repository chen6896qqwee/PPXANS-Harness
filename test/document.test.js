// test/document.test.js - 文档加载器 + embedding + RAG 入库
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { extractDocumentText, extractPdfText, extractPdfJpegs, splitChunks, readDocumentText, registerDocumentTools } from "../src/tools/document.js";
import { createEmbedder } from "../src/llm/embedder.js";
import { ToolCatalog } from "../src/tools/catalog.js";

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-doc-")); }

// 构造一个含 FlateDecode 压缩文本的 PDF
function makePdf(text) {
  const content = `BT (${text}) Tj ET`;
  const compressed = zlib.deflateSync(Buffer.from(content, "utf8"));
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 100 /Filter /FlateDecode >>\nstream\n", "latin1"),
    compressed,
    Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
}

test("extractDocumentText: txt/md 直接读", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "a.md"), "# 标题\n\n正文内容 hello");
  assert.ok(extractDocumentText(path.join(root, "a.md")).includes("正文内容"));
});

test("extractDocumentText: html 去标签", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "a.html"), "<html><body><h1>标题</h1><p>段落文字</p><script>var x=1</script></body></html>");
  const t = extractDocumentText(path.join(root, "a.html"));
  assert.ok(t.includes("段落文字"));
  assert.ok(!t.includes("var x=1"), "script 应被剥离");
});

test("extractPdfText: FlateDecode 压缩 PDF 提取文本", () => {
  const pdf = makePdf("Hello PDF World 皮皮虾");
  const t = extractPdfText(pdf);
  assert.ok(t.includes("Hello PDF World"), `应提取文本, 实际: ${t}`);
});

test("extractDocumentText: 不支持类型报错", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "a.docx"), "x");
  assert.throws(() => extractDocumentText(path.join(root, "a.docx")), /不支持的文档类型/);
});

test("splitChunks: 长文按段落分块", () => {
  const paras = Array.from({ length: 10 }, (_, i) => `第${i}段：` + "字".repeat(120)).join("\n\n");
  const chunks = splitChunks(paras, 300);
  assert.ok(chunks.length >= 4, `应分多块, 实际 ${chunks.length}`);
  assert.ok(chunks.every((c) => c.length >= 10));
});

test("read_document 工具: 读文档返回文本", async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "note.txt"), "这是文档内容 ABC");
  const catalog = new ToolCatalog();
  registerDocumentTools(catalog, { rootDir: root });
  const r = await catalog.call("read_document", { path: "note.txt" });
  assert.ok(r.includes("文档内容 ABC"), `应返回内容, 实际: ${r}`);
});

test("ingest_document 工具: 文档分块入库 (带 scope)", async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "report.txt"), Array.from({ length: 8 }, (_, i) => `段落${i}：` + "内容".repeat(60)).join("\n\n"));
  const catalog = new ToolCatalog();
  registerDocumentTools(catalog, { rootDir: root });
  const added = [];
  const agent = {
    facts: { add: (c, opts) => { added.push({ c, opts }); return { id: "f" + added.length }; } },
  };
  const r = await catalog.call("ingest_document", { path: "report.txt", scope: "测试" }, { agent });
  const j = JSON.parse(r);
  assert.equal(j.ok, true);
  assert.ok(j.added >= 2, `应入库多块, 实际 ${j.added}`);
  assert.ok(added.every((x) => x.opts.scope === "测试"), "应带 scope");
  assert.ok(added.every((x) => x.opts.source === "document"), "source 应为 document");
});

test("extractPdfJpegs: 提取 DCTDecode JPEG 流", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Width 1 /Height 1 >>\nstream\n", "latin1"),
    jpeg,
    Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
  const jpegs = extractPdfJpegs(pdf);
  assert.equal(jpegs.length, 1);
  assert.equal(jpegs[0][0], 0xff, "应提取 JPEG 字节");
  assert.equal(jpegs[0][1], 0xd8);
});

test("readDocumentText: 扫描件 PDF 自动 OCR (注入 mock)", async () => {
  const root = tmpRoot();
  // 构造无文本层、含 JPEG 的扫描 PDF
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /DCTDecode >>\nstream\n", "latin1"),
    jpeg,
    Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
  const f = path.join(root, "scan.pdf");
  fs.writeFileSync(f, pdf);
  const mockOcr = async () => "OCR识别出的扫描件文字";
  const text = await readDocumentText(f, { tesseract: "tesseract", lang: "chi_sim" }, mockOcr);
  assert.ok(text.includes("OCR识别出的扫描件文字"), `应自动 OCR, 实际: ${text}`);
});

test("readDocumentText: 文字型 PDF 不触发 OCR", async () => {
  const root = tmpRoot();
  const pdf = makePdf("这是文字型PDF内容");
  const f = path.join(root, "text.pdf");
  fs.writeFileSync(f, pdf);
  let ocrCalled = false;
  const mockOcr = async () => { ocrCalled = true; return "不应被调用"; };
  const text = await readDocumentText(f, { tesseract: "t" }, mockOcr);
  assert.ok(text.includes("文字型PDF内容"), "应直接提取文字");
  assert.equal(ocrCalled, false, "文字型 PDF 不应触发 OCR");
});

test("createEmbedder: 无 config / 无 key 返回 null", () => {
  assert.equal(createEmbedder(null), null);
  assert.equal(createEmbedder({}), null);
  assert.equal(createEmbedder({ base_url: "https://x/v1" }), null); // 缺 key
});

test("createEmbedder: 有 key 返回 embed 函数, mock fetch 测向量", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.match(url, /\/embeddings$/);
    return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
  };
  try {
    const embed = createEmbedder({ base_url: "https://x/v1", api_key: "k", model: "m" });
    assert.ok(typeof embed === "function");
    const v = await embed("hello");
    assert.deepEqual(v, [0.1, 0.2, 0.3]);
  } finally {
    globalThis.fetch = orig;
  }
});
