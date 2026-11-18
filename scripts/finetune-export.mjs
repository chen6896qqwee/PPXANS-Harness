#!/usr/bin/env node
// scripts/finetune-export.mjs - 独立导出微调语料 (2026-11-15)
// 用法: node scripts/finetune-export.mjs [--root <repo根>] [--data-dir <数据目录>] [--max-samples 2000]
//   独立模式不依赖完整 agent: 经验/病历从 data 目录直读, 技能从 <root>/skills 扫 SKILL.md。
//   与 agent 内的 finetuneBridge.exportDataset() 同一套准入规则 (见 evolve/finetune-bridge.js)。
import fs from "node:fs";
import path from "node:path";
import { Experience } from "../src/memory/experience.js";
import { FailureEpisodeStore } from "../src/memory/failure-episode.js";
import { buildDataset } from "../src/evolve/finetune-bridge.js";
import { atomicWrite } from "../src/utils/store.js";

function argv(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const root = path.resolve(argv("--root") || process.cwd());
const dataDir = path.resolve(argv("--data-dir") || path.join(root, "data"));
const maxSamples = Number(argv("--max-samples")) > 0 ? Number(argv("--max-samples")) : 2000;

// 技能直扫 (轻量 frontmatter 解析; agent 在线时优先用 agent.finetuneBridge, 那里走 loader)
function scanSkills(skillsRoot) {
  const out = [];
  let dirList = [];
  try { dirList = fs.readdirSync(skillsRoot, { withFileTypes: true }); } catch { return out; }
  for (const d of dirList) {
    if (!d.isDirectory()) continue;
    const file = path.join(skillsRoot, d.name, "SKILL.md");
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const meta = {};
    if (m) {
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
      }
      out.push({ id: d.name, name: meta.name || d.name, description: meta.description || "", content: (m[2] || "").trim() });
    }
  }
  return out;
}

const experience = new Experience(dataDir);
const failures = new FailureEpisodeStore(dataDir);
const skills = scanSkills(path.join(root, "skills"));

const { samples, manifest } = buildDataset({ episodes: failures.list(500), lessons: experience.list({ includeRetired: true }), skills, maxSamples });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(dataDir, "finetune");
fs.mkdirSync(outDir, { recursive: true });
const datasetFile = path.join(outDir, `dataset-${ts}.jsonl`);
atomicWrite(datasetFile, samples.map((s) => JSON.stringify(s)).join("\n") + (samples.length ? "\n" : ""), "utf8");
atomicWrite(path.join(outDir, "manifest.json"), JSON.stringify({ ...manifest, files: { dataset: datasetFile } }, null, 2));

console.log(`[finetune-export] 准入样本: ${manifest.counts.total} (episode ${manifest.counts.episode} / skill ${manifest.counts.skill} / lesson ${manifest.counts.lesson})`);
console.log(`[finetune-export] 拒绝: ${JSON.stringify(manifest.rejected)}`);
console.log(`[finetune-export] 语料: ${datasetFile}`);
console.log(`[finetune-export] 指纹: ${manifest.fingerprint}`);
console.log(`[finetune-export] 下一步: 外部微调 (Ollama/LM Studio/LoRA) → 回灌 → finetuneBridge.registerModelVersion 登记版本 → effect cohort 对照`);
