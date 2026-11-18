#!/usr/bin/env node
// scripts/worldmodel-server.mjs - 独立启动文件域世界模型服务 (2026-11-15)
// 用法: node scripts/worldmodel-server.mjs [--root <dir>] [--port 8923]
//   不依赖完整 agent; 服务只绑 127.0.0.1。agent 侧用 config.agent.world_model.builtin=true
//   可随内核自启 (bootstrap 接线), 两者二选一。
import path from "node:path";
import { createWorldModelServer } from "../src/worldmodel/server.js";

function argv(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const root = path.resolve(argv("--root") || process.cwd());
const port = Number(argv("--port")) > 0 ? Number(argv("--port")) : 8923;

const srv = createWorldModelServer({ root, port });
const url = await srv.start();
console.log(`[worldmodel] 文件域世界模型服务已启动: ${url}`);
console.log(`[worldmodel] 世界根目录: ${root} (虚拟状态 ${srv.world.stateCount()} 条, 已从磁盘 seed)`);
console.log(`[worldmodel] 契约: POST ${url} {op:"simulate", steps:[{type,path,content?,to?,recursive?}]} | GET ${url}/health`);
console.log(`[worldmodel] Ctrl+C 停止`);
process.on("SIGINT", async () => {
  await srv.stop();
  process.exit(0);
});
