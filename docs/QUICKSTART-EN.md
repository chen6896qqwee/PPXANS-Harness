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
npm run setup            # interactive model wizard (pick provider → paste key → live probe)
ppx doctor               # health check: config / keys / data dir / skills
ppx                      # interactive chat (CLI);  npm run chat is the same thing
node bin/ppx.js --version
```

Web UI + HTTP channel:

```bash
npm start                # Web UI + HTTP on http://127.0.0.1:8899 (one process, one port)
node bin/ppx-serve.js    # headless HTTP only (/health, /message, /mcp)
```

## 4. Skills (built-in: 67, across 12 domains)

- `skill_search { query }` — find a skill by keyword
- `load_skill { name }` — load full instructions on demand
- `skill_import { repo: "anthropics/skills" }` — import from a GitHub repo (whitelisted sources ship offline in `skills/upstream-sources.json`)

## 5. Memory

- 5-layer memory with automatic distillation, Gaussian decay, TTL soft-archive (restorable), WAL crash-safety, and a tamper-evident audit chain
- Plug a different backend via `config.memory.backend` (`json` / `sqlite` / `auto`, or a plugin factory — see `plugins/amem-memory/` for an A-Mem style example). The `sqlite` backend uses Node's built-in `node:sqlite` and requires **Node >= 22.5**; the default `json` backend has no such requirement.

## 6. Benchmark

```bash
node scripts/taskbench.js                # 20 real tasks + falsifiable verifiers
node scripts/taskbench.js --report-json  # machine-readable public report (schema 2, incl. GPA process metrics)
node bench/falsify.js                    # judge-falsifiability gate: reference solutions pass, all mutants fail
```

## 7. MCP

PPXANS ships an MCP server (`ppx-serve` exposes `/mcp`) and can act as an MCP client. Point any MCP-compatible tool at it.

Two ways to connect:

- **HTTP (Streamable)**: `POST http://127.0.0.1:8899/mcp` (same Bearer token as the HTTP API) — Claude Desktop / Cursor / MCP Inspector work out of the box.
- **stdio**: `ppx mcp serve` — plug PPXANS into MCP hosts like Claude Code / Cursor without opening a port (`claude mcp add ppx -- ppx mcp serve`). See [`docs/MCP-STDIO.md`](MCP-STDIO.md).

## Links

- 中文快速上手: [`docs/QUICKSTART.md`](QUICKSTART.md)
- Full config reference: [`docs/CONFIG.md`](CONFIG.md)
- Roadmap: [`docs/ROADMAP-LIGHTKERNEL-2026-10-08.md`](ROADMAP-LIGHTKERNEL-2026-10-08.md)
