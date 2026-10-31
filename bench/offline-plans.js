// bench/offline-plans.js — 20 个基准任务的「正确做法」脚本 (2026-10-30)
//
// 这是 P0「痛觉」的燃料: bench/tasks.js 已经有 20 个**确定性判分**的任务 (verify 不用 LLM 评审),
// 缺的只是一个"执行者"。本文件给每个任务写一份人类/完美模型会走的工具序列, 离线执行器
// (scripts/taskbench-offline.js) 把它当成模型的 tool_calls 回放, 走**真实的** agent 工具循环
// (runToolLoop → _runTool → 落盘), 最后跑原任务的 verify。
//
// 它测的不是"模型聪不聪明", 而是 **harness 能不能把一个正确的计划执行成结果** ——
// 路径解析 / 参数校验 / 命令超时 / 结果截断 / 文件落盘 / 记忆写入, 任何一环有毛病都会在这里现形。
// 计划写错 = 误判, 所以每一步都对照 bench/tasks.js 的 setup 夹具手写, 不猜。
//
// 约定: steps[].tool 必须是真实注册的工具名 (TASK_PLANS 里的 "grep" 是规划占位, 实际叫 search_files);
//   reply 是"模型最后说的那句话", 供 verify 里看文本的任务判分。

const BROKEN_FIXED = 'export function greet(name) {\n  return `hi ${name}`;\n}\n';
const CALC_FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';
const RENAMED = 'export async function loadData() { return 1; }\nexport async function main() { const r = await loadData(); return r; }\n';

export const OFFLINE_PLANS = {
  // ---- A. 信息检索 ----
  "version-report": {
    steps: [{ tool: "read_file", args: { path: "package.json" } }],
    reply: "7.7.7",
  },
  "count-files": {
    steps: [{ tool: "list_dir", args: { path: "items" } }],
    reply: "6 个 .txt 文件",
  },
  "find-symbol": {
    // search_files 只搜文件名不搜内容, 所以按真实可行路径: 读两个候选文件, 指认定义所在的那个
    steps: [
      { tool: "read_file", args: { path: "pricing.js" } },
      { tool: "read_file", args: { path: "unrelated.js" } },
    ],
    reply: "calcDiscount 定义在 pricing.js",
  },
  "sum-numbers": {
    steps: [{ tool: "read_file", args: { path: "numbers.txt" } }],
    reply: "17 + 25 + 8 = 50",
  },
  "read-secret": {
    steps: [{ tool: "read_file", args: { path: "config.ini" } }],
    reply: "token = sk-bench-42",
  },

  // ---- B. 文件操作 ----
  "create-file": {
    steps: [{ tool: "write_file", args: { path: "notes/todo.txt", content: "买牛奶" } }],
    reply: "已创建 notes/todo.txt",
  },
  "append-file": {
    steps: [{ tool: "append_file", args: { path: "log.txt", content: "DONE\n" } }],
    reply: "已在 log.txt 末尾追加 DONE",
  },
  "json-edit": {
    steps: [
      { tool: "read_file", args: { path: "config.json" } },
      { tool: "write_file", args: { path: "config.json", content: JSON.stringify({ timeout: 5000, retries: 3 }, null, 2) } },
    ],
    reply: "已把 timeout 改成 5000",
  },
  "delete-file": {
    steps: [{ tool: "delete_file", args: { path: "obsolete.txt" } }],
    reply: "已删除 obsolete.txt",
  },
  "json-create": {
    steps: [{ tool: "write_file", args: { path: "person.json", content: JSON.stringify({ name: "Alice", age: 30 }, null, 2) } }],
    reply: "已创建 person.json",
  },

  // ---- C. 代码修复 ----
  "fix-syntax": {
    steps: [
      { tool: "read_file", args: { path: "broken.js" } },
      { tool: "write_file", args: { path: "broken.js", content: BROKEN_FIXED } },
      { tool: "run_command", args: { command: "node --check broken.js" } },
    ],
    reply: "已修复模板字符串未闭合的语法错误",
  },
  "fix-logic": {
    steps: [
      { tool: "read_file", args: { path: "calc.js" } },
      { tool: "write_file", args: { path: "calc.js", content: CALC_FIXED } },
    ],
    reply: "已把 add 改成返回两数之和",
  },
  "write-function": {
    steps: [
      { tool: "write_file", args: { path: "utils.js", content: 'export function sum(a, b) {\n  return a + b;\n}\n' } },
      { tool: "run_command", args: { command: "node --check utils.js" } },
    ],
    reply: "已在 utils.js 写并导出 sum",
  },
  "rename-symbol": {
    steps: [
      { tool: "read_file", args: { path: "rename-me.js" } },
      { tool: "write_file", args: { path: "rename-me.js", content: RENAMED } },
      { tool: "run_command", args: { command: "node --check rename-me.js" } },
    ],
    reply: "已把 fetchData 全部改名为 loadData",
  },

  // ---- D. 记忆与协作 ----
  "memory-roundtrip": {
    steps: [{ tool: "memory_add", args: { content: "基准测试口令-蓝鲸99" } }],
    reply: "我记住了: 基准测试口令-蓝鲸99",
  },
  "board-roundtrip": {
    steps: [
      { tool: "board_publish", args: { content: "军团暗号-QW7" } },
      { tool: "board_query", args: {} },
    ],
    reply: "查到了: 军团暗号-QW7",
  },

  // ---- E. 多步综合 ----
  "analyze-and-report": {
    steps: [
      { tool: "read_file", args: { path: "data.csv" } },
      { tool: "write_file", args: { path: "report.txt", content: "共 4 行" } },
    ],
    reply: "已统计并写入 report.txt",
  },
  "conditional-write": {
    steps: [
      { tool: "read_file", args: { path: "flag.txt" } },
      { tool: "write_file", args: { path: "enabled.txt", content: "enabled by flag=on" } },
    ],
    reply: "flag 是 on, 已创建 enabled.txt",
  },
  "src-listing": {
    steps: [
      { tool: "list_dir", args: { path: "lib" } },
      { tool: "write_file", args: { path: "lib-list.txt", content: "a.js\nb.js\n" } },
    ],
    reply: "已把两个 js 文件名写入 lib-list.txt",
  },
  "extract-field": {
    steps: [{ tool: "read_file", args: { path: "users.json" } }],
    reply: "有 2 个用户的 email 以 @bench.dev 结尾",
  },
};

// 计划覆盖率自检: 任务集里每一个都必须有对应计划 (缺一个 = 痛觉有盲区, 由离线执行器断言)
export function planCoverage(taskIds = []) {
  const missing = taskIds.filter((id) => !OFFLINE_PLANS[id]);
  const extra = Object.keys(OFFLINE_PLANS).filter((id) => !taskIds.includes(id));
  return { missing, extra };
}
