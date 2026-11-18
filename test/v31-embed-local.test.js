// test/v31-embed-local.test.js - v3.1 新能力: 本地向量降级 / 事实有效期 / VAD / JS 沙箱 / 本地 ASR 配置
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FactStore } from "../src/memory/fact-store.js";
import { createEmbedder } from "../src/llm/embedder.js";
import { runInSandbox, energyVad, parseWavPcm16 } from "../src/tools/index.js";
import { resolveVoice, resolveLocalAsr, voiceStatus } from "../src/tools/index.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-v31-"));
  return { dir, store: new FactStore(dir) };
}

// ---------- 1. 本地向量: 未安装可选包时优雅降级 ----------
test("local embedder: 包未安装时 embed 返回 null, querySemantic 降级回 BM25", async () => {
  const cfg = { backend: "local", model: "Xenova/multilingual-e5-small" };
  const embed = createEmbedder(cfg);
  assert.equal(typeof embed, "function", "backend=local 应返回 embedder 函数");
  const r = await embed("测试文本"); // transformers.js 未安装 → null (降级信号)
  assert.equal(r, null);
  // 挂到 FactStore 后语义检索不炸, 退化 BM25 (BM25 是词面检索, 用有字符交集的查询)
  const { dir, store } = tmpStore();
  try {
    store.setEmbedder(createEmbedder(cfg));
    store.add("用户喜欢 TypeScript", { importance: 10 });
    const hits = await store.querySemantic("喜欢 TypeScript 吗");
    assert.ok(hits.length >= 1, "降级路径仍应能 BM25 命中");
    assert.ok(hits[0].content.includes("TypeScript"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local embedder: cloud 后端行为不变 (缺 base_url/key 返回 null)", () => {
  assert.equal(createEmbedder({ backend: "cloud" }), null);
  assert.equal(createEmbedder({ base_url: "http://x" }), null, "无 key 应为 null");
  assert.equal(createEmbedder(null), null);
});

// ---------- 2. 事实有效期窗口 ----------
test("validity: validTo 已过期的事实默认不命中, includeExpired 可见", () => {
  const { dir, store } = tmpStore();
  try {
    const past = new Date(Date.now() - 86400000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    const ali = store.add("服务器部署在阿里云", { importance: 10 });
    store.add("服务器部署在腾讯云", { importance: 10, validFrom: past, validTo: future, supersedeId: ali.id }); // 现在有效, 收口旧事实
    store.add("服务器部署在华为云", { importance: 10, validTo: past }); // 已失效

    const hit = store.query("服务器 部署");
    const contents = hit.map((h) => h.content);
    assert.ok(contents.some((c) => c.includes("腾讯云")), "有效期内应命中");
    assert.ok(!contents.some((c) => c.includes("华为云")), "已过期默认不命中");
    assert.ok(!contents.some((c) => c.includes("阿里云")), "被 supersede 收口的旧事实不命中");

    // includeExpired: 治理检视可见
    const all = store.query("服务器 部署", { includeExpired: true });
    assert.ok(all.length >= 2, "includeExpired 应包含过期项");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validity: supersedeId 收口旧事实 validTo, 检索只回新事实", () => {
  const { dir, store } = tmpStore();
  try {
    const old = store.add("项目使用 React 16", { importance: 10 });
    assert.ok(old && old.id);
    store.add("项目使用 React 19", { importance: 10, supersedeId: old.id });
    // add 锁内会 _reload, 旧对象引用已失效 —— 用 list() 重新取最新状态断言
    const oldLatest = store.list().find((f) => f.id === old.id);
    assert.ok(oldLatest.validTo, "旧事实应被收口 validTo");
    const hit = store.query("React 版本");
    assert.ok(hit.some((h) => h.content.includes("React 19")));
    assert.ok(!hit.some((h) => h.content.includes("React 16")), "被取代旧事实不命中");
    // 旧事实仍在库 (可审计), list 可见
    assert.ok(store.list().some((f) => f.content.includes("React 16")), "治理 list 仍可见");
    assert.ok(store.listOutOfWindow().some((f) => f.id === old.id), "listOutOfWindow 应列出");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validity: setValidity 可重新开放/收口, 未到期(validFrom 未来)不命中", () => {
  const { dir, store } = tmpStore();
  try {
    const f = store.add("灰度发布已开启", { importance: 10 });
    // 收口
    store.setValidity(f.id, { validTo: new Date(Date.now() - 1000) });
    assert.ok(!store.query("灰度 发布").some((h) => h.id === f.id));
    // 重新开放 (清掉 validTo)
    store.setValidity(f.id, { validTo: null });
    assert.ok(store.query("灰度 发布").some((h) => h.id === f.id));
    // 未生效
    const g = store.add("新功能已上线", { importance: 10, validFrom: new Date(Date.now() + 86400000) });
    assert.ok(!store.query("新功能 上线").some((h) => h.id === g.id), "未生效不命中");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validity: 旧数据无字段 = 永久有效, 兼容不回归", () => {
  const { dir, store } = tmpStore();
  try {
    store.add("永久有效的老事实", { importance: 10 });
    assert.ok(store.query("老事实").length >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 3. JS 沙箱 ----------
test("sandbox: 数学计算 + console 捕获 + 返回值", async () => {
  const r = await runInSandbox("const x = 6*7; console.log('计算中'); x");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result, 42);
  assert.deepEqual(r.logs, ["[log] 计算中"]);
});

test("sandbox: 死循环超时强杀, 主进程不受影响", async () => {
  const r = await runInSandbox("while(true){}", { timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.match(r.error, /超时|timed out/i, `实际: ${r.error}`);
}, { timeout: 15000 });

test("sandbox: 抛错带错误信息", async () => {
  const r = await runInSandbox("throw new TypeError(' boom')");
  assert.equal(r.ok, false);
  assert.match(r.error, /TypeError/);
});

// ---------- 4. VAD (能量版, 零依赖) ----------
function makeWav({ sampleRate = 16000, parts } ) {
  // parts: [{ms, level}] level 0~1 (正弦波振幅); 0=静音
  const chunks = [];
  for (const p of parts) {
    const n = Math.round((sampleRate * p.ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const v = p.level === 0 ? 0 : Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * p.level * 32767);
      buf.writeInt16LE(v, i * 2);
    }
    chunks.push(buf);
  }
  const pcm = Buffer.concat(chunks);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return { buffer: Buffer.concat([header, pcm]), sampleRate, pcm };
}

test("vad: 静音-语音-静音 切出正确片段 (energy 后端)", () => {
  const { buffer, sampleRate, pcm } = makeWav({ parts: [{ ms: 500, level: 0 }, { ms: 800, level: 0.5 }, { ms: 500, level: 0 }] });
  const wav = parseWavPcm16(buffer);
  assert.equal(wav.sampleRate, sampleRate);
  const mono = new Float32Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < mono.length; i++) mono[i] = pcm.readInt16LE(i * 2) / 32768;
  const r = energyVad(mono, { sampleRate });
  assert.equal(r.backend, "energy");
  assert.ok(r.segments.length === 1, `应切出 1 段, 实际 ${JSON.stringify(r.segments)}`);
  const seg = r.segments[0];
  assert.ok(seg.startMs > 300 && seg.startMs < 700, `起始应在静音后: ${seg.startMs}`);
  assert.ok(seg.endMs > 1100 && seg.endMs < 1500, `结束应接近语音尾部: ${seg.endMs}`);
  assert.ok(r.speechRatio > 0.3 && r.speechRatio < 0.7);
});

test("vad: 全静音音频切出 0 段", () => {
  const { buffer } = makeWav({ parts: [{ ms: 1000, level: 0 }] });
  const wav = parseWavPcm16(buffer);
  const mono = new Float32Array(Math.floor(wav.samples.length / 2));
  for (let i = 0; i < mono.length; i++) mono[i] = wav.samples.readInt16LE(i * 2) / 32768;
  const r = energyVad(mono, { sampleRate: wav.sampleRate });
  assert.equal(r.segments.length, 0);
  assert.equal(r.speechRatio, 0);
});

// ---------- 5. 本地 ASR 配置 ----------
test("voice: backend=local 时 resolveVoice 返回 null, resolveLocalAsr 生效", () => {
  const localCfg = { voice: { asr: { backend: "local", model: "small", language: "zh" } } };
  assert.equal(resolveVoice(localCfg, "asr"), null, "local 不走云端解析");
  const lo = resolveLocalAsr(localCfg);
  assert.ok(lo);
  assert.equal(lo.model, "small");
  assert.equal(lo.defaultLanguage, "zh");
  assert.equal(voiceStatus(localCfg).asr, "local");
  // 云端配置不受影响
  const cloudCfg = { voice: { asr: { base_url: "http://x/v1", api_key: "k" } } };
  assert.ok(resolveVoice(cloudCfg, "asr"));
  assert.equal(resolveLocalAsr(cloudCfg), null);
  assert.equal(voiceStatus(cloudCfg).asr, true);
  assert.equal(voiceStatus({}).asr, false);
});
