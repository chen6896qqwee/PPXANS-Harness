// test/permission-intersection.test.js — 委派权限交集不变量 (吸收 Codex
// permission_profile_intersection, 2026-10-05)
//
// 不变量原文: "A policy cannot be intersected without weakening either input."
// 本文件钉三层:
//   ① 字段级不变量 checker (invariantViolations): 结果永不得比任一输入更宽 ——
//      sandbox/审批取更严、网络需一致、deny 赢、单侧 allow 不继承、根互不包含/不可解析 → 终止锁死。
//   ② 随机化性质测试 (200 对): checker 违例为空 + 引擎级 "结果放行 ⇒ 双亲都放行"。
//   ③ 变异体检查 (mutant): 人为把结果改宽的一个档位 (sandbox/network/规则增删), checker 必须报违例 ——
//      "若某规则组合能扩权, 测试必须红" 由这条钉住, 不是口号。
//   ④ 表驱动真实档位语料 (argv/路径/网络/符号链接样/畸形规则/绝对逃逸/../) 经真实 check() 断言拒绝。
//   ⑤ 委派边界 (spawn_agent): 交集结论落到既有 PPX_AGENT_READONLY 杠杆; 无收紧时与今天逐字节一致。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import {
  createPermissionEngine, AskForApproval, SandboxPolicy, isWithinRoot,
} from "../src/permissions/index.js";
import {
  intersectPermissionProfiles, profileFromEngine, childSpawnEnv,
  SANDBOX_RESTRICTION_RANK, APPROVAL_RESTRICTION_RANK,
} from "../src/permissions/intersection.js";
import { runWithTrace } from "../src/core/trace.js";

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-isect-${tag}-`)); }

// ---- ① 字段级不变量 checker (性质测试与变异体检查共用同一把尺) ----
function foldAction(profile) {
  const map = new Map();
  for (const r of (profile.rules || [])) {
    const prev = map.get(r.pattern);
    const rank = { allow: 0, ask: 1, deny: 2 }[r.action];
    if (prev === undefined || rank > ({ allow: 0, ask: 1, deny: 2 }[prev])) map.set(r.pattern, r.action);
  }
  return map;
}
function invariantViolations(r, a, b) {
  const v = [];
  const sRank = (p, label) => {
    if (p === undefined) return { rank: SANDBOX_RESTRICTION_RANK[SandboxPolicy.READ_ONLY], label };
    const rank = Object.prototype.hasOwnProperty.call(SANDBOX_RESTRICTION_RANK, p) ? SANDBOX_RESTRICTION_RANK[p] : null;
    if (rank === null) return { bad: true };
    return { rank, label };
  };
  const aRank = (p) => (p === undefined ? APPROVAL_RESTRICTION_RANK[AskForApproval.UNLESS_TRUSTED]
    : APPROVAL_RESTRICTION_RANK[p] ?? null);
  // 沙箱/审批: 结果 rank 必须 >= 任一输入 rank (更严或等); 未知值 = 违例
  const sa = sRank(a.sandbox), sb = sRank(b.sandbox), sr = sRank(r.sandbox);
  if (sr.bad) v.push("结果沙箱档位未知");
  else {
    // 输入档位不可序本身就是违例 (交集必须终止), 但锁死结果无需再与未知档比较宽严
    if (sa.bad) { if (!r.terminated) v.push("a.sandbox 不可序但交集未终止"); }
    else if (sr.rank < sa.rank) v.push(`结果沙箱比 a 更宽: ${r.sandbox} vs ${a.sandbox}`);
    if (sb.bad) { if (!r.terminated) v.push("b.sandbox 不可序但交集未终止"); }
    else if (sr.rank < sb.rank) v.push(`结果沙箱比 b 更宽: ${r.sandbox} vs ${b.sandbox}`);
  }
  const aa = aRank(a.approvalMode), ab = aRank(b.approvalMode), ar = aRank(r.approvalMode);
  if (ar === null) v.push("结果审批档位未知");
  else if (aa !== null && ar < aa) v.push(`结果审批比 a 更宽: ${r.approvalMode} vs ${a.approvalMode}`);
  else if (ab !== null && ar < ab) v.push(`结果审批比 b 更宽: ${r.approvalMode} vs ${b.approvalMode}`);
  // 网络需一致: 结果 true 只有两侧都 true 才允许
  if (r.networkAccess === true && !(a.networkAccess === true && b.networkAccess === true)) {
    v.push("网络未一致同意却放行 (需双亲都 true)");
  }
  // plan (限制态) OR: 任一在 plan, 结果必须也在 plan
  if ((a.planEnabled === true || b.planEnabled === true) && r.planEnabled !== true) {
    v.push("一侧处于 plan 限制态, 结果丢了这半边约束");
  }
  const ma = foldAction(a), mb = foldAction(b), mr = foldAction(r);
  // 结果规则表必须是"每 pattern 唯一 + 折叠后档位"的规范形: 同 pattern 后跟更宽条目,
  // 在 last-match-wins 引擎里就是扩权 (变异体检查靠这条判红"追加 allow 覆盖 deny")。
  const seen = new Set();
  for (const rule of (r.rules || [])) {
    if (seen.has(rule.pattern)) v.push(`结果规则未规范化: pattern "${rule.pattern}" 出现多次 (后出现条目会覆盖先出现 = 扩权通道)`);
    seen.add(rule.pattern);
    if (mr.get(rule.pattern) !== rule.action) v.push(`结果规则非折叠档位: ${rule.pattern}=${rule.action} (折叠应为 ${mr.get(rule.pattern)})`);
  }
  if (r.terminated) {
    // 终止 = 全锁死: "*" deny 是锁死本体 (下方 lockdownOk 校验其形状), 只能收紧不可能是扩权;
    // 逐 pattern 出处/贯穿检查对锁死档位无意义, 但锁死里绝不允许出现任何非 deny 条目。
    for (const rule of (r.rules || [])) {
      if (rule.action !== "deny") v.push(`终止锁死结果混入非 deny 规则: ${rule.pattern}=${rule.action}`);
    }
  } else {
    for (const [pattern, act] of mr) {
      if (act === "deny" && !(ma.get(pattern) === "deny" || mb.get(pattern) === "deny")) {
        v.push(`deny 来源不明: ${pattern} (伪造 deny 不算扩权, 但语义必须有出处)`);
      }
      if (act === "allow" && !(ma.get(pattern) === "allow" && mb.get(pattern) === "allow")) {
        v.push(`单侧/凭空 allow 被继承: ${pattern} —— 写权需双亲同意`);
      }
      if (act === "ask" && !(ma.get(pattern) === "ask" || mb.get(pattern) === "ask")) {
        v.push(`ask 来源不明: ${pattern}`);
      }
    }
    // deny 赢: 任一输入 deny 的 pattern, 结果必须是 deny
    for (const src of [ma, mb]) {
      for (const [pattern, act] of src) {
        if (act === "deny" && mr.get(pattern) !== "deny") v.push(`deny 未贯穿: ${pattern}`);
      }
    }
    // ask 也不许蒸发: 任一输入 ask 的 pattern, 结果至少 ask (deny 更严可接受)
    for (const src of [ma, mb]) {
      for (const [pattern, act] of src) {
        if (act === "ask" && mr.get(pattern) !== "ask" && mr.get(pattern) !== "deny") v.push(`ask 未贯穿: ${pattern}`);
      }
    }
  }
  // 工作区根: 未终止时, 结果根必须包含于每个给了根的输入 (判定复用 isWithinRoot, 单一真相源)
  if (!r.terminated && r.workspaceRoot) {
    for (const [p, label] of [[a, "a"], [b, "b"]]) {
      if (p.workspaceRoot && !isWithinRoot(r.workspaceRoot, p.workspaceRoot)) {
        v.push(`结果根不在 ${label} 根内: ${r.workspaceRoot} vs ${p.workspaceRoot}`);
      }
    }
  }
  if (r.terminated) {
    const lockdownOk = r.sandbox === SandboxPolicy.READ_ONLY
      && r.approvalMode === AskForApproval.UNLESS_TRUSTED
      && r.networkAccess === false
      && r.planEnabled === true
      && (r.rules || []).some((x) => x.pattern === "*" && x.action === "deny");
    if (!lockdownOk) v.push("终止交集未落到全锁死档位 (fail-closed 破坏)");
  }
  return v;
}

// ---- ② 随机化性质测试 (确定性 LCG, 可复现) + 引擎级 allow 集合单调 ----
const SAMPLES = [
  ["read_file", { path: "a.txt" }],
  ["write_file", { path: "sub/b.txt" }],
  ["write_file", { path: "../escape.txt" }],
  ["run_command", { command: "rm -rf x" }],
  ["run_command", { command: "git push" }],
  ["http_request", { url: "https://example.com" }],
];
function engineFor(p, defaultRoot) {
  return createPermissionEngine({
    approvalMode: p.approvalMode ?? AskForApproval.ON_REQUEST,
    sandbox: p.sandbox ?? SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: p.workspaceRoot || defaultRoot,
    networkAccess: p.networkAccess ?? false,
    rules: p.rules ? p.rules.slice() : [],
    planEnabled: p.planEnabled === true,
  });
}

test("性质: 200 对随机档位, 交集永不比任一输入更宽 (字段级 + 引擎 allow 集合)", async () => {
  let s = 20261005 >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length];
  const roots = ["__undef__", "base", "nested", "other"];
  const patterns = ["read_file", "write_file", "run_command", "http_request", "spawn_agent", "git *"];
  const actions = ["allow", "ask", "deny"];
  const mkProfile = () => {
    const p = {
      sandbox: pick(Object.values(SandboxPolicy)),
      approvalMode: pick(Object.values(AskForApproval)),
      networkAccess: rand() < 0.5,
      planEnabled: rand() < 0.2,
    };
    const rk = pick(roots);
    if (rk !== "__undef__") p.workspaceRoot = rk === "base" ? base : rk === "nested" ? nested : other;
    if (rand() < 0.7) {
      const n = Math.floor(rand() * 3);
      p.rules = Array.from({ length: n }, () => ({ pattern: pick(patterns), action: pick(actions) }));
    }
    return p;
  };
  const base = tmp("prop-base");
  const nested = path.join(base, "sub");
  const other = tmp("prop-other");
  const problems = [];
  for (let i = 0; i < 200; i++) {
    const a = mkProfile(); const b = mkProfile();
    const r = intersectPermissionProfiles(a, b);
    for (const v of invariantViolations(r, a, b)) problems.push(`#${i} ${v}\n  a=${JSON.stringify(a)}\n  b=${JSON.stringify(b)}\n  r=${JSON.stringify(r)}`);
    // 引擎级: 结果放行 ⇒ 双亲都放行 (allow 集合单调, deny/ask 之别不在断言内)
    const [ra, rb, rr] = [engineFor(a, base), engineFor(b, base), engineFor({ ...r, workspaceRoot: r.workspaceRoot || base }, base)];
    for (const [tool, args] of SAMPLES) {
      const [da, db, dr] = [(await ra.check(tool, args)).decision, (await rb.check(tool, args)).decision, (await rr.check(tool, args)).decision];
      if (dr === "allow" && (da !== "allow" || db !== "allow")) {
        problems.push(`#${i} 引擎扩权: ${tool} ${JSON.stringify(args)} 结果 allow 但 a=${da} b=${db}`);
      }
    }
  }
  assert.deepEqual(problems, [], `交集不变量违例:\n${problems.slice(0, 8).join("\n")}`);
});

