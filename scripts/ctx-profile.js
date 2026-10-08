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

// --check: 把"固定开销"变成 CI 闸门, 而不是等人记得手跑
//   动机: 这段开销每个请求都要付一次, 工具描述/人格/技能清单一行注释就能让它悄悄涨几百 tok。
//   超预算即非零退出; 预算可用 --max-tokens 覆盖。
//
//   预算沿革 (每次调整都要写清涨在哪, 否则闸门会退化成"涨了就改数字"):
//     4000 → 4500 (2026-10-0X): 渐进披露工具 + 技能清单后实测 3976
//     → 5800 (2026-10-07 全能超级 Agent): 实测 5351。增量已逐项压过价, 明细:
//        +1260  多 Agent 协作进入核心 schema (spawn_agent 656 / legion_status 114 / team_list ~90,
//               外加披露这些的工具名) —— 协作能力此前半隐身, 不常驻等于不能用
//        +483   【能力边界】护栏常驻 (医疗/法律/金融/安全/合规人类监督 + 六条硬边界)
//        +354   【可用技能】名册改为**全量**按域分组 (56 个技能, 只有名字)
//        -903   同名册不再常驻全员描述 (旧版 1257 tok) —— 描述移交 skill_search 按需取
//        -683   spawn_agent 参数描述瘦身 (专家/班组名册内联 → 指向 expert_list/team_list 工具)
//     → 5395 (2026-10-07 评估报告 P1-4): 增量已逐项压过价, 明细:
//        +40    【能力边界】兜底条款常驻 ("判断不清是否属于高风险域时, 按属于处理")。
//               关键词护栏天然可绕过 —— 换个说法就不命中, 这条不依赖任何词表, 是绕过时的最后一道网。
//               付得起的原因: 40 tok 换的是"漏报一次医疗/法律建议"的期望成本, 数量级不对等。
//     仍然付得起的原因: 固定开销占单任务实测 (~17836 tok) 的 30%, 而省下的正是"要多花两三轮工具
//     调用才能问清'有什么技能/能派几个 agent'"的那部分。
const CONTEXT_BUDGET_TOKENS = 5800;
const checkIdx = process.argv.indexOf('--check');
if (checkIdx >= 0) {
  const mIdx = process.argv.indexOf('--max-tokens');
  const maxTok = mIdx >= 0 ? Number(process.argv[mIdx + 1]) : CONTEXT_BUDGET_TOKENS;
  if (!Number.isFinite(maxTok) || maxTok <= 0) {
    console.error('  ✗ --max-tokens 需要一个正整数');
    process.exitCode = 2;
  } else if (total > maxTok) {
    console.error(`  ✗ 固定开销 ${total} tok 超过预算 ${maxTok} tok —— 检查新增的工具描述/注入段落`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ 固定开销 ${total} tok <= 预算 ${maxTok} tok`);
  }
}

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

await a.shutdown();
fs.rmSync(dataDir, { recursive: true, force: true });
