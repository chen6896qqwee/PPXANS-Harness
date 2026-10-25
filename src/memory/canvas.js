// src/memory/canvas.js - 符号画布记忆 (P2⑥)
// 吸收 TencentDB-Agent-Memory 的"符号化记忆"设计思想:
//   长任务上下文只放轻量 Mermaid 状态图 (节点=步骤, 边=状态转移, node_id=事件 seq),
//   细节按 node_id 从事件日志取 —— 上层存结构, 下层存证据, 完整 drill-down 路径。
// 皮皮虾自研实现: 从 trace.js 的事件流 (turn/step 边界事件) 归纳画布, 非 LLM、纯代码、可测。
// 触发条件: steps >= minSteps (默认 8) 或事件数超阈值时才开启, 防过度设计。
import path from "node:path";
import { ensureDir, writeText, readJson, logicalDay } from "../utils/store.js";

export const CANVAS_DEFAULTS = { minSteps: 8, maxNodes: 30, maxEdges: 40 };

// ---- 从 trace 事件行归纳状态图 (纯函数) ----
// lines: trace.js 事件原始行 (已 JSON.parse 的数组)
// 返回 { nodes: [{id,label,kind}], edges: [{from,to,label}], startedAt, endedAt, steps }
export function buildCanvasFromEvents(events = [], opts = {}) {
  const { maxNodes = CANVAS_DEFAULTS.maxNodes, maxEdges = CANVAS_DEFAULTS.maxEdges } = opts;
  const nodes = [];
  const edges = [];
  const nodeById = new Map();
  let steps = 0;
  let startedAt = null;
  let endedAt = null;
  let lastNodeId = null;

  const ensureNode = (id, label, kind) => {
    if (nodeById.has(id)) return nodeById.get(id);
    const n = { id, label: String(label || id).slice(0, 60), kind: kind || "step" };
    nodes.push(n);
    nodeById.set(id, n);
    return n;
  };

  const addEdge = (from, to, label) => {
    if (edges.length >= maxEdges) return;
    edges.push({ from, to, label: String(label || "").slice(0, 40) });
  };

  for (const ev of events) {
    if (!ev || !ev.evt) continue;
    const seq = ev.seq != null ? "evt-" + ev.seq : null;
    if (ev.evt === "turn/start") {
      startedAt = ev.ts || startedAt;
      const n = ensureNode(seq || "turn-start", "任务开始", "boundary");
      lastNodeId = n.id;
    } else if (ev.evt === "turn/end") {
      endedAt = ev.ts || endedAt || new Date().toISOString();
      const n = ensureNode(seq || "turn-end", ev.ok ? "任务完成" : "任务中断", "boundary");
      if (lastNodeId) addEdge(lastNodeId, n.id, "");
      lastNodeId = n.id;
    } else if (ev.evt === "step/start") {
      steps++;
      const n = ensureNode(seq || "step-" + steps, `步骤 ${ev.round != null ? ev.round : steps}`, "step");
      if (lastNodeId && lastNodeId !== n.id) addEdge(lastNodeId, n.id, "");
      lastNodeId = n.id;
    } else if (ev.evt === "step/end") {
      const n = ensureNode(seq || "step-end-" + steps, `步骤结束 (${ev.ok ? "成功" : "失败"})`, ev.ok ? "ok" : "fail");
      if (lastNodeId && lastNodeId !== n.id) addEdge(lastNodeId, n.id, ev.tool || "");
      lastNodeId = n.id;
    } else if (ev.evt === "tool/call" && ev.tool) {
      const n = ensureNode(seq || "tool-" + steps + "-" + ev.tool, `${ev.tool}`, "tool");
      if (lastNodeId && lastNodeId !== n.id) addEdge(lastNodeId, n.id, ev.ok === false ? "失败" : "");
      lastNodeId = n.id;
    }
    if (nodes.length > maxNodes) break;
  }
  return { nodes, edges, steps, startedAt, endedAt };
}

// ---- Mermaid 渲染 ----
export function toMermaid(canvas) {
  const lines = ["graph LR"];
  for (const n of canvas.nodes) {
    const cls = n.kind === "boundary" ? ":::" + n.kind : (n.kind === "fail" ? ":::" + n.kind : "");
    lines.push(`  ${n.id}["${escapeLabel(n.label)}"]${cls}`);
  }
  for (const e of canvas.edges) {
    lines.push(`  ${e.from} -->|${escapeLabel(e.label)}| ${e.to}`);
  }
  return lines.join("\n");
}

function escapeLabel(s) {
  return String(s || "").replace(/["[\]]/g, "").slice(0, 50);
}

// ---- 画布存储 (按天, 增量追加) ----
export class CanvasStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "memory", "canvas");
    ensureDir(this.dir);
  }

  _file(day = logicalDay()) { return path.join(this.dir, `${day}.json`); }

  // 保存某天画布 (整体覆盖当天, 画布是归纳视图非 append-only)
  save(canvas, { day = logicalDay() } = {}) {
    const payload = { day, updatedAt: Date.now(), ...canvas };
    writeText(this._file(day), JSON.stringify(payload, null, 2));
    return payload;
  }

  read(day = logicalDay()) {
    return readJson(this._file(day), null);
  }

  // 从 trace 事件自动生成并保存 (若步骤数达标); 返回 null 表示未触发
  async captureFromEvents(events, { minSteps = CANVAS_DEFAULTS.minSteps } = {}) {
    const canvas = buildCanvasFromEvents(events);
    if (canvas.steps < minSteps) return null;
    return this.save(canvas);
  }
}

// ---- 上下文注入片段: 只有画布 + 最近细节, 省 token ----
export function renderCanvasContext(canvas, { detailLines = 3 } = {}) {
  if (!canvas || !canvas.nodes || !canvas.nodes.length) return "";
  const mermaid = toMermaid(canvas);
  const tail = canvas.nodes.slice(-detailLines).map((n) => `- ${n.id}: ${n.label}`).join("\n");
  return `\n# 任务画布 (符号化)
${mermaid}

最近节点: 
${tail}
(需细节时用 node_id 取事件日志原文)
`;
}

export default CanvasStore;
