// src/selfcode/catch-scan.js — "静默 catch" 的唯一判定口径 (2026-11-03)
// 背景: scripts/silent-catch-guard.mjs (门禁) 与 src/selfcode/audit.js (体检) 曾各写一套
//   正则与关键路径规则, 同一个仓库能得出相反结论。本模块是唯一实现, 两边只做展示。
//
// 口径:
//   empty     = catch 块去掉注释后为空 (门禁只看这个)
//   logged    = catch 块里调用了 noteCatch/debug/warn/error/console 或 rethrow
//   swallowed = 非空且无留痕 —— 块里有语句 (return []/return null/降级赋值),
//               但异常本身从所有指标里消失。2026-11-03 补: 此前 empty 与 logged
//               都不覆盖它, 关键路径吞错会被体检报成 0 (假干净)。
//   critical  = 账目/持久化/审计/记忆路径 (目录命中或函数名含关键动词)
//
// 已知边界: logged 只认调用点/throw, 不认「把错误放进返回值/结果对象再上报」——
//   后者虽不静默, 但扫描器看不见, 仍会算进 swallowed, 需人工判读。
//   `// swallowed-ok(YYYY-MM-DD): 理由` 是人工判读后的豁免标记: 计入 acknowledged,
//   不再算盲区; 但空块 catch 带标记仍算 empty —— 门禁不放宽。
//   标记只对「非空且无留痕」的块有意义; 理由太短 (<2 字) 视为裸标记, 不生效。
// 2026-11-03 (堵自证豁免): 标记必须带日期且未过期 (ACK_TTL_DAYS), 否则降级为 swallowed:
//   无日期 = 不可证何时判读过 → 一律不算豁免 (历史标记已统一补日期);
//   超期未复核 = 豁免失效, 重新进入盲区计数, 催人回看而不是永久白名单。
// 去注释但保留字符串, 与依赖图共用一份实现 (口径不漂)
import { stripComments } from "./source-text.js";

