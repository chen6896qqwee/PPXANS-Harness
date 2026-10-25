# Quickstart (English)

> PPXANS-Harness (皮皮虾) — a self-contained AI agent kernel in pure Node.js with **zero runtime dependencies**. Point it at any OpenAI-compatible model and go.

## 1. Requirements

- Node.js ≥ 20 (no `npm install` — zero runtime dependencies)
- An API key from any OpenAI-compatible provider (Zhipu / OpenAI / DeepSeek / DashScope / Volcano Ark …), or a local model (LM Studio / Ollama)

## 2. Configure a model

Edit `config/ppx.json`:

```json
{
  "providers": [
    {
      "id": "zhipu",
      "backend": "http",
      "base_url": "https://open.bigmodel.cn/api/paas/v4",
      "model": "glm-4-flash",
      "api_key_env": "ZHIPU_API_KEY"
    }
  ]
}
```

Then export the key:

```bash
export ZHIPU_API_KEY=xxx    # or OPENAI_API_KEY / DEEPSEEK_API_KEY / DASHSCOPE_API_KEY …
```

## 3. Run

```bash
npm start                # interactive chat (CLI)
node bin/ppx.js --version
```

Web UI + HTTP channel:

```bash
node bin/ppx-serve.js    # http://127.0.0.1:8899  (/health, /message, Web UI)
```

## 4. Skills (built-in: 77, across 12 domains)

- `skill_search { query }` — find a skill by keyword
- `load_skill { name }` — load full instructions on demand
- `skill_import { repo: "anthropics/skills" }` — import from a GitHub repo (whitelisted sources ship offline in `skills/upstream-sources.json`)

## 5. Memory

- 5-layer memory with automatic distillation, Gaussian decay, TTL soft-archive (restorable), WAL crash-safety, and a tamper-evident audit chain
- Plug a different backend via `config.memory.backend` (`json` / `sqlite` / `auto`, or a plugin factory — see `plugins/amem-memory/` for an A-Mem style example)

## 6. Benchmark

```bash
node scripts/taskbench.js                # 20 real tasks + falsifiable verifiers
node scripts/taskbench.js --report-json  # machine-readable public report (schema 2, incl. GPA process metrics)
node bench/falsify.js                    # judge-falsifiability gate: reference solutions pass, all mutants fail
```

## 7. MCP

PPXANSS ships an MCP server (`ppx-serve` exposes `/mcp`) and can act as an MCP client. Point any MCP-compatible tool at it.

## Links

- 中文快速上手: [`docs/QUICKSTART.md`](QUICKSTART.md)
- Full config reference: [`docs/CONFIG.md`](CONFIG.md)
- Roadmap: [`docs/ROADMAP-LIGHTKERNEL-2026-10-08.md`](ROADMAP-LIGHTKERNEL-2026-10-08.md)
