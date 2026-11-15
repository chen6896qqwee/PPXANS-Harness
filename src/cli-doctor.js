// src/cli-doctor.js - `ppx doctor` 一键体检 (2026-10-09, 交到用户手上的最后一公里)
// 用户最常见的卡点: "我配置对了吗? key 填哪? 为什么没反应?" —— 一条命令出全部答案。
// 设计: 离线优先 (不发网络请求, 除非 --net); 每项检查独立 try, 绝不因单项崩溃整场。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { isPlaceholder } from "./config/placeholder.js";
import { configFilePath } from "./utils/config-file.js";
import { readJsonGuarded } from "./utils/store.js";
import { resolveDataDir } from "./utils/datadir.js";
import { resolveApiKeyCmd } from "./llm/router.js";
import { readNeedsAction } from "./llm/needs-action.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function check(results, name, ok, note = "") {
  results.push({ name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  return ok;
}

export async function runDoctor({ net = false } = {}) {
  console.log("皮皮虾体检 (doctor)\n");
  const results = [];

  // 1. Node 版本
  const major = Number(process.version.slice(1).split(".")[0]);
  check(results, `Node 版本 ${process.version}`, major >= 20, major >= 20 ? "" : "需要 Node >= 20");

  // 2. 配置文件存在 + 可解析
  // 注意: loadConfig 对缺文件/坏 JSON 都会静默回退默认值 —— 只调它永远是 ✓, 必须自己看文件。
  const cfgPath = configFilePath(ROOT);
  const probe = readJsonGuarded(cfgPath);
  if (!probe.existedBefore) {
    check(results, "配置文件", false, `${cfgPath} 不存在 — 运行 ppx setup (或 npm run setup) 生成`);
  } else if (probe.parseFailed) {
    check(results, "配置文件", false, `${cfgPath} 不是合法 JSON — 修好或改名后重跑`);
    console.log("\n结论: 修复 config/ppx.json 后重跑 ppx doctor");
    process.exit(1);
  } else {
    check(results, "配置文件", true, cfgPath);
  }
  const config = loadConfig(ROOT);

  // 3. providers: 声明 / 占位 / 密钥解析
  // 2026-10-31: 密钥三通道 (api_key 明文 / api_key_env / api_key_cmd), 明文内联给降级提示
  const provs = (config.providers || []).filter(Boolean);
  check(results, `模型 provider 声明 ${provs.length} 个`, provs.length > 0, provs.length ? "" : "在 config/ppx.json providers 里至少配一个");
  for (const p of provs) {
    const label = `${p.id} (${p.model})`;
    if (isPlaceholder(p.model) || isPlaceholder(p.base_url)) {
      check(results, `  ${label}`, false, "model/base_url 还是占位符 — 填真实值");
      continue;
    }
    const keyInline = p.api_key && !isPlaceholder(String(p.api_key));
    const envVal = p.api_key_env ? process.env[p.api_key_env] : null;
    const keyEnv = envVal && !isPlaceholder(String(envVal));
    const keyCmd = !!p.api_key_cmd;
    if (keyInline || keyEnv || keyCmd) {
      const note = keyInline
        ? "内联明文 — 建议改用 api_key_env 或 api_key_cmd, 避免 key 随配置文件落盘"
        : keyCmd
          ? `cmd ${String(p.api_key_cmd).slice(0, 60)}`
          : `env ${p.api_key_env}`;
      check(results, `  ${label} 密钥`, true, note);
    } else {
      check(results, `  ${label} 密钥`, false, p.api_key_env ? `未设置 — export ${p.api_key_env}=你的key` : "配置 api_key / api_key_env / api_key_cmd");
    }
  }
  const llmReady = provs.some((p) => {
    const keyInline = p.api_key && !isPlaceholder(String(p.api_key));
    const envVal = p.api_key_env ? process.env[p.api_key_env] : null;
    return !isPlaceholder(p.model || "") && !isPlaceholder(p.base_url || "")
      && (keyInline || p.api_key_cmd || (envVal && !isPlaceholder(String(envVal))));
  });

  // 3.5 配置落盘权限 (2026-11-02): 配置可能含 api_key / auth_token 明文。
  //   POSIX 上 0644 代表同机其他用户可读 —— 新写入已自动 0600, 这里兜底检查历史文件。
  if (process.platform !== "win32" && probe.existedBefore && !probe.parseFailed) {
    try {
      const mode = fs.statSync(cfgPath).mode & 0o777;
      const loose = (mode & 0o077) !== 0;
      check(results, `配置权限 0${mode.toString(8)}`, !loose,
        loose ? `其他用户可读, 执行 chmod 600 ${cfgPath}` : "");
    } catch (e) {
      check(results, "配置权限", false, String(e.message || e).slice(0, 80));
    }
  }

  // 3.2 LLM 通道待处理项 (2026-11-14, BYO 体验轮): auth/balance/404 类失败落
  //   data/llm/needs-action.json, HTTP 成功一次自愈清除。此前只有默认关闭的看门狗读它,
  //   doctor 是 needs-action.js 注释承诺的巡检面 —— 本项兑现。
  try {
    const na = readNeedsAction();
    if (na && na.entries.length) {
      for (const x of na.entries.slice(0, 5)) {
        check(results, `LLM 通道 ${x.provider}/${x.model} [${x.reason}]`, false,
          `${x.userHint || "需要用户处理"} (自 ${x.firstAt}, 累计 ${x.count} 次; 修好后成功调用一次即自动清除)`);
      }
    } else {
      check(results, "LLM 通道无待处理故障", true);
    }
  } catch (e) {
    check(results, "LLM 通道待处理项", false, String(e.message || e).slice(0, 60));
  }

  // 4. 模型连通 (--net 才发请求: 协议适配器探活 /models, 8s 超时)
  if (net && llmReady) {
    for (const p of provs) {
      const keyInline = p.api_key && !isPlaceholder(String(p.api_key));
      const envVal = p.api_key_env ? process.env[p.api_key_env] : null;
      const key = keyInline ? p.api_key : (p.api_key_cmd ? resolveApiKeyCmd(p) : envVal);
      if (!key || isPlaceholder(String(key))) continue;
      const r = await probeProviderNet(p);
      check(results, `  连通 ${p.base_url} (${p.protocol || "openai-completions"})`, r.ok, r.detail);
    }
  } else if (!net) {
    console.log("  (模型连通性探测未执行 — 加 --net 做协议正确的 /models 探活)");
  }

  // 5. 数据目录可写 (与运行时同一解析规则: PPX_DATA_DIR > 默认目录)
  const dataDir = resolveDataDir(ROOT);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probeFile = path.join(dataDir, `.doctor-${Date.now()}`);
    fs.writeFileSync(probeFile, "ok");
    fs.unlinkSync(probeFile);
    check(results, `数据目录可写 ${dataDir}`, true);
  } catch (e) {
    check(results, `数据目录可写 ${dataDir}`, false, e.message.slice(0, 80)); /* swallowed-ok(2026-11-03): 已写入体检结果 */
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

  // 7. 新版本检查 (--net 才查, 离线优先; 只提示不算体检失败 —— 有新版不是"未过项")
  //    PPX_UPDATE_CHECK=0 时跳过 (与启动通知同一开关)。
  if (net && process.env.PPX_UPDATE_CHECK !== "0") {
    try {
      const cur = readJsonGuarded(path.join(ROOT, "package.json")).data?.version || "0.0.0";
      const { checkWithConfig, updateNotice } = await import("./services/update.js");
      const u = await checkWithConfig({ config, currentVersion: cur, dataDir });
      if (u.ok) {
        check(results, "版本", true, u.updateAvailable ? updateNotice(u) : `已是最新 v${cur}`);
      } else {
        console.log(`  - 版本检查跳过 (${u.reason}) — 不影响体检结论`);
      }
    } catch (e) {
      console.log(`  - 版本检查跳过 (${String(e.message || e).slice(0, 60)}) — 不影响体检结论`);
    }
  }

  // 汇总
  const bad = results.filter((r) => !r.ok);
  console.log(`\n结论: ${bad.length === 0 ? "✅ 全部就绪, 可以 npm start" : `❌ ${bad.length} 项未过 — 按上面的 ✗ 修复后重跑`}`);
  if (bad.length === 0 && !llmReady) console.log("提示: 密钥未就绪时仍可进入本地工具模式 (记忆/文件/命令), 配好 key 后即有完整对话。");
  return bad.length === 0;
}

// 连通性探测 (2026-11-14, BYO 体验轮): 旧实现裸 POST {base}/chat/completions —— 对
//   anthropic-messages / openai-responses 协议的 BYO 配置必然误报"不通" (运行时实际可用,
//   三协议适配器在 src/llm/protocol.js)。改走 LLMClient.health(): 与 ppx setup 探活、
//   POST /api/providers/test 同一函数 —— /models 路径与鉴权头由适配器按 protocol 生成。
//   语义如实记录: 探测从"最小 chat 补全"变为"协议正确的 /models 探活"。
export async function probeProviderNet(p, timeoutMs = 8000) {
  const keyInline = p.api_key && !isPlaceholder(String(p.api_key));
  const envVal = p.api_key_env ? process.env[p.api_key_env] : null;
  const key = keyInline ? p.api_key : (p.api_key_cmd ? resolveApiKeyCmd(p) : envVal);
  if (!key || isPlaceholder(String(key))) return { ok: false, detail: "无可用密钥" };
  try {
    const { LLMClient } = await import("./llm/client.js");
    const c = new LLMClient({ ...p, api_key: key, timeout_ms: timeoutMs });
    const t0 = Date.now();
    const ok = await c.health();
    return { ok, detail: ok ? `${Date.now() - t0}ms` : "探测未通过 (检查 key / base_url / 模型服务是否启动)" };
  } catch (e) {
    return { ok: false, detail: String(e.message || e).slice(0, 80) };
  }
}