// ---- ③ 变异体检查: 结果一旦被改宽, 尺子必须响 ----
test("变异体: 任何扩权组合都会被 invariantViolations 判红", () => {
  const base = tmp("mut");
  const a = { sandbox: SandboxPolicy.READ_ONLY, approvalMode: AskForApproval.ON_REQUEST, networkAccess: false, rules: [{ pattern: "run_command", action: "deny" }], workspaceRoot: base, planEnabled: false };
  const b = { sandbox: SandboxPolicy.WORKSPACE_WRITE, approvalMode: AskForApproval.NEVER, networkAccess: true, rules: [], workspaceRoot: base, planEnabled: true };
  const r = intersectPermissionProfiles(a, b);
  assert.deepEqual(invariantViolations(r, a, b), [], "真结果必须干净");
  // mutant1: 沙箱放宽 (READ_ONLY → DANGER)
  assert.ok(invariantViolations({ ...r, sandbox: SandboxPolicy.DANGER_FULL_ACCESS }, a, b).length > 0, "沙箱扩权必须红");
  // mutant2: 网络单边打开
  assert.ok(invariantViolations({ ...r, networkAccess: true }, a, b).length > 0, "网络扩权必须红");
  // mutant3: 凭空给 run_command 发 allow —— 而 a 侧本就 deny
  assert.ok(invariantViolations({ ...r, rules: [...r.rules, { pattern: "run_command", action: "allow" }] }, a, b).length > 0, "伪造/继承 allow 必须红");
  // mutant4: 删掉贯穿下来的 deny —— deny 未赢
  assert.ok(invariantViolations({ ...r, rules: r.rules.filter((x) => x.pattern !== "run_command") }, a, b).length > 0, "deny 蒸发必须红");
  // mutant5: 丢掉 plan 限制态 (b 在 plan)
  assert.ok(invariantViolations({ ...r, planEnabled: false }, a, b).length > 0, "plan 约束蒸发必须红");
  // mutant6: 根跑出父根之外
  assert.ok(invariantViolations({ ...r, workspaceRoot: tmp("mut-out") }, a, b).length > 0, "根扩权必须红");
});

