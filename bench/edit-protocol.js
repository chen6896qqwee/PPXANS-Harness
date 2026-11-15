// bench/edit-protocol.js - 编辑协议成本基准 (2026-11-13)
//
// 目的: 把"锚点编辑省 token"从**论点**变成**可复算的数字**。
//
// 量的是什么 (别误读): 协议本身的**信息成本** —— 模型为了表达一次编辑, 必须输出多少字符。
//   · SEARCH/REPLACE: 旧内容原样 + 新内容 + 分隔标记
//   · 锚点: 行锚点 + 新内容
// 不量模型行为 (会不会写错、要不要重试), 那得有真模型跑 A/B。所以这里的数字是
// "表达成本的下界", 不是"实测省了多少"。
//
// 同时算清楚**读侧代价**: 锚点视图每行要带 `行号#hash| ` 前缀, 这是纯额外开销。
// 只算编辑侧会得出"锚点永远赢"的假结论 —— 净收益 = 编辑侧省下的 − 读侧多付的。
import { estimateTokens } from "../src/utils/text.js";

// 一次编辑任务的形状 (全部可离线复算, 不依赖模型)
//   fileLines    文件总行数
//   readLines    模型为这次编辑实际读了哪些行 (区间)
//   old          将被替换的旧内容 (真实文本, 不是占位符)
//   next         新内容
//   edits        同一批要做几处 (锚点可一次批量提交; patch 也可以, 但要各自带 SEARCH)
export const EDIT_TASKS = [
  {
    id: "one-short-line",
    desc: "改一行配置值 (短行), 只读局部 30 行",
    fileLines: 300, readLines: 30,
    old: '  retry_max: 3,',
    next: '  retry_max: 5,',
    edits: 1,
  },
  {
    id: "one-long-line",
    desc: "改一行长表达式 (SQL/正则, 约 180 字符), 读局部 20 行",
    fileLines: 240, readLines: 20,
    old: "  const SQL = \"SELECT id, name, email, created_at, updated_at, status, tenant_id FROM accounts WHERE tenant_id = ? AND status IN ('active','pending') AND created_at > ? ORDER BY created_at DESC LIMIT 200\";",
    next: "  const SQL = \"SELECT id, name, email, created_at, updated_at, status, tenant_id FROM accounts WHERE tenant_id = ? AND status IN ('active','pending','paused') AND created_at > ? ORDER BY created_at DESC LIMIT 500\";",
    edits: 1,
  },
  {
    id: "rewrite-function-40",
    desc: "整段重写一个 40 行函数, 读 60 行",
    fileLines: 420, readLines: 60,
    old: Array.from({ length: 40 }, (_, i) => `  // 旧实现第 ${i + 1} 行: 这里是原有的业务逻辑与边界处理`).join("\n"),
    next: Array.from({ length: 28 }, (_, i) => `  // 新实现第 ${i + 1} 行: 简化后的逻辑`).join("\n"),
    edits: 1,
  },
  {
    id: "rewrite-block-200",
    desc: "重写 200 行片段 (大重构), 读整段",
    fileLines: 900, readLines: 200,
    old: Array.from({ length: 200 }, (_, i) => `    step${i + 1}: () => handleStep(${i + 1}), // 旧的编排步骤`).join("\n"),
    next: Array.from({ length: 200 }, (_, i) => `    step${i + 1}: () => run(${i + 1}), // 新编排`).join("\n"),
    edits: 1,
  },
  {
    id: "five-small-edits",
    desc: "同一文件里批量改 5 处小地方, 读 100 行",
    fileLines: 500, readLines: 100,
    old: Array.from({ length: 5 }, (_, i) => `  const timeout${i + 1} = 3000;`).join("\n"),
    next: Array.from({ length: 5 }, (_, i) => `  const timeout${i + 1} = 8000;`).join("\n"),
    edits: 5,
  },
  {
    id: "delete-10-lines",
    desc: "删掉 10 行死代码, 读 50 行",
    fileLines: 260, readLines: 50,
    old: Array.from({ length: 10 }, (_, i) => `  // legacy hack ${i + 1}: 待清理`).join("\n"),
    next: "",
    edits: 1,
  },
];

// SEARCH/REPLACE 协议下, 模型要输出的编辑载荷
export function patchPayload(task) {
  const blocks = Array.from({ length: task.edits }, () => `<<<<<<< SEARCH\n${task.old}\n=======\n${task.next}\n>>>>>>> REPLACE`);
  return blocks.join("\n");
}

// 锚点协议下, 模型要输出的载荷 (JSON 形态, 锚点用 4 字符占位 —— 与真实长度一致)
export function anchorPayload(task) {
  const edits = Array.from({ length: task.edits }, (_, i) => ({ anchor: (1000 + i).toString(36).slice(0, 4).padStart(4, "0"), content: i === 0 ? task.next : "…" }));
  return JSON.stringify({ path: "src/file.js", edits });
}

// 读侧额外开销: 锚点视图每行多出 `行号#hash| ` (行号位数 + 1 + 4 + 2)
export function readTaxChars(task) {
  const digits = String(task.fileLines).length;
  return task.readLines * (digits + 1 + 4 + 2);
}

export function measureTask(task) {
  const patchEdit = patchPayload(task);
  const anchorEdit = anchorPayload(task);
  const tax = readTaxChars(task);
  const patchTotal = patchEdit.length;
  const anchorTotal = anchorEdit.length + tax;
  return {
    id: task.id,
    desc: task.desc,
    edits: task.edits,
    readLines: task.readLines,
    patchChars: patchEdit.length,
    anchorChars: anchorEdit.length,
    readTax: tax,
    patchTotal,
    anchorTotal,
    netDelta: anchorTotal - patchTotal, // 负数 = 锚点净省
    anchorRatio: Number((anchorTotal / Math.max(1, patchTotal)).toFixed(3)),
    patchTokens: estimateTokens(patchEdit),
    anchorTokens: estimateTokens(anchorEdit) + estimateTokens(" ".repeat(tax)),
  };
}

export function summarize(tasks = EDIT_TASKS) {
  const rows = tasks.map(measureTask);
  const total = { patch: 0, anchor: 0 };
  for (const r of rows) { total.patch += r.patchTotal; total.anchor += r.anchorTotal; }
  return {
    rows,
    total,
    ratio: Number((total.anchor / Math.max(1, total.patch)).toFixed(3)),
    winners: {
      anchor: rows.filter((r) => r.netDelta < 0).map((r) => r.id),
      patch: rows.filter((r) => r.netDelta >= 0).map((r) => r.id),
    },
  };
}

// 净收益的判定式 (写进文档, 免得只看总量):
//   锚点在"被替换内容的总字符数 > 读入行数 × 每行税 × 编辑次数"时才净省。
export function breakEvenReadLines(task) {
  const taxPerLine = readTaxChars({ ...task, readLines: 1 });
  const savedPerEdit = task.old.length - anchorPayload({ ...task, edits: 1 }).length;
  if (savedPerEdit <= 0) return Infinity;
  return Math.floor((savedPerEdit * task.edits) / taxPerLine);
}
