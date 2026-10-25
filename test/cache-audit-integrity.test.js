// test/cache-audit-integrity.test.js - Provider 前缀缓存完整性审计器的自检 + 仓库真跑结论
//
// 两层断言, 分工明确:
//   1) 逻辑层 (纯合成载荷, 不起 agent): 四个不变量 a/b/c/d 的判定必须**可证伪** ——
//      既要在干净载荷上通过, 也要在人为破坏的载荷上失败。一个只会绿的检查等于没有检查。
//   2) 真跑层 (捕获桩驱动真实 agent, 零网络): 用仓库当前的提示词管线跑一次多轮会话,
//      钉住"审计器确实在工作"的证据 (捕获数 / 工具往返 / 探针已执行 / 稳定前缀规模)。
//      注意: 真跑层对 (b) 只断言"子方法都真的跑了且结论自洽", 不断言今天通过或今天失败 ——
//      那是被审计代码的属性, 不是审计器的属性; 断言死任何一种都会让本测试在修复后或回归后变脆。
//   3) 负例层 (任务书要求): 夹具只在测试里往静态区注入易变值 (monkey-patch 实例, 绝不动 src/),
//      断言审计器报出回归, 并断言 CLI 以非零码退出。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  PROJECT_ROOT,
  estTokens,
  lcpChars,
  serializeRequest,
  describeOffset,
  locateStaticTail,
  volatileHits,
  auditCaptures,
  runFullAudit,
  memoryDriftProbe,
  FIXTURES,
  SCRIPT_TURNS,
} from "../scripts/lib/cache-audit-core.js";

// ---- 合成载荷工具 ----
const CLEAN_STATIC = "【核心价值】诚实, 不编造\n【人格】直接务实\n【工作目录】项目沙箱\n【技能清单】read_file/write_file\n【工具提示】先读后改";
const DYN_TAIL = "\n# 今日对话\n今日已进行 0 轮对话\n\n# 长期记忆 (最近)\n(暂无)\n\n# 关键事实\n";
const TOOLS_AB = [{ type: "function", function: { name: "alpha", description: "d", parameters: {} } },
  { type: "function", function: { name: "beta", description: "d", parameters: {} } }];

function mkCapture({ staticPart = CLEAN_STATIC, memoryCtx = DYN_TAIL, sceneCtx = "", messages, tools = TOOLS_AB, turn = 1, round = 1 }) {
  const system = staticPart + "\n\n" + memoryCtx + (sceneCtx ? "\n\n" + sceneCtx : "");
  const msgs = messages || [{ role: "system", content: system }, { role: "user", content: "问题" }];
  return {
    turn, round,
    messages: msgs,
    tools,
    system,
    memoryCtx,
    sceneCtx,
    serialized: serializeRequest({ tools, messages: msgs }),
    boundary: locateStaticTail(system, memoryCtx, sceneCtx),
  };
}
const checkOf = (audit, id) => audit.checks.find((c) => c.id === id);

// 真跑层共享一次审计 (每次 ~1.5s, 不该在 6 个 test 里重复跑)
let realRun = null;
const auditReal = () => (realRun ||= runFullAudit());

// ---- 1) 序列化与定界 (审计器的地基) ----
test("serializeRequest: provider 视角顺序 = tools→system→messages, 区域偏移可回指", () => {
  const c = mkCapture({});
  const { text, regions } = c.serialized;
  assert.ok(text.startsWith("TOOLS\n"), "序列以 tools 段起头 (provider 侧前缀从工具数组开始匹配)");
  assert.ok(text.indexOf("SYSTEM\n") > text.indexOf("TOOLS\n"), "system 段在 tools 之后");
  assert.ok(regions.sysStart < regions.sysEnd, "system 区偏移有效");
  assert.equal(text.slice(regions.toolsStart, regions.toolsEnd), JSON.stringify(TOOLS_AB), "tools 区切片逐字节等于序列化结果");
  assert.equal(regions.msgs.length, 1, "仅一条非 system 消息进入 msgs 区");
  assert.deepEqual(describeOffset(c.serialized, regions.toolsStart + 2, c.boundary).region, "tools", "偏移落在 tools 区");
  assert.match(describeOffset(c.serialized, regions.sysStart + 5, c.boundary).label, /静态区/, "system 前段被标为静态区");
  assert.match(describeOffset(c.serialized, regions.sysEnd - 5, c.boundary).label, /动态检索尾/, "system 尾段被标为动态检索尾");
});

