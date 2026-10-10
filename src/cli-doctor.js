// src/cli-doctor.js - `ppx doctor` 一键体检 (2026-10-09, 交到用户手上的最后一公里)
// 用户最常见的卡点: "我配置对了吗? key 填哪? 为什么没反应?" —— 一条命令出全部答案。
// 设计: 离线优先 (不发网络请求, 除非 --net); 每项检查独立 try, 绝不因单项崩溃整场。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { isPlaceholder } from "./config/placeholder.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function check(results, name, ok, note = "") {
  results.push({ name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  return ok;
}

export async function runDoctor({ net = false } = {}) {
  console.log("皮皮虾体检 (doctor)\n");
  const results = [];
  const cfgFile = path.join(ROOT, "config", "ppx.json");

  // 1. Node 版本
  const major = Number(process.version.slice(1).split(".")[0]);
  check(results, `Node 版本 ${process.version}`, major >= 20, major >= 20 ? "" : "需要 Node >= 20");

  // 2. 配置文件存在 + 可解析
  let config = null;
  try {
    config = loadConfig(ROOT);
    check(results, "配置文件解析", true, "config/ppx.json");
  } catch (e) {
    check(results, "配置文件解析", false, e.message.slice(0, 100));
    console.log("\n结论: 修复 config/ppx.json 后重跑 ppx doctor");
    process.exit(1);
  }

  // 3. providers: 声明 / 占位 / 密钥解析
  const provs = (config.providers || []).filter(Boolean);
  check(results, `模型 provider 声明 ${provs.length} 个`, provs.length > 0, provs.length ? "" : "在 config/ppx.json providers 里至少配一个");
  let keyOk = 0;
  for (const p of provs) {
    const label = `${p.id} (${p.model})`;
    if (isPlaceholder(p.model) || isPlaceholder(p.base_url)) {
      check(results, `  ${label}`, false, "model/base_url 还是占位符 — 填真实值");
      continue;
    }
    const keyInline = p.api_key && !isPlaceholder(String(p.api_key));
    const envVal = p.api_key_env ? process.env[p.api_key_env] : null;
    const keyEnv = envVal && !isPlaceholder(String(envVal));
    if (keyInline || keyEnv) {
      keyOk++;
      check(results, `  ${label} 密钥`, true, keyInline ? "内联" : `env ${p.api_key_env}`);
    } else {
      check(results, `  ${label} 密钥`, false, p.api_key_env ? `未设置 — export ${p.api_key_env}=你的key` : "配置 api_key 或 api_key_env");
    }
  }
  const llmReady = provs.some((p) => {
    const keyInline = p.api_key && !isPlaceholder(String(p.api_key));
    const envVal = p.api_key_env ? process.env[p.api_key_env] : null;
    return !isPlaceholder(p.model || "") && !isPlaceholder(p.base_url || "") && (keyInline || (envVal && !isPlaceholder(String(envVal))));
  });

  // 4. 模型连通 (--net 才发请求: 一条最小对话, 8s 超时)
  if (net && llmReady) {
    for (const p of provs) {
      const keyInline = p.api_key && !isPlaceholder(String(p.api_key));
      const envVal = p.api_key_env ? process.env[p.api_key_env] : null;
      if (!(keyInline || (envVal && !isPlaceholder(String(envVal))))) continue;
      const key = keyInline ? p.api_key : envVal;
      const t0 = Date.now();
      try {
        const res = await fetch(String(p.base_url).replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: p.model, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
          signal: AbortSignal.timeout(8000),
        });
        const ok = res.ok;
        check(results, `  连通 ${p.base_url}`, ok, ok ? `${Date.now() - t0}ms` : `HTTP ${res.status}: ${(await res.text()).slice(0, 80)}`);
      } catch (e) {
        check(results, `  连通 ${p.base_url}`, false, String(e.message || e).slice(0, 80));
      }
    }
  } else if (!net) {
    console.log("  (模型连通性探测未执行 — 加 --net 发一条最小真实请求)");
  }

  // 5. 数据目录可写
  try {
    const d = path.join(ROOT, "data");
    fs.mkdirSync(d, { recursive: true });
    const probe = path.join(d, `.doctor-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    check(results, "数据目录可写 data/", true);
  } catch (e) {
    check(results, "数据目录可写 data/", false, e.message.slice(0, 80));
  }

  // 6. 技能数量 (递归数 SKILL.md, 与 skills-registry 口径一致)
  try {
    let skills = 0;
    const walk = (d) => {
      for (const f of fs.readdirSync(d)) {
        const p2 = path.join(d, f);
        const st = fs.statSync(p2);
        if (st.isDirectory()) walk(p2);
        else if (f === "SKILL.md") skills++;
      }
    };
    walk(path.join(ROOT, "skills"));
    check(results, `技能库 ${skills} 个 (12 能力域)`, skills > 0);
  } catch (e) {
    check(results, "技能库", false, e.message.slice(0, 60));
  }

  // 汇总
  const bad = results.filter((r) => !r.ok);
  console.log(`\n结论: ${bad.length === 0 ? "✅ 全部就绪, 可以 npm start" : `❌ ${bad.length} 项未过 — 按上面的 ✗ 修复后重跑`}`);
  if (bad.length === 0 && !llmReady) console.log("提示: 密钥未就绪时仍可进入本地工具模式 (记忆/文件/命令), 配好 key 后即有完整对话。");
  return bad.length === 0;
}
