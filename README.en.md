# 🦐 PPXANS-Harness

**An auditable, self-healing AI agent kernel in pure Node.js — zero runtime dependencies.**

> Version **5.2.0** · Windows-first, runs on macOS/Linux · Node.js ≥ 20

PPXANS-Harness (皮皮虾, "mantis shrimp") is a complete local agent harness: tool loop, five-layer memory, audit chain, permissions, MCP server/client, multi-agent orchestration, and a desktop client — with no `node_modules` required at runtime. Point it at any OpenAI-compatible endpoint (cloud or local LM Studio / Ollama) and go.

Chinese docs are the primary source; this page mirrors the essentials. See [README.md](README.md) for the full feature matrix.

> 🇨🇳 中文主文档: [README.md](README.md) · English quickstart: [docs/QUICKSTART-EN.md](docs/QUICKSTART-EN.md)

---

## Why another agent harness?

Most harnesses optimise for the happy path. This one optimises for **what happens when things go wrong**:

- **Everything is logged.** Tool calls land in an append-only SHA-256 hash chain; tampering or deletion is detectable and locatable to a line (`npm run audit:verify`).
- **Self-healing by default.** Startup checks, corrupt-JSON repair, crash recovery, orphan cleanup — benchmarked 7/7 with `node scripts/selfheal-bench.js`.
- **Failure becomes memory.** Repeated failures are clustered, distilled into a fault dossier, and fed back into prompts/skills through the evolution loop.
- **Verifiable self-improvement.** The `self_improve` pipeline proposes a patch, verifies it against tests, keeps it only when green, and rolls back otherwise (propose-only by default; apply requires explicit double opt-in).
- **Security is structural, not aspirational.** Four-level approval modes, sandbox policy with `realpath` symlink re-checks, a three-layer command guard (structured shell parsing, per-segment argv0 allow-listing, inline-exec hard blocks), SSRF protection, and capability-scoped plugins.

## Highlights

| Area | What you get |
| --- | --- |
| Tooling | 100+ built-in tools (files, shell, web, docs, OCR, code search, sub-agents, self-edit) |
| Memory | L0 conversation → L1 atoms → L2 scenes → L3 profile → L4 procedural; semantic recall with zero-dependency hash-vector fallback |
| Audit | Append-only tool ledger + HMAC external anchor; tamper/delete detection |
| Permissions | `ask` / `on-request` / `never` approval modes; read-only → workspace-write → danger-full-access sandbox ranks |
| Plugins | Declarative `ppx.plugin.json` manifests with `access` + `capabilities` (deny-by-default sensitive services) |
| Integration | Standard MCP server at `POST /mcp` (100+ tools exposed), MCP client (stdio + HTTP), Feishu/WeChat channels |
| UI | Desktop client (Electron): chat + trace + settings + tickets + memory + usage + plugin manager |
| Desktop | Optional Electron shell with GUI smoke tests; program and user data are separated |

## Quickstart

```bash
git clone https://github.com/chen6896qqwee/PPXANS-Harness.git
cd PPXANS-Harness

# 1. Configure a provider (or copy config/ppx.json.example)
export ZHIPU_API_KEY=...        # any OpenAI-compatible provider; OPENAI_API_KEY, DEEPSEEK_API_KEY, … also work

# 2. Interactive setup / health check
npm run setup
node bin/ppx.js doctor

# 3. Run
node bin/ppx.js           # CLI chat
npm install               # once: installs the desktop runtime (Electron)
npm start                 # desktop client window
```

No `npm install` is needed for the CLI/kernel. Dev dependencies (Electron, ESLint) are only for the desktop client, packaging, lint and tests.

For a step-by-step English walkthrough see [docs/QUICKSTART-EN.md](docs/QUICKSTART-EN.md). Configuration reference: [docs/CONFIG.md](docs/CONFIG.md). Model setup: [docs/MODEL-SETUP.md](docs/MODEL-SETUP.md).

## Quality gates

```bash
npm test                     # full node:test suite, isolated temp roots
npm run verify               # architecture / native / docs / prompt-budget / cache / audit checks
npm run lint                 # ESLint (dev dependency)
npm run coverage:gate        # line / branch / function floors
npm run desktop:smoke        # real Electron window smoke (SKIPs if electron is absent)
```

CI runs the suite on Ubuntu, Windows, and macOS; the desktop smoke and coverage gates run on Ubuntu; a nightly job runs the offline benchmark and only exercises the paid real-model path when `PPX_E2E_*` secrets are configured.

## Architecture at a glance

```
bin/            entrypoints (CLI, web, setup, MCP)
src/agent/      turn loop, tools, approvals, usage, work graph
src/channels/   HTTP (split into route mixins), CLI, Feishu/WeChat
src/core/       policy, prompts, trace, self-check
src/memory/     five-layer memory + fact store
src/ans/        nervous system: reward, eviction, guard, proactive
src/plugin/     DI container + manifest loader (access/capabilities)
src/security/   structured shell parser, SSRF, secret handling
webapp/         Vue3+Vite frontend source; dist/ ships prebuilt (v5.0 recast, still zero runtime deps)
docs/           architecture, provenance, security, packaging
```

Design provenance (what was borrowed at the design level, never source-copied) is registered in `config/native-provenance.json` and enforced by `scripts/native-guard.js`.

## Security model

- Loopback-first HTTP with bearer-token auth; elevated permission changes require a short-lived confirmation code.
- Config files containing inline keys are written `0600` on POSIX (Windows relies on user-profile ACLs).
- Plugin code runs in-process — capabilities constrain **which sensitive services** a plugin may register, not what its JavaScript can do. Treat plugins like code you run yourself.
- Inline interpreter execution (`node -e`, `bash -lc`, `powershell -EncodedCommand`, …), command substitution, and download-to-shell pipes are hard-blocked unless `security.allow_inline_exec` is enabled.

Security policy and reporting: [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