test("locateStaticTail: 检索段贴尾才定界; 定不上就判不可证 (fail-closed, 不猜边界)", () => {
  const full = CLEAN_STATIC + "\n\n" + DYN_TAIL;
  const ok = locateStaticTail(full, DYN_TAIL, "");
  assert.equal(ok.ok, true, "尾部匹配 → 静态边界 = 尾部起点");
  assert.equal(ok.staticEnd, full.length - DYN_TAIL.length, "静态边界恰在静态区末尾 (join 分隔符算静态侧)");
  // 检索段嵌进静态区中间 (生产代码把 memory 放在第二位就是这个形态) → 必须报不可证, 而不是猜
  const leaked = locateStaticTail("前段\n\n" + DYN_TAIL + "\n\n后段还在", DYN_TAIL, "");
  assert.equal(leaked.ok, false, "检索段不在尾部 → 不可证");
  assert.match(leaked.note, /渗入静态区|漂移/, "不可证时给出可定位的原因: " + leaked.note);
  assert.equal(locateStaticTail("任何", "", "").ok, false, "拿不到检索段 → 不可证 (绝不默认整段是静态)");
});

test("volatileHits: 时间戳/日期/时钟/epoch/mkdtemp/uuid 全被抓到; 正常静态文本零误报", () => {
  const hitIds = (s) => volatileHits(s, { projectRoot: PROJECT_ROOT }).map((h) => h.id);
  assert.ok(hitIds("x 2026-10-04T12:33:01.5Z y").includes("iso-timestamp"), "ISO 时间戳");
  assert.ok(hitIds("x 2026/10/04 y").includes("date"), "斜杠日期");
  assert.ok(hitIds("x 12:33:01 y").includes("clock"), "时钟");
  assert.ok(hitIds("x 1759567890123 y").includes("epoch-ms"), "epoch 毫秒");
  assert.ok(hitIds("x ppx-cache-audit-1-Ab12Cd y").includes("mkdtemp-dir"), "mkdtemp 目录名");
  assert.ok(hitIds("x 3f2a9c11-4b5d-4e6f-8a9b-0c1d2e3f4a5b y").includes("uuid"), "uuid");
  assert.deepEqual(hitIds(CLEAN_STATIC), [], "纯中文静态提示文本应零命中 (否则本检查永远红, 等于永远假失败)");
});

test("estTokens/lcpChars: 与 ctx-profile 同口径的 tok 估算与字符级 LCP", () => {
  assert.equal(lcpChars("abcdef", "abcxef"), 3);
  assert.equal(lcpChars("abc", "abcdef"), 3, "较短串全等则 LCP = 短串长");
  assert.equal(estTokens("中文"), 2, "1 中文字 ≈ 1 tok");
  assert.equal(estTokens("abcd"), 1, "4 个 ASCII ≈ 1 tok");
});

