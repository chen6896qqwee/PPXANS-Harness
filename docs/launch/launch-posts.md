# PPXANS-Harness —— 发布文案（草稿）

> 定位一句话：**纯 Node.js、零运行时依赖的 AI 智能体内核**。装上模型就能跑，自带五层记忆、自愈、自学、防篡改审计账本和标准 MCP 服务端。
> 仓库：https://github.com/chen6896qqwee/PPXANS-Harness

---

## 1) Hacker News — Show HN（英文）

**Title**

```
Show HN: PPXANS-Harness – self-contained AI agent kernel, pure Node.js, zero deps
```

**Body**

```
I built PPXANS-Harness, an agent kernel you can run with `npm start`. There is no
install step: the main package has zero runtime dependencies (Node built-ins only).

What it gives an agent:

- 5-layer memory. L0 raw conversation -> L1 atomic facts with Gaussian decay ->
  L2 scenes -> L3 persona -> L4 procedural skills (slower decay). Forgetting is
  soft-deletable and rollback-able, facts carry validFrom/validTo windows, and
  storage can switch to node:sqlite (FTS5 + WAL) when available.

- Startup self-healing. An integrity marker detects "crashed last run", corrupt
  JSON is repaired, residue cleaned. Self-heal benchmark: 7/7.

- Self-learning. Failures distill into experience (refine); successes into skills
  (refineSkill); skills get upgraded over time -- all gated by an Auditor that is
  the only "verified write-back" path.

- Tamper-evident audit chain. Every tool call is appended to a SHA-256 hash chain;
  verify() pinpoints the first broken line, and quarantine() isolates it.

- Governance. Approval tiers + sandbox policy + command guard (three layers) +
  deny-wins policy chain with a per-subscriber circuit breaker.

- Multi-agent: multi-process legion, DAG orchestration, supervisor arbitration.

- MCP-first. It both is a standard MCP server (POST /mcp, 85 tools) and an MCP
  client, so Claude Desktop / Cursor / any MCP client can drive it.

Numbers: 1022 tests (1018 pass / 0 fail / 4 skipped, network-only), Node >= 20,
Apache-2.0.

Repo: https://github.com/chen6896qqwee/PPXANS-Harness

I'd love feedback on two design choices in particular: (1) Gaussian memory decay
with fact validity windows, and (2) the append-only SHA-256 audit chain as the
source of truth for "what the agent did". Also curious: what would make you reach
for this over a thin OpenAI/Claude wrapper or a graph framework?
```

---

## 2) V2EX — 分享创造（中文）

**标题**

```
[分享创造] PPXANS-Harness：纯 Node.js、零依赖的 AI 智能体内核（五层记忆 / 自愈 / 审计链 / MCP）
```

**正文**

```
做了个东西：一个 AI 智能体内核，接上任意 OpenAI 兼容模型就能跑。

它最大的特点是没有依赖——主包 package.json 里没有 dependencies 字段，`node bin/ppx-web.js`
直接起，内核 + Web 界面同进程同端口。下载下来就能用，不用 npm install。

主要能力：

• 五层记忆 L0–L4：对话 -> 原子事实（高斯衰减）-> 场景 -> 画像 -> 程序性技能（慢遗忘）。
  可以软删、回滚、带事实有效期，装不下才裁剪。可选 node:sqlite 后端（FTS5 + WAL）。
• 启动自愈：上次崩溃能被识别，损坏 JSON 自动修复。自愈基准 7/7。
• 自我学习：失败沉淀成经验，成功沉淀成技能，技能会升级；写回必须过 Auditor 校验闸门。
• 审计哈希链：每次工具调用 append-only 写进 SHA-256 链式账本，改一行全链校验失败。
• 治理/安全：审批四档 + 沙箱 + 命令守卫三层 + deny-wins 策略链 + 熔断。
• 多 Agent：多进程军团 + DAG 编排 + supervisor 仲裁。
• MCP：既是标准 MCP 服务端（POST /mcp，85 工具），也是 MCP 客户端，Claude Desktop /
  Cursor 开箱即用。

测试 1022 项（1018 通过 / 0 失败 / 4 skip 联网用例），Node >= 20，Apache-2.0。

GitHub：https://github.com/chen6896qqwee/PPXANS-Harness

欢迎拍砖，尤其是记忆衰减和审计链这两块的设计。
```

---

## 3) 即刻（中文，短）

```
做了个纯 Node.js、零依赖的 AI 智能体内核 🦐 PPXANS-Harness

接上模型就能跑，不用 npm install。自带：
· 五层记忆 L0–L4（会记、也会忘，可回滚）
· 启动自愈 7/7
· 失败学成经验、成功学成技能
· 每次工具调用写进 SHA-256 防篡改账本
· 标准 MCP 服务端，Claude Desktop / Cursor 直接连

1022 项测试 0 失败。纯 Node，Apache-2.0。
https://github.com/chen6896qqwee/PPXANS-Harness
```

---

## 4) X / Twitter（英文，短）

```
PPXANS-Harness: a self-contained AI agent kernel in pure Node.js — zero runtime deps.

• 5-layer memory (L0–L4) with rollback-able forgetting
• startup self-healing (7/7)
• learns from failures into skills
• SHA-256 tamper-evident tool-call audit chain
• MCP server + client, 85 tools

1022 tests, 0 failures. `npm start` — no install.

https://github.com/chen6896qqwee/PPXANS-Harness
```

---

## 发布前检查

- [ ] 仓库公开可访问、README 首屏正常渲染（含 docs/demo/terminal.svg 动画）
- [ ] 无密钥/隐私数据入库（data/、config/ppx.json 已 gitignore）
- [ ] 各平台账号已登录（HN / V2EX / 即刻 / X）
- [ ] HN 标题避免营销词；V2EX 发在「分享创造」节点
- [ ] 发布后 24h 内回帖、答疑（HN/V2EX 都看重作者互动）
