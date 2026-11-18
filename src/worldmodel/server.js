// src/worldmodel/server.js - 世界模型本地 HTTP 服务 (127.0.0.1 only) (2026-11-15)
//
// 形态: worldmodel/index.js 的模拟本体 + 薄 HTTP 壳 —— 与 tools/world-model.js 的
// {simulate(action) -> observation} 契约对接。两个启动路径:
//   · 独立进程: npm run worldmodel:serve (scripts/worldmodel-server.mjs)
//   · 内置随 agent: config.agent.world_model.builtin === true (bootstrap 接线, 默认关)
// 安全: 只绑 127.0.0.1; body 上限 1MB; 无鉴权 (本地回环约定, 与 MCP stdio 同级信任)。
// 契约 (POST /, JSON):
//   {op:"simulate", steps:[{type,path,content?,to?,recursive?}]}  → {ok, results[]}
//   {op:"simulate", action:"自然语言"}                             → simulated:false + 提示
//   {op:"snapshot"|"restore"|"reset"|"diff"|"state"|"seed", ...}   → 各自结果
//   GET /health → {ok, stateCount, snapshots}
import http from "node:http";
import { FilesystemWorldModel } from "./index.js";

const BODY_LIMIT = 1024 * 1024;

export function createWorldModelServer({ world = null, root = null, port = 8923, host = "127.0.0.1", journalFile = null, seedOnStart = true, onMutate = null } = {}) {
  const wm = world || new FilesystemWorldModel({ root, journalFile });
  let url = null;
  // 状态变更锚点 (2026-11-15): snapshot/restore/reset 是"事实级的模拟状态迁移", 经此回调
  //   进审计链 (bootstrap 传 AuditLog.appendEvent)。模拟步骤本身量太大不进链, 锚点保证
  //   "某次反事实会话发生在某时点"在链上可证明。
  const mutate = (type, payload = {}) => {
    try { if (typeof onMutate === "function") onMutate(type, payload); } catch { /* 审计失败不阻断 */ }
  };

  function handleBody(body) {
    const op = String(body?.op || "");
    switch (op) {
      case "simulate": {
        if (Array.isArray(body.steps) && body.steps.length) {
          return { ok: true, results: body.steps.slice(0, 64).map((s) => wm.step(s)) };
        }
        // 兼容旧契约 (自然语言 action): 模拟需要精确动作 —— 不假装能算自然语言
        return {
          ok: false, simulated: false,
          reason: "模拟需要结构化 steps 数组 [{type: write|append|delete|move|mkdir|read|exec, path, content?, to?, recursive?, command?, cwd?}]; "
            + "exec 只接受 rm/mv/cp/mkdir/touch/truncate/dd/cd 的简单命令 (通配符/变量/管道一律拒绝); "
            + "自然语言 action 请先经 LLM 转成动作序列再调用。",
        };
      }
      case "snapshot": { mutate("snapshot", { label: String(body?.label || "") }); return { ok: true, ...wm.snapshot(body?.label) }; }
      case "restore": { mutate("restore", { id: String(body?.id || "") }); return { ok: true, ...wm.restore(body?.id) }; }
      case "reset": { mutate("reset", {}); return { ok: true, ...wm.reset() }; }
      case "diff": return wm.diffAgainstDisk({});
      case "state": return { ok: true, entries: wm.listState({ limit: body?.limit }) };
      case "seed": return { ok: true, ...wm.seedFromDisk({}) };
      case "snapshots": return { ok: true, snapshots: wm.snapshotList() };
      default: return { ok: false, error: `未知 op: ${op || "(缺省)"} (支持 simulate/snapshot/restore/reset/diff/state/seed/snapshots)` };
    }
  }

  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.end(JSON.stringify({ ok: true, service: "ppx-worldmodel", stateCount: wm.stateCount(), snapshots: wm.snapshots.size, root: wm.root }));
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end(JSON.stringify({ ok: false, error: "只接受 POST (JSON) 与 GET /health" }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { res.statusCode = 413; res.end(JSON.stringify({ ok: false, error: "body 超限 (1MB)" })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        res.end(JSON.stringify(handleBody(body)));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "JSON 解析失败: " + String(e?.message || e).slice(0, 120) }));
      }
    });
  });

  return {
    world: wm,
    get url() { return url; },
    start() {
      return new Promise((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(port, host, () => {
          const addr = srv.address();
          url = `http://${host}:${typeof addr === "object" ? addr.port : port}`;
          if (seedOnStart && wm.root && wm.stateCount() === 0) {
            try { wm.seedFromDisk({}); } catch { /* seed 失败不阻断服务 */ }
          }
          resolve(url);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!srv.listening) return resolve();
        srv.close(() => resolve());
      });
    },
    server: srv,
  };
}
