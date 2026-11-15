// scripts/lib/cache-audit-text.js - 前缀缓存审计的纯文本分析层 (无 agent/子进程/网络)
// 从 scripts/lib/cache-audit-core.js 拆出 (2026-11-03): 请求序列化、偏移翻译、易变值扫描
// 都是纯函数, 与"怎么把请求抓下来"解耦, 可单独断言。
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url)); // scripts/lib
export const PROJECT_ROOT = path.dirname(path.dirname(LIB_DIR)); // 项目根

// ---- token 估算: 与 scripts/ctx-profile.js 同一口径 (中文 1 字 ≈ 1 tok, 其余 4 字符 ≈ 1 tok) ----
// 两处闸门口径一致, 才能直接对照 ctx-profile 的 4500 tok 预算与 AWS 512 tok 最小 checkpoint。
export function estTokens(s) {
  const t = String(s || "");
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(cjk + (t.length - cjk) / 4);
}

// ---- 字符级最长公共前缀 ----
export function lcpChars(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i++) if (a[i] !== b[i]) break;
  return i;
}

// ---- 请求序列化: 按 provider 视角"tools 数组 → system 消息 → 会话消息"拼成一个可比字符串 ----
// 每段带区域标记, 便于把分歧偏移量映射回"哪个区/哪个区块/第几条消息"。
export function serializeRequest({ tools, messages }) {
  const msgs = messages || [];
  const toolStr = JSON.stringify(tools || []);
  let sysStr = "";
  let firstNonSystem = 0;
  while (firstNonSystem < msgs.length && msgs[firstNonSystem]?.role === "system") {
    sysStr += (sysStr ? "\n\n" : "") + String(msgs[firstNonSystem].content ?? "");
    firstNonSystem++;
  }
  let text = "TOOLS\n" + toolStr + "\nSYSTEM\n";
  const regions = {
    toolsStart: 6,
    toolsEnd: 6 + toolStr.length,
    sysStart: text.length,
    sysEnd: text.length + sysStr.length,
    msgs: [],
  };
  text += sysStr + "\nMSGS\n";
  for (let i = firstNonSystem; i < msgs.length; i++) {
    const mStr = JSON.stringify(msgs[i]);
    const start = text.length;
    text += "M#" + i + "\n" + mStr + "\n";
    regions.msgs.push({ index: i, start, end: text.length });
  }
  return { text, regions, system: sysStr, msgCount: msgs.length - firstNonSystem, toolsLen: toolStr.length };
}

// ---- 动态检索段定位: 从组装好的 system 串里算出"静态边界" ----
// _context() 的组装规则是: 静态块 + "\n\n" + memory.context(userMsg) [+ "\n\n" + scenes.activeContext()]。
// captureSession 处已把这两个检索调用包装记账 (捕获到"当次请求实际产出的动态段"), 这里做尾部校验:
//   - 若捕获到的动态段确实贴在 system 尾部 → 静态边界 = 尾部起点 (静态区 = 之前全部字节);
//   - 若贴不上 (检索段不在尾部 / 组装规则漂移) → 说明动态内容泄漏进静态区或 _context 结构变了 →
//     按失败处理并给尽调偏移。选择"校验失败=不通过"而非"猜一个边界", 杜绝静默假通过。
export function locateStaticTail(system, memoryCtx, sceneCtx) {
  if (typeof memoryCtx !== "string" || memoryCtx === "") {
    return { staticEnd: system.length, ok: false, note: "未捕获到 memory 检索段 (无法确证静态边界, 按不可证处理)" };
  }
  const tail = sceneCtx ? memoryCtx + "\n\n" + sceneCtx : memoryCtx;
  const staticEnd = system.length - tail.length;
  if (staticEnd >= 0 && system.slice(staticEnd) === tail) {
    return { staticEnd, ok: true, note: "" };
  }
  const idx = system.lastIndexOf(memoryCtx);
  if (idx === -1) {
    return { staticEnd: 0, ok: false, note: "memory 检索段未在 system 尾部且整体找不到 —— 检索内容疑似已渗入静态区或组装顺序漂移" };
  }
  return { staticEnd: idx, ok: false, note: "动态段位置与 join 规则不符 (场景段缺失或顺序漂移)" };
}