const CRITICAL_DIRS = ["audit", "memory", "llm", "config", "session", "evidence"];
const CRITICAL_WORDS = ["account", "flush", "persist", "write", "save", "load", "record", "audit", "append", "store", "sync"];
// 被守护操作本身落盘/记账/投递/学习 → 静默即丢数据。目录名单之外的 agent 层靠这条兜住。
// 刻意不含 send/emit/push: SSE 断开、事件派发这类失败是正常降级, 留痕只会制造噪声。
const CRITICAL_CALL = /(?:^|[^A-Za-z0-9$])(?:learn|record|persist|save\w*|flush\w*|append\w*|enqueue|deliver\w*|archive\w*|checkpoint|snapshot|writeFile\w*|writeJson|appendFile\w*|atomicWrite|rewardRecord|flushTurnArchive|evictionScan)\s*\(/;
// 手填 scope 取到最近代码行 (if/for/...) 时的坏标签; 运行时另有文件:行兜底
const GENERIC_SCOPES = new Set(["if", "for", "while", "do", "else", "try", "catch", "switch", "return", "warn", "debug", "info", "error", "log"]);
const CONTROL_HEADS = new Set(["if", "for", "while", "switch", "catch", "do", "else", "try"]);

const CATCH_HEAD = /catch\s*(?:\([^)]*\))?\s*\{/g;
const NOTE_SCOPE = /noteCatch\(\s*["'`]([^"'`]*)["'`]/g;
const LOGGING = /(?:\b(?:noteCatch|debug|warn|error|info)\s*[({]|console\s*\.|\bthrow\b)/;
// 日期是可选的捕获组: 没写日期的旧标记解析为 ackDate="" → 不算豁免 (不自证)
const ACK_MARK = /(?:\/\/|\/\*)\s*swallowed-ok\b(?:\s*\(\s*(\d{4})-(\d{2})-(\d{2})\s*\))?[ \t]*[:：-]?[ \t]*([^\n*]*)/i;
const ACK_TTL_DAYS = 180; // 豁免有效期: 超期未复核自动降级为吞错
const DAY_MS = 86400000;

// 解析标记日期 → UTC 毫秒; 非法日期 (2026-13-40 / 未来日期) 返回 null (按未判读处理)
function ackDateMs(y, mo, d, now) {
  const yi = Number(y), mi = Number(mo), di = Number(d);
  if (!yi || !mi || !di) return null;
  const t = Date.UTC(yi, mi - 1, di);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== yi || dt.getUTCMonth() !== mi - 1 || dt.getUTCDate() !== di) return null;
  if (t > now + DAY_MS) return null; // 未来日期不可信 (手滑或伪造)
  return t;
}

// 从 '{' 之后找到配对的 '}' (跳过字符串与注释里的括号)
function blockEnd(text, start) {
  let depth = 1;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && text[i + 1] === "/") { const n = text.indexOf("\n", i); i = n < 0 ? text.length : n; continue; }
    if (c === "/" && text[i + 1] === "*") { const n = text.indexOf("*/", i + 2); i = n < 0 ? text.length : n + 1; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return text.length;
}

// 粗粒度最近函数名: 跳过 if/for 等控制行, 否则 catch 会挂到 "if" 上, 关键动词永远匹配不到。
// 还必须是**定义**而不是调用: 早先的宽松匹配会把 atomicWrite 里的一行 `ensureDir(dir);`
//   当成函数名 —— catch 的归属变成 ensureDir, "write" 永远匹配不到 (实测漏报
//   src/utils/store.js 的原子写失败分支)。因此只认 function 声明、方法定义、箭头函数赋值。
function nearestFnName(lines, upto) {
  for (let i = upto; i >= 0 && i > upto - 80; i--) {
    const m = lines[i].match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (m && !CONTROL_HEADS.has(m[1])) return m[1];
    // 类/对象方法 (含 async/static/get/set): 覆盖 `async learn() {` 这类无 function 关键字的定义
    const m2 = lines[i].match(/^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/);
    if (m2 && !CONTROL_HEADS.has(m2[1])) return m2[1];
    const m3 = lines[i].match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(?[^=]*?\)?\s*=>/);
    if (m3) return m3[1];
    // 回调属性 `onStep: (ev) => {` —— 不认它就会一路向上挂到某个无关调用名 (如 spillStore)
    const m4 = lines[i].match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(?[^)]*\)?\s*=>\s*\{/);
    if (m4) return m4[1];
  }
  return "";
}

// catch 前最近的 try 块正文 (仅正文, 不含 catch 自身) —— 用来判断"被守护的是什么操作"
function guardedBlock(src, catchIdx) {
  const head = src.slice(0, catchIdx);
  const re = /try\s*\{/g;
  let last = null;
  let t;
  while ((t = re.exec(head)) !== null) last = t;
  if (!last) return "";
  const open = last.index + last[0].length;
  const close = blockEnd(src, open);
  return close < catchIdx ? src.slice(open, close) : "";
}

function isCriticalFile(rel) {
  const p = String(rel || "").replace(/\\/g, "/");
  return CRITICAL_DIRS.some((d) => p.startsWith(`src/${d}/`) || p.includes(`/src/${d}/`));
}

function scanCatchSites(text, rel = "", { now = Date.now(), ttlDays = ACK_TTL_DAYS } = {}) {
  const src = String(text || "");
  const lines = src.split(/\r?\n/);
  const sites = [];
  CATCH_HEAD.lastIndex = 0;
  let m;
  while ((m = CATCH_HEAD.exec(src)) !== null) {
    const bodyStart = m.index + m[0].length;
    const bodyEnd = blockEnd(src, bodyStart);
    const body = src.slice(bodyStart, bodyEnd);
    const stripped = stripComments(body).trim();
    const line = src.slice(0, m.index).split(/\r?\n/).length;
    const fn = nearestFnName(lines, line - 1);
    const scopes = [];
    NOTE_SCOPE.lastIndex = 0;
    let s;
    while ((s = NOTE_SCOPE.exec(body)) !== null) scopes.push(s[1]);
    const guarded = guardedBlock(src, m.index);
    const fnWord = CRITICAL_WORDS.find((w) => fn.toLowerCase().includes(w));
    const opMatch = guarded.match(CRITICAL_CALL);
    const criticalReason = isCriticalFile(rel) ? "module" : fnWord ? `fn:${fnWord}` : opMatch ? `op:${opMatch[0].replace(/^[^A-Za-z]+/, "").replace(/\s*\($/, "")}` : "";
    const empty = stripped === "";
    const logged = LOGGING.test(stripped);
    const ack = body.match(ACK_MARK);
    const ackDay = ack ? ackDateMs(ack[1], ack[2], ack[3], now) : null;
    const ackReason = ack ? String(ack[4] || "").trim() : "";
    const hasReason = ackReason.length >= 2;
    const ackDate = ackDay == null ? "" : new Date(ackDay).toISOString().slice(0, 10);
    const ackExpired = ackDay != null && (now - ackDay) > ttlDays * DAY_MS;
    const ackUndated = !!ack && hasReason && ackDay == null; // 写了理由但日期缺失/非法
    const acknowledged = !empty && !logged && hasReason && ackDay != null && !ackExpired;
    sites.push({
      file: String(rel || "").replace(/\\/g, "/"),
      line,
      fn,
      critical: !!criticalReason,
      criticalReason,
      empty,
      logged,
      swallowed: !empty && !logged && !acknowledged,
      acknowledged,
      ackReason,
      ackDate,
      ackExpired,
      ackUndated,
      scopes,
      badScopes: scopes.filter((sc) => GENERIC_SCOPES.has(String(sc).slice(String(sc).lastIndexOf("#") + 1))),
    });
  }
  return sites;
}

// 单文件汇总: 门禁与体检都从这里取数
// expiredAcks / undatedAcks 是"标记了但不算数"的两类, 单列出来便于催复核;
// 它们已包含在 swallowed 里 (acknowledged=false), 不是额外豁免。
export function summarizeCatchScan(text, rel = "", opts = {}) {
  const sites = scanCatchSites(text, rel, opts);
  const empty = sites.filter((x) => x.empty);
  const swallowed = sites.filter((x) => x.swallowed);
  const badScopes = sites.flatMap((x) => x.badScopes.map((scope) => ({ line: x.line, scope })));
  return {
    sites,
    empty: empty.length,
    criticalEmpty: empty.filter((x) => x.critical).length,
    logged: sites.filter((x) => x.logged).length,
    swallowed: swallowed.length,
    criticalSwallowed: swallowed.filter((x) => x.critical).length,
    acknowledged: sites.filter((x) => x.acknowledged).length,
    criticalAcknowledged: sites.filter((x) => x.acknowledged && x.critical).length,
    expiredAcks: sites.filter((x) => x.ackExpired).length,
    criticalExpiredAcks: sites.filter((x) => x.ackExpired && x.critical).length,
    undatedAcks: sites.filter((x) => x.ackUndated).length,
    criticalUndatedAcks: sites.filter((x) => x.ackUndated && x.critical).length,
    scopes: sites.reduce((n, x) => n + x.scopes.length, 0),
    badScopes,
  };
}