// ---- ④ 限制性排序显式钉死 (不许"想当然") ----
test("排序显式声明: READ_ONLY ⊂ WORKSPACE_WRITE ⊂ DANGER_FULL_ACCESS; never ⊂ … ⊂ unless-trusted", () => {
  assert.ok(SANDBOX_RESTRICTION_RANK[SandboxPolicy.READ_ONLY] > SANDBOX_RESTRICTION_RANK[SandboxPolicy.WORKSPACE_WRITE]);
  assert.ok(SANDBOX_RESTRICTION_RANK[SandboxPolicy.WORKSPACE_WRITE] > SANDBOX_RESTRICTION_RANK[SandboxPolicy.DANGER_FULL_ACCESS]);
  assert.ok(APPROVAL_RESTRICTION_RANK[AskForApproval.UNLESS_TRUSTED] > APPROVAL_RESTRICTION_RANK[AskForApproval.ON_REQUEST]);
  assert.ok(APPROVAL_RESTRICTION_RANK[AskForApproval.ON_REQUEST] > APPROVAL_RESTRICTION_RANK[AskForApproval.ON_FAILURE]);
  assert.ok(APPROVAL_RESTRICTION_RANK[AskForApproval.ON_FAILURE] > APPROVAL_RESTRICTION_RANK[AskForApproval.NEVER]);
  // 冲突取更严: 宽窄两两相交落点
  const narrow = { sandbox: SandboxPolicy.READ_ONLY, approvalMode: AskForApproval.UNLESS_TRUSTED, networkAccess: false };
  const wide = { sandbox: SandboxPolicy.DANGER_FULL_ACCESS, approvalMode: AskForApproval.NEVER, networkAccess: true };
  const r = intersectPermissionProfiles(narrow, wide);
  assert.equal(r.sandbox, SandboxPolicy.READ_ONLY);
  assert.equal(r.approvalMode, AskForApproval.UNLESS_TRUSTED);
  assert.equal(r.networkAccess, false);
  const r2 = intersectPermissionProfiles(wide, narrow);
  assert.deepEqual([r2.sandbox, r2.approvalMode, r2.networkAccess], [r.sandbox, r.approvalMode, r.networkAccess], "交集对称");
});

