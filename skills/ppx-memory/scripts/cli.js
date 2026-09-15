// ppx-memory CLI - 皮皮虾四层记忆引擎 (OpenClaw skill) v1.0
// Windows 中文安全: 中文内容走 --spec <json文件> (UTF-8), 规避 argv/stdin GBK 乱码
//   node cli.js --spec spec.json
// spec.json: { cmd, content?, flags?: {...} }
// ASCII 快捷命令: node cli.js facts|scenes|context|persona|query <ascii>
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { FactStore } from "./fact-store.js";
import { L0Recorder } from "./l0.js";
import { SceneStore } from "./l2.js";
import { PersonaStore } from "./l3.js";
import { MemoryTicker } from "./memory-ticker.js";
import { Experience } from "./experience.js";
import { scrubPII } from "./pii.js";
import { SessionStore } from "./session.js";

const DATA = process.env.PPX_MEMORY_DIR || path.join(os.homedir(), ".openclaw", "memory", "ppx");
const facts  = new FactStore(DATA);
const l0     = new L0Recorder(DATA);
const scenes = new SceneStore(DATA);
const persona= new PersonaStore(DATA);
const ticker = new MemoryTicker(DATA, facts);
const exper  = new Experience(DATA);
const sessionStore = new SessionStore(DATA);
const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));

// ---- HTTP 便捷封装不存在, 直接函数 ----
function addMemory(content, fl = {}) {
  const scr = scrubPII(String(content || ""));
  if (scr.detected.length) console.error("[PII] redacted:", scr.detected.join(","));
  return facts.add(scr.cleaned, {
    importance: Number(fl.importance || 10),
    type: fl.type || "general",
    source: fl.source || "manual",
  });
}
function run(cmd, content, fl = {}) {
  switch (cmd) {
    case "add":      return addMemory(content, fl);
    case "query":    return facts.query(content || "", { limit: Number(fl.limit || 5) }).map((x) => ({ id: x.id, score: Math.round(x.effectiveScore), content: x.content }));
    case "facts":    return facts.list();
    case "scene":    return scenes.activeContext(content || "") || "(no scene matched)";
    case "scenes":   return scenes.listWithDesc();
    case "scene-create": return scenes.create({ name: fl.name, description: fl.desc, canHelp: fl.help, keywords: (fl.kw || "").split(",").filter(Boolean) });
    case "persona":  return persona.buildUserPersona(facts.list(), { force: !!fl.force });
    case "record":   { const l = l0.record({ role: fl.role || "user", content, sessionKey: fl.session || "default" }); return l ? "recorded" : "filtered"; }
    case "tick":     return ticker.recordTurn(fl.u || "", fl.a || "");
    case "context":  return ticker.context();
    case "learn":    { const e = exper.learn({ task: fl.task, outcome: fl.outcome, lesson: content || fl.lesson, tags: (fl.tags || "").split(",").filter(Boolean) }); return e ?? "(lesson too short)"; }
    case "lessons":  return exper.recall(content || "");
    case "pii":      { const r = scrubPII(content || ""); return { detected: r.detected, cleaned: r.cleaned }; }
    case "session-push":  { sessionStore.push(fl.session || "default", { role: fl.role || "user", content: content || "" }); return "saved"; }
    case "session-load":  return sessionStore.load(content || "");
    case "session-list":  return sessionStore.list();
    default:         return "unknown cmd: " + cmd;
  }
}
const help = `ppx-memory 四层记忆引擎
  node cli.js --spec spec.json          中文操作(推荐, spec含cmd/content/flags)
  node cli.js facts|scenes|context|persona|query <ascii>
  spec.cmd: add/query/scene/scene-create/persona/record/tick/context/learn/lessons/pii
数据目录: ${DATA}`;

(async () => {
  const [, , c1, c2, ...rest] = process.argv;
  if (c1 === "--spec") {
    const spec = JSON.parse(fs.readFileSync(c2, "utf8").replace(/^\uFEFF/, ""));
    const r = await run(spec.cmd, spec.content || "", spec.flags || {});
    out(r);
  } else {
    const cmd = c1;
    if (cmd === "help" || !cmd) { out(help); }
    else if (["facts","scenes","context","persona"].includes(cmd)) { out(run(cmd, "", {})); }
    else if (cmd === "query") { out(run("query", [c2, ...rest].join(" "), {})); }
    else { out(help); }
  }
})();