// ---- 2) 四条不变量的判定逻辑: 干净载荷全绿 ----
test("合成干净会话: a/b/c/d 四项全过, 且稳定前缀 = tools+静态区", async () => {
  const caps = [
    mkCapture({ turn: 1, round: 1, messages: [{ role: "system", content: CLEAN_STATIC + "\n\n" + DYN_TAIL }, { role: "user", content: "问题一" }] }),
    mkCapture({ turn: 2, round: 1, memoryCtx: "\n# 今日对话\n今日已进行 2 轮对话\n\n# 长期记忆 (最近)\n(暂无)\n\n# 关键事实\n",
      messages: [{ role: "system", content: CLEAN_STATIC + "\n\n" + DYN_TAIL + "\n\n(第二趟检索段)" }, { role: "user", content: "问题一" }, { role: "assistant", content: "答" }, { role: "user", content: "问题二" }] }),
    mkCapture({ turn: 3, round: 1, memoryCtx: "\n# 今日对话\n今日已进行 4 轮对话\n\n# 长期记忆 (最近)\n(暂无)\n\n# 关键事实\n",
      messages: [{ role: "system", content: CLEAN_STATIC + "\n\n" + DYN_TAIL + "\n\n(第三趟检索段)" }, { role: "user", content: "问题一" }, { role: "assistant", content: "答" }, { role: "user", content: "问题二" }, { role: "assistant", content: "答二" }, { role: "user", content: "问题三" }] }),
  ];
  const audit = auditCaptures(caps, { second: caps, projectRoot: PROJECT_ROOT });
  for (const id of ["static_prefix_stability", "volatile_isolation", "tool_array_canonicality", "append_only_history"]) {
    assert.equal(checkOf(audit, id).pass, true, id + " 应通过, 实际: " + checkOf(audit, id).detail);
  }
  assert.ok(audit.metrics.stablePrefixChars > CLEAN_STATIC.length, "稳定前缀至少覆盖整个静态区");
  assert.equal(audit.metrics.staticTokens > 0, true);
});

// ---- 2') 每条不变量都能被抓到 (可证伪) ----
test("(a) 静态区里改一个字符 → static_prefix_stability FAIL 并报出区块", () => {
  const caps = [
    mkCapture({ turn: 1, round: 1 }),
    mkCapture({ turn: 2, round: 1, staticPart: CLEAN_STATIC + "\n【人格补充】今天心情不错" }),
    mkCapture({ turn: 3, round: 1, staticPart: CLEAN_STATIC.replace("直接务实", "直接务实, 且带一个变项") }),
  ];
  const c = checkOf(auditCaptures(caps, { projectRoot: PROJECT_ROOT }), "static_prefix_stability");
  assert.equal(c.pass, false, "静态区跨请求漂移必须判回归: " + c.detail);
  assert.match(c.detail, /静态区分叉/, "详情指明分叉");
  assert.ok(c.mismatches.length >= 2, "列出每个漂移的请求: " + JSON.stringify(c.mismatches).slice(0, 200));
  assert.ok(c.mismatches.every((m) => typeof m.at === "number" && "block" in m), "每个分叉带偏移 + 区块标签, 可直接路由到人");
});

