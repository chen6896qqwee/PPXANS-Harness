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

// 2026-10-11: 【工作目录】注入的是真实绝对路径, 测量值随 checkout 路径长度漂移
//   (本地 13893 vs CI windows 13884, 差 9 tok)。闸门量的是"固定开销", 不是本机路径 ——
//   测量前做路径归一化: root → <ROOT>, 其余绝对路径 (Windows 盘符/UNC 与 POSIX 家目录/tmp)
//   → <PATH> 占位符。占位符定长, 任何机器/任何 checkout 路径下数字一致。
//   (第一版只归一 root, CI windows 实测仍差 6 tok —— tmpdir 等非 root 路径也会漏进来, 故用通用规则)
const norm = (s) => String(s || '')
  .split(root).join('<ROOT>')
  .replace(/([A-Za-z]:[/\\]|\\\\)[^\s"'\n]+/g, '<PATH>')
  .replace(/(^|[\s"'=(])\/(?:home|Users|root|tmp|var)\/[^\s"'\n]+/g, '$1<PATH>');

// 1. 工具 schema (每次请求都要带)
const tools = a.tools.toOpenAI();
const toolJson = JSON.stringify(tools);
const tTools = line(`工具 schema (${tools.length} 个)`, norm(toolJson));

// 2. system prompt / 上下文注入
let ctx = '';
try { ctx = a._context('随便问个问题'); } catch (e) { ctx = '(调用失败: ' + e.message + ')'; }
const tCtx = line('_context() 全部注入', norm(ctx));

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
//     → 13900 (2026-10-11): 实测 13893。近 4 天工具 86→89、技能名册 66 个、九大新层
//       (protocol/session/permissions/hooks/edit/repomap/review/evidence/commands) 全部常驻核心 schema,
//       固定开销 5395 → 13893 (+157%)。TOP 开销: 工具 schema 合计约 1.1 万 tok
//       (spawn_agent 1105 / skill_import 382 / plan_files 312 …) + 【能力边界】1129 + 【可用技能】423。
//       不玩“涨了就改数字”: 显式上调并在此冻结; 后续若要压回, 优先瘦身上述最贵工具描述与技能名册。
//     → 14000 (2026-10-11 下午): 路径归一化后实测 13879 (ubuntu 与本地一致), 但 Windows runner
//       仍有 ~6 tok 机器残差 (hostname/用户名类注入, 归一化覆盖不到)。+100 为跨机器噪声余量,
//       闸门语义不变 —— 真增长(一段工具描述数百 tok)依然直接红; 真减债时把余量撤掉。
//     → 14500 (2026-10-27 自改代码批次): 实测 14462。增量明细 (+469):
//         self_edit 237 / self_verify ~130 / self_rewind ~100 tok。
//       已做的压缩: 原设计 5 个工具 (self_edit/self_verify/self_rewind/self_ledger/self_pending_ack)
//         压到 3 个 —— self_ledger 并入 evolution_status (同属"变强有账可查", 复用一份 schema),
//         self_pending_ack 并入 `npm run selfcode -- ack`; self_edit 描述 189 字 → 132 字。
//       付得起的理由: 没有这三个工具, agent 对自身代码只能"建议改哪里"而不能真改 ——
//         自主性的最后一段路就在这里; 每次落盘前留备份的代价换来的是"改坏了能一键退回"。
//       后续若要压回, 优先把 SEARCH/REPLACE 格式说明移出 schema, 改由 SKILL 按需加载。
//     → 14500 保持 (2026-10-30 工具循环加固): 实测 14447, 加了一个工具但净额几乎没动。
//        +tool_schema ~100 tok (按需工具模式的配套件: 名字 → schema 的那条路, 没有它收窄就是死路)
//        -spawn_agent 描述 103→53 tok / -code_run 87→57 / -skill_import 98→82 / -vad_detect 62→52
//        / -team_room_open 106→78 —— 删的都是"描述里逐条复述参数语义"的重复部分 (参数表里已经写了)。
//       预算没涨, 但压力变了: 现在多了一个 **agent.tool_exposure = "core"** 的开关, 收窄后固定开销
//       约 4.6k tok (见下方"曝光收窄"段)。闸门仍按默认 all 模式卡 14500 —— 默认行为不变才谈得上闸门。
//     → 14800 (2026-10-30 身体批次): 实测 14,725。增量明细 (+278):
//        +task_stack 277 —— 「手头的事」这层的唯一入口 (跨轮任务栈; 被打断/上下文压缩后
//          还能接上, 不必每轮从 memory/turns 归档里猜"上一件事做到哪了")。
//        付得起的理由: ① 它换掉的是模型**重新探索**的那几轮 (每轮都是工具调用 + 上下文);
//          ② [手头的事] prompt 段在空栈时是空串 (零 token), 有任务时也就 30~60 tok;
//          ③ 该段落在动态区, 不参与静态前缀, 加任务不会作废 provider 缓存。
//        已做的压缩: task_stack 参数描述全部压到一行 (8 个参数共 ~250 tok, 无法再砍 —
//          参数表本身就是它的能力面)。若将来要压回 14500, 优先砍 spawn_agent (857 tok)。
//     → 15000 (2026-10-30 发布批次总账): 实测 14,962。增量明细 (+162):
//        本批次 (v3.5.0 "前端换骨+自改代码闭环" 收尾) 相对 14800 定额时的实测 14,725 净增 ~237 tok:
//          task_stack +277 (见上段 14800 账) / tool_schema +~100 (按需工具配套, 见 14500 段)
//          / selfcode+selfmod 描述扩写与 lexicon 会话注入 ~-140 (既有工具压缩对冲后净额)。
//        付得起的理由: ① tool_schema 是 tool_exposure 收窄 (省 61%) 能成立的配套件;
//          ② task_stack 是「手头的事」唯一入口 (见上段); ③ 削减路径已评估 ——
//          spawn_agent 857 tok 大头是 15 个参数 schema (能力面), 且描述为 2026-10-25
//          "参数可发现性" 修复的产物, 再压有回归风险。若将来压回, 优先:
//          a) spawn_agent 参数描述逐条压缩 (~60 tok); b) plan_files 312 tok 段并入 SKILL 按需加载。
const CONTEXT_BUDGET_TOKENS = 15000;
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

// 5. 曝光收窄的账 (agent.tool_exposure = "core", 2026-10-30)
//    这笔账以前只写在文档散文里, 现在让闸门脚本自己算: 长尾工具每轮都在付 schema 钱。
//    默认仍是 all —— 这里只报"如果收窄能省多少", 不改变任何默认行为。
try {
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ppx-ctx-core-'));
  const a2 = new PPXAgent({ root, dataDir: dataDir2 });
  a2.config.agent.tool_exposure = 'core';
  a2._applyToolExposure();
  const tools2 = a2.tools.toOpenAI();
  const ctx2 = a2._context('随便问个问题');
  const t2 = est(norm(JSON.stringify(tools2)));
  const s2 = est(norm(ctx2));
  const slim = t2 + s2;
  console.log('\n=== 曝光收窄 (tool_exposure="core") 能省多少 ===');
  console.log('  下发工具数         ' + String(tools2.length).padStart(6) + '   (all 模式 ' + tools.length + ' 个)');
  console.log('  降级为按需         ' + String(a2.tools.hiddenFromLLM().length).padStart(6) + ' 个  (名字进 system, schema 不进请求, 用 tool_schema 现取)');
  console.log('  固定开销           ' + String(slim).padStart(6) + ' tok  (all 模式 ' + total + ' tok, 省 ' + (total - slim) + ' tok / '
    + Math.round((1 - slim / total) * 100) + '%)');
  await a2.shutdown();
  fs.rmSync(dataDir2, { recursive: true, force: true });
} catch (e) {
  console.log('\n  (曝光对比测量失败, 不影响闸门: ' + e.message + ')');
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
// 按【区块头 与 顶层 markdown # 标题 切块: persona / 画像 无【前缀, 若只按【切会被并入
//   【能力边界】块, 虚报后者 tok (2026-10-11 修正测量假象; 与闸门无关——闸门只认 total)。
const blocks = ctx.split(/\n(?=【|# )/).map((b) => [b.slice(0, 24).replace(/\n/g, ' '), b]);
for (const [head, body] of blocks.sort((x, y) => y[1].length - x[1].length).slice(0, 12)) {
  console.log('  ' + String(est(body)).padStart(6) + ' tok  ' + head);
}

await a.shutdown();
fs.rmSync(dataDir, { recursive: true, force: true });
