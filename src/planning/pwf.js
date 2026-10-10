// src/planning/pwf.js - 三文件持久规划 (2026-10-06 吸收 OthmanAdi/planning-with-files, 27k★)
// task_plan.md / findings.md / progress.md 落盘 .ppx/plan/, 计划在磁盘不在上下文 —
// 扛住上下文压缩、/clear 与崩溃 (PWF 核心理念: "Your agent's context window dies. The plan does not.")
// 配套吸收 codex-task-pointer: PreCompact 时写任务指针, 压缩后从指针恢复现场。
// 零依赖纯 JS, 文件格式人类可读可手改。
import fs from "node:fs";
import path from "node:path";
import { nowISO } from "../utils/store.js";

export function planDir(root) {
  return path.join(root, ".ppx", "plan");
}

export function planExists(root) {
  return fs.existsSync(path.join(planDir(root), "task_plan.md"));
}

const HEAD_PLAN = "# 任务计划 (task_plan)\n\n";
const HEAD_FINDINGS = "# 发现 (findings)\n\n> 关键事实/路径/结论, 供后续步骤复用。每条带时间戳。\n\n";
const HEAD_PROGRESS = "# 进度 (progress)\n\n> 已完成动作 + 当前状态日志, 倒序追加。\n\n";
const POINTER_MARK = "<!-- task-pointer: 压缩后从此处恢复 -->";

// 初始化三文件 (已存在则不覆盖, 返回 existing)
export function initPlan(root, { goal = "", steps = [] } = {}) {
  const dir = planDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, "task_plan.md");
  if (fs.existsSync(planPath)) {
    return { ok: false, reason: "已存在计划, 不覆盖 (可先 archive 再 init)", dir };
  }
  const lines = [HEAD_PLAN, `**目标**: ${goal || "(未填写)"}\n`];
  steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${checkbox("pending")} ${s}`);
  });
  fs.writeFileSync(planPath, lines.join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(dir, "findings.md"), HEAD_FINDINGS, "utf8");
  fs.writeFileSync(
    path.join(dir, "progress.md"),
    HEAD_PROGRESS + `- ${nowISO()} 计划初始化 (${steps.length} 步)\n`,
    "utf8",
  );
  return { ok: true, dir, steps: steps.length };
}

function checkbox(status) {
  return status === "done" ? "[x]" : status === "blocked" ? "[!]" : "[ ]";
}

// 更新第 idx 步 (1-based) 状态: pending/done/blocked, 可附备注
export function updateStep(root, idx, status = "done", note = "") {
  const planPath = path.join(planDir(root), "task_plan.md");
  if (!fs.existsSync(planPath)) return { ok: false, reason: "计划不存在, 先 init" };
  const raw = fs.readFileSync(planPath, "utf8");
  const lines = raw.split("\n");
  let hit = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\d+\.\s\[( |x|!)\]\s/);
    if (!m) continue;
    hit++;
    if (hit === idx) {
      lines[i] = lines[i].replace(/^\d+\.\s\[( |x|!)\]/, `${hit}. ${checkbox(status)}`);
      if (note) lines[i] += ` — ${note}`;
      fs.writeFileSync(planPath, lines.join("\n"), "utf8");
      appendProgress(root, `步骤 ${idx} → ${status}${note ? `: ${note}` : ""}`);
      return { ok: true, step: idx, status };
    }
  }
  return { ok: false, reason: `步骤 ${idx} 不存在 (共 ${hit} 步)` };
}

// 追加一条发现
export function appendFinding(root, text) {
  const p = path.join(planDir(root), "findings.md");
  if (!fs.existsSync(p)) return { ok: false, reason: "计划不存在, 先 init" };
  fs.appendFileSync(p, `- ${nowISO()} ${text}\n`, "utf8");
  return { ok: true };
}

// 追加一条进度
export function appendProgress(root, text) {
  const p = path.join(planDir(root), "progress.md");
  if (!fs.existsSync(p)) return { ok: false, reason: "计划不存在, 先 init" };
  fs.appendFileSync(p, `- ${nowISO()} ${text}\n`, "utf8");
  return { ok: true };
}

// 任务指针: PreCompact 时调用, 把"下一步做什么/做到哪"写进 progress.md
// (吸收 codex-task-pointer: 压缩不可怕, 可怕的是压缩后不知道刚才干到哪)
export function writeTaskPointer(root, { next = "", inFlight = "" } = {}) {
  const p = path.join(planDir(root), "progress.md");
  if (!fs.existsSync(p)) return { ok: false, reason: "计划不存在" };
  let raw = fs.readFileSync(p, "utf8");
  const block = [
    POINTER_MARK,
    `**下一步**: ${next || "(见 task_plan 第一个未勾选项)"}`,
    inFlight ? `**进行中**: ${inFlight}` : "",
  ].filter(Boolean).join("\n");
  if (raw.includes(POINTER_MARK)) {
    raw = raw.replace(/<!-- task-pointer: 压缩后从此处恢复 -->[\s\S]*?(?=\n\n|\n- |$)/, block);
  } else {
    raw = raw.replace(/\n\n/, "\n\n" + block + "\n\n");
  }
  fs.writeFileSync(p, raw, "utf8");
  return { ok: true };
}

// 读取全部三文件原文
export function readAll(root) {
  const dir = planDir(root);
  const read = (f) => {
    try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; }
  };
  return { task_plan: read("task_plan.md"), findings: read("findings.md"), progress: read("progress.md") };
}

// 压缩摘要 (上下文注入用): 目标 + 步骤勾选状态 + 最近 3 条进度 + 最近 3 条发现
// 无计划返回 "" (零侵入, 向后兼容)
export function summarize(root) {
  if (!planExists(root)) return "";
  const { task_plan, findings, progress } = readAll(root);
  const steps = task_plan.split("\n").filter((l) => /^\d+\.\s\[/.test(l));
  const done = steps.filter((l) => /\[x\]/.test(l)).length;
  const out = [
    `【持久规划】三文件在 .ppx/plan/, 压缩/清空会话后仍存活; 更新用 plan_files 工具`,
    `步骤进度: ${done}/${steps.length} 已完成`,
    ...steps.slice(0, 12),
  ];
  const lastOf = (md, n) =>
    md.split("\n").filter((l) => /^- /.test(l)).slice(-n);
  const prog = lastOf(progress, 3);
  const find = lastOf(findings, 3);
  if (prog.length) out.push("", "最近进度:", ...prog);
  if (find.length) out.push("", "关键发现:", ...find);
  return out.join("\n");
}

// 删除当前计划 (归档式: 移入 archive-<时间戳> 子目录, 不真删, 可找回)
export function archive(root) {
  const dir = planDir(root);
  if (!fs.existsSync(path.join(dir, "task_plan.md"))) return { ok: false, reason: "无计划" };
  const stamp = nowISO().replace(/[:.]/g, "-");
  const to = path.join(dir, `archive-${stamp}`);
  fs.mkdirSync(to, { recursive: true });
  for (const f of ["task_plan.md", "findings.md", "progress.md"]) {
    const src = path.join(dir, f);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(to, f));
  }
  return { ok: true, archivedTo: to };
}