test("(b) 静态区注入时间戳 → volatile_isolation FAIL (扫描半边独立生效)", () => {
  const poisoned = CLEAN_STATIC + "\n【画像更新】2026-10-04T09:12:33.000Z";
  const caps = [mkCapture({ turn: 1, round: 1, staticPart: poisoned }), mkCapture({ turn: 2, round: 1, staticPart: poisoned }),
    mkCapture({ turn: 3, round: 1, staticPart: poisoned })];
  const audit = auditCaptures(caps, { second: caps, projectRoot: PROJECT_ROOT });
  const c = checkOf(audit, "volatile_isolation");
  assert.equal(c.pass, false, "易变值进静态区即回归");
  assert.match(c.detail, /iso-timestamp/, "报告命中的模式名: " + c.detail);
  assert.match(c.detail, /区块\[/, "报告命中位置所属区块, 便于定位");
  // 关键: 三趟完全相同 → (a) 会话内 diff 与双实例 diff 都是绿的, 只有扫描抓得到。
  assert.equal(checkOf(audit, "static_prefix_stability").pass, true, "(a) 看不见这种日内不变的易变值 —— 扫描不是多余的");
});

test("(b) 记忆检索文本向上漂移 → 会话内 diff + 双实例 diff 双抓", () => {
  // 每个请求的静态尾部都多一条"新学到的条目": 这正是记忆行向上漂移进静态区的形态
  const driftCaps = (start) => Array.from({ length: 3 }, (_, i) =>
    mkCapture({ turn: i + 1, round: 1, staticPart: CLEAN_STATIC + "\n【经验】第" + (start + i) + "次学到的条目" }));
  const run = driftCaps(1), other = driftCaps(11);
  const audit = auditCaptures(run, { second: other, projectRoot: PROJECT_ROOT });
  const c = checkOf(audit, "volatile_isolation");
  assert.equal(c.pass, false, "检索/经验文本漂移进静态区即回归");
  assert.equal(c.subs.scan.length, 0, "这种漂移不含时间戳/随机值, 模式扫描看不见 —— 全靠 diff 两路");
  assert.equal(c.subs.withinSession, false, "会话内 diff 抓到 (静态区跨请求不恒定)");
  assert.equal(c.subs.crossInstance.pass, false, "双实例 diff 抓到");
  assert.match(c.subs.crossInstance.detail, /跨实例静态区差异/, "双实例 diff 报出偏移");
  assert.match(c.detail, /会话内静态区随请求变化/, "结论里带上失败的方法名");
});

test("(c) 工具数组顺序变动 → tool_array_canonicality FAIL 并把责任指向 catalog", () => {
  const swapped = [TOOLS_AB[1], TOOLS_AB[0]];
  const caps = [mkCapture({ turn: 1, round: 1 }), mkCapture({ turn: 2, round: 1, tools: swapped }), mkCapture({ turn: 3, round: 1 })];
  const c = checkOf(auditCaptures(caps, { projectRoot: PROJECT_ROOT }), "tool_array_canonicality");
  assert.equal(c.pass, false, "tools 在会话内变化即回归 (它在请求最前, 作废整个前缀)");
  assert.match(c.detail, /tools 数组在会话内发生变化/, "详情点明 tools");
  assert.match(c.detail, /src\/tools\/catalog\.js toOpenAI\(\)/, "定位到工具数组的装配点");
});

test("(c) 观测项: 名称规范序与否如实上报, 不影响恒定性判定", () => {
  const alphaFirst = TOOLS_AB;                    // 字典序 (规范序)
  const regOrder = [TOOLS_AB[1], TOOLS_AB[0]];    // 注册序: beta 在 alpha 前 → 非字典序
  const mk = (tools, i) => mkCapture({ turn: i + 1, round: 1, tools });
  const sortedAudit = auditCaptures([0, 1, 2].map((i) => mk(alphaFirst, i)), { projectRoot: PROJECT_ROOT });
  assert.equal(checkOf(sortedAudit, "tool_array_canonicality").canonicalByName, true, "字典序载荷应被识别为规范序");
  const c = checkOf(auditCaptures([0, 1, 2].map((i) => mk(regOrder, i)), { projectRoot: PROJECT_ROOT }), "tool_array_canonicality");
  assert.equal(c.pass, true, "恒定但非字典序不是回归 (缓存只要求字节稳定)");
  assert.equal(c.canonicalByName, false, "但仍要上报: 序 = Map 注册序, 依赖装配时序恒定");
  assert.match(c.detail, /是否名称规范序: 否/, "详情里写明非规范序及其含义: " + c.detail);
});

test("(d) 既有消息被改写 → append_only_history FAIL (钉住错误重试不改历史)", () => {
  const sysMsg = { role: "system", content: CLEAN_STATIC + "\n\n" + DYN_TAIL };
  const u1 = { role: "user", content: "问题一" };
  const a1 = { role: "assistant", content: "第一轮答复" };
  const a1tampered = { role: "assistant", content: "被重试改写的第一轮答复" };
  const u2 = { role: "user", content: "问题二" };
  const caps = [
    mkCapture({ turn: 1, round: 1, messages: [sysMsg, u1, a1] }),
    mkCapture({ turn: 1, round: 2, messages: [sysMsg, u1, a1tampered] }), // 轮内: 长度不变, 第 2 条被改写
    mkCapture({ turn: 1, round: 3, messages: [sysMsg, u1, a1tampered, u2] }),
    mkCapture({ turn: 2, round: 1, messages: [sysMsg, u1, a1tampered, u2] }),
  ];
  const audit = auditCaptures(caps, { projectRoot: PROJECT_ROOT });
  const c = checkOf(audit, "append_only_history");
  assert.equal(c.pass, false, "改写既有消息即违反 append-only");
  assert.match(c.detail, /违反 append-only/, "详情点明违规");
  assert.match(c.detail, /"msgIndex":2/, "报出被改写的消息下标: " + c.detail);
  // 静态区没动 → (a) 仍应通过: 四项检查各自独立, append-only 违规不该被前缀检查吞掉
  assert.equal(checkOf(audit, "static_prefix_stability").pass, true);
});

test("(d) 溢出降档缩水也要被抓到; 跨轮历史丢弃同样判失败", () => {
  const sysMsg = { role: "system", content: CLEAN_STATIC + "\n\n" + DYN_TAIL };
  const full = [sysMsg, { role: "user", content: "问题一" }, { role: "assistant", content: "答复一" }];
  const shrunk = [sysMsg, { role: "user", content: "被截断后仅剩的问题" }]; // 消息数缩水 (溢出降档重写历史)
  const caps = [
    mkCapture({ turn: 1, round: 1, messages: full }),
    mkCapture({ turn: 1, round: 2, messages: shrunk }),
    mkCapture({ turn: 2, round: 1, messages: shrunk }),
  ];
  const c = checkOf(auditCaptures(caps, { projectRoot: PROJECT_ROOT }), "append_only_history");
  assert.equal(c.pass, false, "轮内消息数缩水 (疑似溢出降档改写) 即失败");
  assert.match(c.detail, /消息数缩水/, "给出缩水原因: " + c.detail);
});

test("(d) 检查范围诚实标注: 跨轮完整列表前缀按设计不成立", () => {
  const audit = auditCaptures([mkCapture({ turn: 1, round: 1 }), mkCapture({ turn: 2, round: 1 }), mkCapture({ turn: 3, round: 1 })], { projectRoot: PROJECT_ROOT });
  assert.match(checkOf(audit, "append_only_history").scopeNote, /system 动态尾/, "必须写明只比非 system 轮首→轮首, 不让读者以为它覆盖跨轮全量");
});

// ---- 3) 真跑层: 真实 agent + 捕获桩, 零网络 ----
test("真跑会话: 脚本化多轮 (含工具往返) 产出 ≥3 个出户请求, 且确实经过真实提示词管线", async () => {
  const audit = await auditReal();
  assert.ok(audit.metrics.captures >= 3, "至少 3 个真实请求载荷, 实际 " + audit.metrics.captures);
  assert.equal(audit.pairs.length, audit.metrics.captures - 1);
  assert.ok(audit.metrics.pairs.some((p) => p.turnBoundary), "存在跨轮请求对 (仅 userMsg 不同的输入)");
  assert.ok(audit.metrics.pairs.some((p) => p.sameTurn), "存在轮内请求对 (工具往返)");
  assert.match(checkOf(audit, "append_only_history").detail, /含工具往返: 是/, "工具往返确实发生 (审计覆盖 tool 消息形态)");
  assert.equal(checkOf(audit, "static_prefix_stability").pass, true, "(a) 真实管线当前应通过: " + checkOf(audit, "static_prefix_stability").detail);
  assert.equal(checkOf(audit, "tool_array_canonicality").pass, true, "(c) 真实管线当前应通过: " + checkOf(audit, "tool_array_canonicality").detail);
  assert.equal(checkOf(audit, "append_only_history").pass, true, "(d) 真实管线当前应通过: " + checkOf(audit, "append_only_history").detail);
});

test("真跑度量: 可缓存稳定前缀越过 AWS 最小 checkpoint 512 tok (报告口径)", async () => {
  const audit = await auditReal();
  const m = audit.metrics;
  assert.ok(m.toolsTokens > 0 && m.staticTokens > 0, "tools/静态区规模可测");
  assert.ok(m.stablePrefixTokens >= 512, "稳定前缀 ≈" + m.stablePrefixTokens + " tok, 需越过最小可缓存档位 512 tok");
  assert.match(m.verdict, /已越过 AWS 最小可缓存 checkpoint/, "判定句自洽: " + m.verdict);
  assert.ok(m.rebilledTailTokensAvg < m.stablePrefixTokens, "每请求重计费尾部远小于稳定前缀 (重排的目的)");
});

test("真跑 (b): 四个子方法都真的执行过, 结论必须与子方法自洽 (不断言今日绿/今日红)", async (t) => {
  const audit = await auditReal();
  const c = checkOf(audit, "volatile_isolation");
  const s = c.subs;
  assert.equal(Array.isArray(s.scan), true, "模式扫描已执行");
  assert.equal(typeof s.withinSession, "boolean", "会话内 diff 已执行");
  assert.equal(s.crossInstance.detail.includes("未提供第二实例"), false, "双实例 diff 已执行 (runFullAudit 必须传第二实例)");
  assert.equal(s.learnRelaunch.ran, true, "学习→重启 探针已执行 (否则 (b) 少一条因果证据, 变成永远可能假通过)");
  assert.equal(c.pass, s.scan.length === 0 && s.withinSession && s.crossInstance.pass && s.learnRelaunch.pass,
    "(b) 的判定完全由子方法决定, 无隐藏放行: " + c.detail);
  if (!c.pass) assert.match(c.detail, /静态区|漂移/, "失败时给出可定位原因");
  t.diagnostic("(b) 易变值隔离 今日判定 = " + (c.pass ? "PASS" : "FAIL") + " :: " + c.detail.slice(0, 300));
});

test("真跑 (c): 工具数组字节恒定 + 跨实例一致, 并如实上报是否名称规范序", async () => {
  const audit = await auditReal();
  const c = checkOf(audit, "tool_array_canonicality");
  assert.equal(c.stable, true);
  assert.ok(c.order.length > 0, "记录到工具清单: " + c.order.length + " 个");
  assert.equal(typeof c.canonicalByName, "boolean", "规范序与否必须上报 (供路由: 非规范序时任何注册时序变化都作废前缀)");
});

test("学习→重启 探针可复现: 同目录重启后静态区要么恒定, 要么报出区块与偏移", async () => {
  const r = await memoryDriftProbe({ projectRoot: PROJECT_ROOT });
  assert.equal(r.ran, true);
  if (!r.pass) {
    assert.match(r.detail, /学习→重启 漂移/, "详情说明因果实验: " + r.detail.slice(0, 80));
    assert.ok(typeof r.offset === "number" && r.offset >= 0, "报出静态区首个变化偏移");
    assert.ok(r.block && r.block.length > 0, "报出变化所在区块: " + r.block);
  } else {
    assert.ok(r.staticChars > 0, "通过时也要给出被比较的静态区规模");
  }
});

// ---- 4) 负例: 夹具注入易变值 (只 monkey-patch 实例, 绝不改生产提示词代码) ----
test("负例夹具 volatile-clock (进程内): 审计器报出 (a)(b) 回归并定位到被注入区块", async () => {
  const audit = await runFullAudit({ fixture: FIXTURES["volatile-clock"] });
  const a = checkOf(audit, "static_prefix_stability");
  const b = checkOf(audit, "volatile_isolation");
  assert.equal(a.pass, false, "往 persona 静态块贴 new Date().toISOString() 必须被 (a) 抓到");
  assert.equal(b.pass, false, "同一注入必须同时被 (b) 的易变值扫描抓到");
  assert.match(b.detail, /iso-timestamp/, "(b) 报出命中模式: " + b.detail.slice(0, 160));
  assert.match(a.detail, /clock/, "(a) 的分叉样例里能看到注入标记: " + a.detail.slice(0, 200));
  // 负例不能污染其它检查: tools/append-only 与提示词无关, 仍应通过 (证明四项彼此独立, 不是一荣俱荣)
  assert.equal(checkOf(audit, "tool_array_canonicality").pass, true);
  assert.equal(checkOf(audit, "append_only_history").pass, true);
  assert.ok(audit.metrics.stablePrefixTokens < (await auditReal()).metrics.stablePrefixTokens,
    "注入后稳定前缀应当显著缩短 (缓存收益真被削掉)");
});

test("负例夹具 static-drift (进程内): 经验静态块递增计数被 (a) 抓到", async () => {
  const audit = await runFullAudit({ fixture: FIXTURES["static-drift"] });
  const a = checkOf(audit, "static_prefix_stability");
  assert.equal(a.pass, false, "静态块尾部逐请求增长必须判回归");
  assert.match(a.detail, /drift/, "分叉样例里能看到注入标记: " + a.detail.slice(0, 200));
});

test("负例经 CLI 子进程: --fixture=volatile-clock 必须非零退出并输出 FAIL 行", () => {
  const pr = spawnSync(process.execPath, ["scripts/cache-audit.js", "--fixture=volatile-clock", "--json"],
    { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 180000 });
  assert.equal(pr.status, 1, "存在回归时 CLI 必须以 1 退出 (stdout 前 200: " + String(pr.stdout).slice(0, 200) + " stderr: " + String(pr.stderr).slice(0, 200) + ")");
  const j = JSON.parse(pr.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.offline, true);
  assert.equal(j.fixture, "volatile-clock");
  const failed = j.checks.filter((c) => c.result === "FAIL").map((c) => c.id);
  assert.deepEqual(failed, ["static_prefix_stability", "volatile_isolation"], "恰好这两项回归: " + failed.join(","));
});

test("CLI 语义: --help 退 0, 未知/缺值 fixture 退 2 (闸门不能有第三种退出码)", () => {
  const help = spawnSync(process.execPath, ["scripts/cache-audit.js", "--help"], { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 60000 });
  assert.equal(help.status, 0, "--help 只打印用法: " + String(help.stderr).slice(0, 200));
  assert.match(help.stdout, /退出码/);
  const bad = spawnSync(process.execPath, ["scripts/cache-audit.js", "--fixture=nope"], { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 60000 });
  assert.equal(bad.status, 2, "非法夹具名是用法错误, 不能与回归 (1) 混淆");
  assert.match(bad.stderr, /fixture/);
  const badArg = spawnSync(process.execPath, ["scripts/cache-audit.js", "--wat"], { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 60000 });
  assert.equal(badArg.status, 2, "未知参数同样退 2");
});

test("审计脚本零网络: 脚本链路上不存在任何 http 客户端入口 (离线闸门的底线)", () => {
  const files = [path.join(PROJECT_ROOT, "scripts", "cache-audit.js"), path.join(PROJECT_ROOT, "scripts", "lib", "cache-audit-core.js")];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /node:(?:http|https|net|dgram|tls)/, path.basename(f) + " 不应引入任何网络模块");
    assert.doesNotMatch(src, /fetch\(/, path.basename(f) + " 不应直接 fetch");
    assert.doesNotMatch(src, /import \{[^}]*\} from "\.\.\/src\/llm\/client\.js"/, path.basename(f) + " 不该直连真实 LLM 客户端");
  }
  assert.ok(SCRIPT_TURNS.length >= 3, "脚本会话至少 3 轮, 保证 ≥3 个请求载荷");
});
