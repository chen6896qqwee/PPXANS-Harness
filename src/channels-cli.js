#!/usr/bin/env node
// src/channels-cli.js - `ppx channels` 通道管理 CLI (借鉴 openclaw `channels add`)
// 让用户自己连通道: 交互式配置 → 写 config/ppx.json → 测试连通性 → 重启服务生效
//
// 用法:
//   ppx-channels list                    列出全部通道 + 启用状态
//   ppx-channels add <name>              交互式配置通道 (默认写盘并启用)
//   ppx-channels test <name>             测试连通性 (网络探测)
//   ppx-channels enable|disable <name>   启用/禁用
//   ppx-channels remove <name>           移除配置 (恢复默认)
//   ppx-channels --root <dir> ...        指定项目根目录 (默认当前目录)
import { ensureUTF8Console } from "./utils/winutf8.js";
import path from "node:path";
import readline from "node:readline/promises";
import {
ensureUTF8Console();
  CHANNEL_SCHEMAS, readChannels, listChannels,
  updateChannel, setChannelEnabled, removeChannel,
} from "./config/channels.js";
import { ChannelManager } from "./channels/index.js";

const args = process.argv.slice(2);
let root = process.cwd();
if (args[0] === "--root") { root = path.resolve(args[1]); args.splice(0, 2); }
const [cmd, name] = args;

const HELP = `ppx-channels - 皮皮虾通道管理 (让用户自己连)
用法:
  ppx-channels list                   列出全部通道 + 启用状态
  ppx-channels add <name>             交互式配置通道
  ppx-channels test <name>            测试连通性
  ppx-channels enable <name>          启用通道
  ppx-channels disable <name>         禁用通道
  ppx-channels remove <name>          移除配置 (恢复默认)
  ppx-channels --root <dir> <cmd>     指定项目根目录
可用通道: ${Object.keys(CHANNEL_SCHEMAS).join(" / ")}`;

// ---- list ----
function doList() {
  const rows = listChannels(root);
  for (const r of rows) {
    const marks = Object.entries(r.fields)
      .map(([k, v]) => (k.endsWith("_set") ? `${k}=✓` : `${k}=${v}`))
      .join(" ");
    console.log(`${r.enabled ? "✓ 启用" : "· 禁用"}  ${r.name}${marks ? "   " + marks : ""}`);
  }
  const enabled = rows.filter((r) => r.enabled).map((r) => r.name);
  console.log(`\n${enabled.length ? "已启用: " + enabled.join(", ") : "全部未启用 — 用 add <name> 配置一个"}`);
}

// ---- add (交互式引导, 借鉴 openclaw channels add) ----
async function doAdd(name) {
  const schema = CHANNEL_SCHEMAS[name];
  if (!schema) {
    console.error(`未知通道: ${name} (可用: ${Object.keys(CHANNEL_SCHEMAS).join(", ")})`);
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const existing = readChannels(root).channels[name] || {};
  const patch = {};
  console.log(`\n配置 ${name} 通道 (回车用默认值, 需要密码的字段直接粘贴):`);
  for (const key of Object.keys(schema).filter((k) => k !== "enabled")) {
    const f = schema[key];
    const def = existing[key] ?? f.def ?? "";
    const defHint = def !== "" ? ` [${def}]` : "";
    const prompt = f.prompt ? `  ${f.label} — ${f.prompt}${defHint}: ` : `  ${f.label}${defHint}: `;
    const ans = (await rl.question(prompt)).trim();
    const val = ans === "" ? def : ans;
    if (val !== "") patch[key] = f.type === "number" ? Number(val) : val;
  }
  rl.close();
  try {
    updateChannel(root, name, { ...patch, enabled: true });
    console.log(`\n✓ ${name} 已配置并启用 (config/ppx.json 已原子写盘, 原文件已备份).`);
    console.log(`  重启服务生效: ppx-serve`);
    console.log(`  验证连通性: ppx-channels test ${name}`);
  } catch (e) {
    console.error(`✗ 保存失败: ${e.message}`);
    process.exit(1);
  }
}

// ---- test (连通性) ----
async function doTest(name) {
  if (!(name in CHANNEL_SCHEMAS)) {
    console.error(`未知通道: ${name} (可用: ${Object.keys(CHANNEL_SCHEMAS).join(", ")})`);
    process.exit(1);
  }
  const { channels } = readChannels(root);
  // 轻量 agent stub: 通道 test() 只用 root 构造, 不触发完整 agent 启动
  const mgr = new ChannelManager({ root, config: { agent: {} } }, channels);
  const r = await mgr.test(name);
  console.log(`${r.ok ? "✓" : "✗"} ${name}: ${r.detail}`);
  process.exit(r.ok ? 0 : 1);
}

// ---- enable/disable/remove ----
function doToggle(name, enabled) {
  if (!(name in CHANNEL_SCHEMAS)) { console.error(`未知通道: ${name}`); process.exit(1); }
  try {
    const out = setChannelEnabled(root, name, enabled);
    console.log(`✓ ${name} 已${enabled ? "启用" : "禁用"}${Object.keys(out).length ? ` (${Object.keys(out).join(", ")})` : ""}`);
  } catch (e) { console.error(`✗ 操作失败: ${e.message}`); process.exit(1); }
}

function doRemove(name) {
  if (!(name in CHANNEL_SCHEMAS)) { console.error(`未知通道: ${name}`); process.exit(1); }
  const ok = removeChannel(root, name);
  console.log(ok ? `✓ ${name} 配置已移除 (恢复默认, 默认禁用)` : `${name} 本来就没有自定义配置`);
}

// ---- main ----
(async () => {
  if (!cmd || cmd === "-h" || cmd === "--help") { console.log(HELP); return; }
  switch (cmd) {
    case "list": doList(); break;
    case "add": await doAdd(name); break;
    case "test": await doTest(name); break;
    case "enable": doToggle(name, true); break;
    case "disable": doToggle(name, false); break;
    case "remove": doRemove(name); break;
    default: console.error(`未知命令: ${cmd}\n${HELP}`); process.exit(1);
  }
})();