// 把"整条序列化请求里的绝对偏移"翻译回人话: 落在 tools / system 静态区 / system 动态尾 / 第几条消息。
// --verbose 与失败详情都靠它, 这样"缓存前缀在第几个字节断掉"能直接定位到区块或消息。
export function describeOffset(serialized, offset, boundary = null) {
  const r = serialized.regions;
  if (offset < r.toolsStart) return { region: "header", label: "序列化头部区段标记", local: offset };
  if (offset < r.toolsEnd) return { region: "tools", label: "tools 数组 (请求最前, 任何变动作废整个前缀)", local: offset - r.toolsStart };
  if (offset < r.sysStart) return { region: "separator", label: "tools/system 区段分隔标记", local: offset - r.toolsEnd };
  const sysLocal = offset - r.sysStart;
  if (sysLocal < r.sysEnd - r.sysStart) {
    const inStatic = boundary && boundary.ok ? sysLocal < boundary.staticEnd : true;
    return { region: "system", label: inStatic ? "system 静态区 (应逐字节恒定)" : "system 动态检索尾 (随 userMsg 变化, 预期)",
      local: sysLocal, staticEnd: boundary ? boundary.staticEnd : null };
  }
  for (const m of r.msgs) {
    if (offset >= m.start && offset < m.end) return { region: "message", label: "会话消息 #" + m.index, local: offset - m.start, msgIndex: m.index };
  }
  return { region: "tail", label: "消息列表末尾 (纯追加的起点)", local: offset - r.sysEnd };
}

// 把 system 串内的偏移映射回"最近一个区块标题", 供失败时人肉定位 (与 ctx-profile 的分节拆解同一思路)
export function blockLabelAt(systemStr, offset) {
  const head = systemStr.slice(0, Math.max(0, offset));
  const lines = head.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(【[^】]{1,30}】|#|##)\s*\S{0,24}/.exec(lines[i]);
    if (m) return lines[i].slice(0, 30);
  }
  return "(前导区: 核心价值/人格)";
}

// ---- 静态区易变值扫描 (检查 b 的扫描半边; 与双实例 diff 互补, 防"两个样本恰好相等"的假通过) ----
export function volatileHits(staticRegion, { projectRoot = PROJECT_ROOT } = {}) {
  const hits = [];
  const patterns = [
    ["iso-timestamp", /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/],
    ["date", /\d{4}[-/]\d{1,2}[-/]\d{1,2}/],
    ["clock", /\b\d{2}:\d{2}:\d{2}\b/],
    ["epoch-ms", /\b1\d{12}\b/],
    ["mkdtemp-dir", /ppx-[a-z0-9][a-z0-9._-]*-[A-Za-z0-9]{6}\b/],
    ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ];
  for (const [id, re] of patterns) {
    const m = re.exec(staticRegion);
    if (m) hits.push({ id, at: m.index, sample: staticRegion.slice(m.index, m.index + 34) });
  }
  // os.tmpdir() 绝对路径混进静态区 = 每进程随机值 (workspace 越界/夹具泄漏级风险)。
  // 例外: 仓库根本身就位于临时目录时 (某些 CI runner), 工作目录区块合法含此前缀 → 跳过避免恒红。
  const tmp = path.resolve(os.tmpdir());
  const rootLower = path.resolve(projectRoot).toLowerCase();
  const tmpInRepo = rootLower.startsWith(tmp.toLowerCase() + path.sep.toLowerCase());
  const rootIsTmp = rootLower === tmp.toLowerCase();
  if (!tmpInRepo && !rootIsTmp) {
    const i = staticRegion.toLowerCase().indexOf(tmp.toLowerCase());
    if (i >= 0) hits.push({ id: "tmpdir-path", at: i, sample: staticRegion.slice(i, i + 40) });
  }
  return hits;
}