// ---- ⑤ 具体语料: 绝对逃逸路径 / ../ / glob / symlink-ish / 畸形规则 / 互斥根 —— 每个都断言拒绝 ----
test("语料: 不可解析与越界输入 → 引擎级拒绝 (fail closed, 不沉默放行)", async () => {
  const base = tmp("corp");
  const other = tmp("corp-other");
  const mkEng = (p) => engineFor({ ...p, workspaceRoot: p.workspaceRoot || base }, base);
  const wide = { sandbox: SandboxPolicy.DANGER_FULL_ACCESS, approvalMode: AskForApproval.NEVER, networkAccess: true, rules: [] };
  const ww = { sandbox: SandboxPolicy.WORKSPACE_WRITE, approvalMode: AskForApproval.ON_REQUEST, networkAccess: true, rules: [], workspaceRoot: base };

  // 1) 绝对逃逸: 子请求 DANGER 也压不回 WORKSPACE —— base 外写入被引擎 deny
  const r1 = intersectPermissionProfiles(ww, { ...wide, workspaceRoot: undefined });
  const e1 = mkEng(r1);
  assert.equal((await e1.check("write_file", { path: path.join(other, "evil.txt") })).decision, "deny", "绝对逃逸路径必须拒");
  assert.equal((await e1.check("write_file", { path: "../evil.txt" })).decision, "deny", "../ 相对逃逸必须拒");

  // 2) glob 根: 无法穷举落点 → 终止交集 → 全锁死 (连 read_file 也拒)
  const r2 = intersectPermissionProfiles(ww, { ...wide, workspaceRoot: "*.js" });
  assert.equal(r2.terminated, true);
  assert.notEqual((await mkEng(r2).check("read_file", { path: "a.txt" })).decision, "allow", "glob 根: 拒绝, 不许 allow-by-silence");

  // 3) symlink-ish (Windows 设备命名空间/UNC, reparse 目标不可判): 终止
  for (const bad of ["\\\\?\\C:\\Users", "\\\\share\\dir"]) {
    const r3 = intersectPermissionProfiles(ww, { ...wide, workspaceRoot: bad });
    assert.equal(r3.terminated, true, `不可判根必须终止交集: ${bad}`);
    assert.notEqual((await mkEng(r3).check("read_file", { path: "a.txt" })).decision, "allow");
  }

  // 4) 畸形规则: 引擎解析不了 → 终止 + 全锁死
  const r4 = intersectPermissionProfiles(ww, { ...wide, rules: [{ pattern: "run_command", action: "perhaps" }] });
  assert.equal(r4.terminated, true);
  assert.equal((await mkEng(r4).check("read_file", { path: "a.txt" })).decision, "deny");

  // 5) 非对象输入: 同样锁死
  const r5 = intersectPermissionProfiles(null, ww);
  assert.equal(r5.terminated, true);
  assert.equal((await mkEng(r5).check("http_request", { url: "https://example.com" })).decision, "deny");

  // 6) 两侧根互不包含: 无法交集 → 终止 (不取并集、不猜)
  const r6 = intersectPermissionProfiles({ ...ww, workspaceRoot: base }, { ...ww, workspaceRoot: other });
  assert.equal(r6.terminated, true, "互不包含的根必须终止");

  // 7) 嵌套根: 取更深一侧 (更严)。注意相对路径按各自 root 解析 (findEscape 口径),
  //    所以"父根内、子根外"必须用绝对路径表达。
  const nested = path.join(base, "sub");
  fs.mkdirSync(nested, { recursive: true });
  const r7 = intersectPermissionProfiles({ ...ww, workspaceRoot: base }, { ...ww, workspaceRoot: nested });
  assert.equal(path.resolve(r7.workspaceRoot), nested);
  const e7 = mkEng(r7);
  assert.equal((await e7.check("write_file", { path: path.join(base, "outside-sub.txt") })).decision, "deny", "子根外(父根内)的绝对写点被收窄拒绝");
  assert.equal((await e7.check("write_file", { path: "x.txt" })).decision, "allow", "子根内的写仍放行 (收窄不误伤)");

  // 8) 网络需一致: a 开 b 关 → 结果关 → 网络类工具不再静默直通
  const r8 = intersectPermissionProfiles({ ...ww, networkAccess: true }, { ...ww, networkAccess: false });
  assert.equal(r8.networkAccess, false);
  assert.notEqual((await mkEng(r8).check("http_request", { url: "https://example.com" })).decision, "allow", "网络未一致同意不得 allow");

  // 9) deny 赢且压过 allow (变异体捕手的语料半边): b 侧 allow 排在 deny 之后 ——
  //    朴素 last-match-wins 拼接会 allow, 交集语义必须仍 deny。
  const r9 = intersectPermissionProfiles(
    { ...ww, rules: [{ pattern: "rm *", action: "deny" }] },
    { ...ww, rules: [{ pattern: "rm *", action: "deny" }, { pattern: "rm *", action: "allow" }] },
  );
  assert.deepEqual(r9.rules.filter((x) => x.pattern === "rm *"), [{ pattern: "rm *", action: "deny" }]);
  assert.equal((await mkEng(r9).check("run_command", { command: "rm -rf /tmp/x" })).decision, "deny", "deny 永远赢, 与顺序无关");

  // 10) 单侧 allow 不继承 (写权需双亲同意): a allow / b 沉默 → 规则被丢弃
  const r10 = intersectPermissionProfiles(
    { ...ww, rules: [{ pattern: "spawn_agent", action: "allow" }] },
    { ...ww, rules: [] },
  );
  assert.deepEqual(r10.rules, [], "单边 allow 不得进入结果");
  assert.ok(r10.reasons.some((x) => /丢弃/.test(x)), "丢弃必须留可判读理由");

  // 11) plan OR: 一侧 plan → 结果 plan, 连只读工具外的调用全拒
  const r11 = intersectPermissionProfiles({ ...ww, planEnabled: true }, ww);
  assert.equal(r11.planEnabled, true);
  assert.equal((await mkEng(r11).check("write_file", { path: "a.txt" })).decision, "deny");
});

