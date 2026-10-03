import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PPXAgent } from '../src/agent/index.js';

const root = process.cwd();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppx-ctx-'));
const a = new PPXAgent({ root, dataDir });

// 粗估 token: 中文按 1 字 1 token, 其余按 4 字符 1 token
const est = (s) => {
  const t = String(s || '');
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(cjk + (t.length - cjk) / 4);
};
const line = (label, s) => {
  const chars = String(s || '').length;
  console.log('  ' + label.padEnd(28) + String(chars).padStart(8) + ' 字符   ≈' + String(est(s)).padStart(7) + ' tok');
  return est(s);
};

console.log('=== 单次请求的上下文构成 (空会话, 无历史) ===\n');

// 1. 工具 schema (每次请求都要带)
const tools = a.tools.toOpenAI();
const toolJson = JSON.stringify(tools);
const tTools = line(`工具 schema (${tools.length} 个)`, toolJson);

// 2. system prompt / 上下文注入
let ctx = '';
try { ctx = a._context('随便问个问题'); } catch (e) { ctx = '(调用失败: ' + e.message + ')'; }
const tCtx = line('_context() 全部注入', ctx);

// 3. 记忆/经验注入部分
const parts = {};
for (const [name, key] of [['记忆', 'memory'], ['经验', 'experience'], ['人格', 'persona']]) {
  try {
    const v = a.ctx.consume(key);
    if (v && typeof v.context === 'function') parts[name] = v.context('测试问题');
  } catch {}
}
console.log('');
for (const [k, v] of Object.entries(parts)) line('  └ ' + k + ' 注入', v);

console.log('\n=== 合计 ===');
const total = tTools + tCtx;
console.log('  固定开销 ≈ ' + total + ' tok/请求');
console.log('  对照实测: 基线平均 17836 tok/任务 (含多轮工具循环)');

// 4. 最大的单个工具 schema
console.log('\n=== 工具 schema TOP 10 (按描述长度) ===');
const sized = tools.map((t) => ({
  name: t.function.name,
  tok: est(JSON.stringify(t)),
  descLen: (t.function.description || '').length,
})).sort((x, y) => y.tok - x.tok);
for (const s of sized.slice(0, 10)) console.log('  ' + s.name.padEnd(24) + '≈' + String(s.tok).padStart(5) + ' tok  (描述 ' + s.descLen + ' 字)');

console.log('\n=== _context() 分节拆解 ===');
const blocks = ctx.split(/\n(?=【)/).map((b) => [b.slice(0, 24).replace(/\n/g, ' '), b]);
for (const [head, body] of blocks.sort((x, y) => y[1].length - x[1].length).slice(0, 12)) {
  console.log('  ' + String(est(body)).padStart(6) + ' tok  ' + head);
}

a.shutdown();
fs.rmSync(dataDir, { recursive: true, force: true });
