import fs from "node:fs";
import path from "node:path";
import { Healer } from "../src/selfheal/healer.js";
import { makeTmpRoot, cleanupTmp } from "./lib/tmp-agent.js";

// 自愈门槛: 修复率低于 PPX_MIN_SELFHEAL (默认 100) 即非零退出 (坏基准=发布门禁失败)
const MIN = Number(process.env.PPX_MIN_SELFHEAL ?? 100);

let pass = 0, fail = 0;
const rows = [];

function score(name, ok, detail = "") {
  if (ok) pass++; else fail++;
  rows.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}\n`);
}

function mk(root, rel) { const d = path.join(root, rel); fs.mkdirSync(d, { recursive: true }); return d; }
function put(root, rel, content) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content, "utf8"); };
function touchOld(f, ageMs) { try { const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t); } catch {} }

(async () => {
  console.log("PPX Self-Healing Benchmark (min gate: " + MIN + "%)\n");

  { // 1: missing dirs rebuilt
    const root = makeTmpRoot("shb-1");
    const h = new Healer(root);
    const r = h.heal();
    const ok = fs.existsSync(path.join(root,"data","memory")) && fs.existsSync(path.join(root,"data","experience"));
    score("rebuild_missing_dirs", ok, `created ${r.fixes.length} dir(s)`);
    cleanupTmp(root);
  }
  { // 2: corrupted json reset
    const root = makeTmpRoot("shb-2");
    put(root, "data/memory/facts.json", "{ not valid json !!!");
    const h = new Healer(root);
    const r = h.heal();
    const facts = path.join(root, "data", "memory", "facts.json");
    let arr = false; try { arr = Array.isArray(JSON.parse(fs.readFileSync(facts,"utf8"))); } catch {}
    const n = fs.readdirSync(path.join(root,"data","memory")).filter(f=>f.includes(".corrupt-")).length;
    score("corrupt_json_reset", arr && n >= 1, `reset=${arr}, backup=${n}`);
    cleanupTmp(root);
  }
  { // 3: crash recovery closes loop
    const root = makeTmpRoot("shb-3");
    put(root, "data/integrity.json", JSON.stringify({ clean: false, pid: 99999, ts: Date.now() - 10000 }));
    put(root, "data/memory/leftover.tmp", "half-written");
    const h = new Healer(root);
    const r = h.heal();
    const leftover = fs.existsSync(path.join(root,"data","memory","leftover.tmp"));
    let clean = false; try { clean = JSON.parse(fs.readFileSync(path.join(root,"data","integrity.json"),"utf8")).clean === true; } catch {}
    score("crash_recovery_clean_loop", r.crashed === true && !leftover && clean, `crashed=${r.crashed}, tmpCleaned=${!leftover}, nowClean=${clean}`);
    cleanupTmp(root);
  }
  { // 4: stale corrupt backups pruned
    const root = makeTmpRoot("shb-4");
    const mem = mk(root, "data/memory");
    for (let i = 0; i < 4; i++) { const f = path.join(mem, `facts.json.corrupt-${i}`); put(root, `data/memory/facts.json.corrupt-${i}`, "x"); touchOld(f, (4-i)*60000); }
    const h = new Healer(root);
    const r = h.heal();
    const remain = fs.readdirSync(mem).filter(f=>f.includes(".corrupt-")).length;
    score("prune_stale_corrupt", r.cleanedCorrupt.length === 2 && remain === 2, `pruned=${r.cleanedCorrupt.length}, remain=${remain}`);
    cleanupTmp(root);
  }
  { // 5: stale backup dirs pruned
    const root = makeTmpRoot("shb-5");
    for (let i = 0; i < 3; i++) { const d = path.join(root,"data",`memory-backup-${i}`); fs.mkdirSync(d,{recursive:true}); put(root,`data/memory-backup-${i}/facts.json`,"{}"); touchOld(d,(3-i)*60000); }
    const h = new Healer(root);
    const r = h.heal();
    const remain = fs.readdirSync(path.join(root,"data")).filter(f=>f.startsWith("memory-backup-")).length;
    score("prune_stale_backup_dirs", r.cleanedBackupDirs.length === 1 && remain === 2, `pruned=${r.cleanedBackupDirs.length}, remain=${remain}`);
    cleanupTmp(root);
  }
  { // 6: stale bak files pruned
    const root = makeTmpRoot("shb-6");
    const mem = mk(root, "data/memory");
    for (let i = 0; i < 4; i++) { const f = path.join(mem, `facts.json.bak-${i}`); put(root, `data/memory/facts.json.bak-${i}`, "bak"); touchOld(f, (4-i)*60000); }
    const h = new Healer(root);
    const r = h.heal();
    const remain = fs.readdirSync(mem).filter(f=>f.includes(".bak-")).length;
    score("prune_stale_bak", r.cleanedBakFiles.length === 2 && remain === 2, `pruned=${r.cleanedBakFiles.length}, remain=${remain}`);
    cleanupTmp(root);
  }
  { // 7: clean run no fixes
    const root = makeTmpRoot("shb-7");
    const h = new Healer(root);
    h.heal();
    const r = h.heal();
    score("clean_run_no_fixes", r.fixes.length === 0 && r.crashed === false, `fixes=${r.fixes.length}`);
    cleanupTmp(root);
  }

  const total = pass + fail;
  const rate = total ? (pass/total)*100 : 0;
  console.log(`\nSelf-heal score: ${pass}/${total} (${rate.toFixed(1)}%)`);
  if (rate < MIN) {
    console.log(`GATE FAIL: rate ${rate.toFixed(1)}% < ${MIN}%`);
    rows.filter(r=>!r.ok).forEach(r=>console.log("  failed: " + r.name));
    process.exitCode = 1;
  } else {
    console.log(rate === 100 ? "All self-heal scenarios passed." : `Gate passed (${rate.toFixed(1)}% >= ${MIN}%).`);
  }
})();