// ---- 幂等 + profileFromEngine ----
test("交集幂等: p ∩ p 与 p 决策一致; profileFromEngine 如实反映引擎", async () => {
  const base = tmp("idem");
  const p = {
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    approvalMode: AskForApproval.ON_REQUEST,
    networkAccess: true,
    rules: [{ pattern: "rm *", action: "deny" }, { pattern: "git *", action: "allow" }],
    workspaceRoot: base,
  };
  const r = intersectPermissionProfiles(p, p);
  assert.equal(r.terminated, false);
  assert.equal(r.sandbox, p.sandbox);
  assert.equal(r.approvalMode, p.approvalMode);
  assert.equal(r.networkAccess, true);
  assert.deepEqual([...r.rules].sort((x, y) => x.pattern.localeCompare(y.pattern)),
    [...p.rules].sort((x, y) => x.pattern.localeCompare(y.pattern)));
  const eng = createPermissionEngine({ ...p });
  const prof = profileFromEngine(eng);
  assert.equal(prof.sandbox, SandboxPolicy.WORKSPACE_WRITE);
  assert.equal(prof.approvalMode, AskForApproval.ON_REQUEST);
  assert.equal(prof.workspaceRoot, base);
  const rr = intersectPermissionProfiles(prof, prof);
  for (const [tool, args] of SAMPLES) {
    assert.equal((await engineFor(rr, base).check(tool, args)).decision, (await eng.check(tool, args)).decision,
      `幂等破坏: ${tool}`);
  }
});

