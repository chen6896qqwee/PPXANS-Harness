// test/multimodal.test.js - 多模态: read_image 工具 + 图片结果透传
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerBuiltinTools, imageFileToDataUrl } from "../src/tools/builtin.js";
import { ToolCatalog } from "../src/tools/catalog.js";
import { toToolContent, PPXAgent } from "../src/agent/index.js";

// 1x1 透明 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("read_image: 读取图片返回 base64 data URL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-img-"));
  fs.writeFileSync(path.join(root, "a.png"), PNG);
  const catalog = new ToolCatalog();
  registerBuiltinTools(catalog, { rootDir: root, facts: null, memory: null });
  const res = await catalog.call("read_image", { path: "a.png" });
  assert.ok(res.startsWith("data:image/png;base64,"), `应返回 data URL, 实际: ${res.slice(0, 40)}`);
});

test("read_image: 不支持的文件类型报错", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-img-"));
  fs.writeFileSync(path.join(root, "b.txt"), "hello");
  const catalog = new ToolCatalog();
  registerBuiltinTools(catalog, { rootDir: root, facts: null, memory: null });
  const res = await catalog.call("read_image", { path: "b.txt" });
  assert.ok(res.includes("不支持"), `应报错, 实际: ${res}`);
});

test("toToolContent: 图片 data URL 转 image_url 内容块", () => {
  const c = toToolContent("data:image/png;base64,abc123");
  assert.ok(Array.isArray(c), "应转为数组");
  assert.equal(c[0].type, "image_url");
  assert.equal(c[0].image_url.url, "data:image/png;base64,abc123");
});

test("toToolContent: 普通文本保持字符串", () => {
  assert.equal(toToolContent("hello"), "hello");
  assert.equal(toToolContent(123), "123");
});

test("imageFileToDataUrl: 读图转 data URL, 越界/非图片报错", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-img2-"));
  fs.writeFileSync(path.join(root, "a.png"), PNG);
  assert.ok(imageFileToDataUrl(root, "a.png").startsWith("data:image/png;base64,"));
  fs.writeFileSync(path.join(root, "b.txt"), "hi");
  assert.throws(() => imageFileToDataUrl(root, "b.txt"), /不支持的文件类型/);
  assert.throws(() => imageFileToDataUrl(root, "missing.png"), /文件不存在/);
});

test("_userContent: vision provider 时注入 image_url 块", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-img3-"));
  fs.writeFileSync(path.join(root, "a.png"), PNG);
  const agent = new PPXAgent({ root });
  agent.llm = { backend: "http", vision: true };
  agent.allProviders = [];
  const content = agent._userContent("看这张图 a.png 里有什么");
  assert.ok(Array.isArray(content), "有图且 vision 时应返回数组");
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image_url");
  assert.ok(content[1].image_url.url.startsWith("data:image/png;base64,"));
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("_userContent: 无 vision provider 时返回纯文本", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-img4-"));
  fs.writeFileSync(path.join(root, "a.png"), PNG);
  const agent = new PPXAgent({ root });
  agent.llm = { backend: "openclaw", vision: false };
  agent.allProviders = [];
  assert.equal(agent._userContent("看这张图 a.png"), "看这张图 a.png");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("_visionLLM: 当前非 vision 时从 allProviders 找 vision provider", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-img5-"));
  const agent = new PPXAgent({ root });
  agent.llm = { backend: "openclaw", vision: false };
  agent.allProviders = [{ backend: "openclaw", vision: false }, { backend: "http", vision: true, model: "qwen-vl-max" }];
  const v = agent._visionLLM();
  assert.ok(v && v.vision === true, "应从 allProviders 找到 vision provider");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