// ---- childSpawnEnv: 交集结论 → 既有杠杆 ----
test("childSpawnEnv: 只读/锁死/plan → PPX_AGENT_READONLY; 无收紧 → {} (与今天一致)", () => {
  assert.deepEqual(childSpawnEnv({ sandbox: SandboxPolicy.READ_ONLY }), { PPX_AGENT_READONLY: "1" });
  assert.deepEqual(childSpawnEnv({ sandbox: SandboxPolicy.WORKSPACE_WRITE, terminated: true }), { PPX_AGENT_READONLY: "1" });
  assert.deepEqual(childSpawnEnv({ sandbox: SandboxPolicy.WORKSPACE_WRITE, planEnabled: true }), { PPX_AGENT_READONLY: "1" });
  assert.deepEqual(childSpawnEnv(null), { PPX_AGENT_READONLY: "1" }, "拿不到档位 = 失败关闭");
  assert.deepEqual(childSpawnEnv({ sandbox: SandboxPolicy.WORKSPACE_WRITE }), {});
  assert.deepEqual(childSpawnEnv({ sandbox: SandboxPolicy.DANGER_FULL_ACCESS }, true), { PPX_AGENT_READONLY: "1" }, "请求只读必须尊重");
});

// ---- ⑥ 委派边界: spawn_agent 用交集收窄子进程, 默认路径零变化 ----
function mockLegion(captured) {
  return {
    spawnAgent: (name, opts) => { captured.push({ name, opts }); },
    send: async () => ({ reply: "ok" }),
    killAgent: () => true,
  };
}
test("委派边界: 子 agent 档位 = 请求 ∩ 父生效; 父只读/在 plan → 子必挂只读杠杆", async () => {
  const agent = new PPXAgent({ root: tmp("dlg"), dataDir: tmp("dlg-data") });
  try {
    agent.llm = { chat: async () => ({ content: "x" }) }; // 占位, 满足"已配置模型", 不触网
    const captured = [];
    agent._legion = mockLegion(captured);

    // 默认 (workspace-write, 非 plan, 无专家): 与修复前逐字节一致 —— env {}
    await agent.tools.call("spawn_agent", { task: "t" }, { agent });
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].opts.env, {}, "无委派收窄时不注入任何 env (父路径零变化)");

    // 父在运行时切到只读档位 (applyPreset 语义): 子进程今天会逃逸父限制, 现必须被收窄
    captured.length = 0;
    agent.permissions.sandbox = SandboxPolicy.READ_ONLY;
    await agent.tools.call("spawn_agent", { task: "t" }, { agent });
    assert.equal(captured[0].opts.env.PPX_AGENT_READONLY, "1", "父只读 → 子必只读 (旧缺陷: 子比父宽)");
    agent.permissions.sandbox = SandboxPolicy.WORKSPACE_WRITE;

    // 父会话处于 /plan 计划态: 交集结论 plan → 子必挂只读杠杆
    captured.length = 0;
    agent.setPlanMode("dlg-sess", true);
    await runWithTrace(
      () => agent.tools.call("spawn_agent", { task: "t" }, { agent }),
      { sessionKey: "dlg-sess", channel: "test" },
    );
    assert.equal(captured[0].opts.env.PPX_AGENT_READONLY, "1", "父 plan → 子必只读");

    // 只读专家: 结果与旧口径一致 (交集幂等地保留既有标记)
    captured.length = 0;
    await agent.tools.call("spawn_agent", { task: "t", expert: "security" }, { agent });
    assert.equal(captured[0].opts.env.PPX_AGENT_READONLY, "1", "只读专家防线不变");
    agent.setPlanMode("dlg-sess", false);
  } finally {
    agent.shutdown();
  }
});

test("委派边界: spawn_agent 自身的 ask/deny 语义在默认流不因交集修复而改变", async () => {
  const agent = new PPXAgent({ root: tmp("sem"), dataDir: tmp("sem-data") });
  try {
    // 默认引擎 (workspace-write + capability_gate 开 + 真目录): spawn_agent medium 非只读 → 直通,
    // 与修复前一致; 唯一新增拒绝来源是 plan 态 (plan-mode 测试已覆盖)。
    const d = await agent._admitToolCall("spawn_agent", { task: "t" }, "t-s", Date.now());
    assert.equal(d.ok, true, "默认工作区流: spawn_agent 不新增审批/拒绝");
  } finally {
    agent.shutdown();
  }
});
