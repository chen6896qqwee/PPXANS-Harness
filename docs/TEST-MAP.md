<!-- 由 node scripts/test-map.js --md 生成, 不要手改 -->

# 测试地图: 改哪个模块, 跑哪些测试

测试文件长期按「修复批次」命名, 从文件名看不出覆盖关系。本表由测试文件的 import 反推生成,
解决两个问题: 改一处不用跑全量, 也不会漏掉藏在日期文件里的契约。
规模 (2026-11-17): 279 个测试文件 / 317 个 src 模块, 175 个模块被直接 import (55.2% 下界), 21 个孤儿测试 (不 import 任何 src 模块, 多为静态契约/脚本检查)。

```bash
node scripts/test-map.js              # 总览
node scripts/test-map.js permissions  # 查某模块相关测试
node scripts/test-map.js --uncovered  # 没被任何测试直接 import 的模块
node scripts/test-map.js --md         # 重新生成本文件
```

## 模块 → 测试

| 模块 | 覆盖它的测试 |
|---|---|
| `src/agent/command-registry.js` | `cli-completer.test.js`<br>`commands.test.js`<br>`plan-mode.test.js`<br>`task-cmd-r17-2026-10-24.test.js` |
| `src/agent/index.js` | `absorb.deepseek.test.js`<br>`advanced.tools.test.js`<br>`agent.test.js`<br>`ans-features.test.js`<br>`apply-patch-codex.test.js`<br>`apply-patch-unprovable.test.js`<br>`apply-patch-works.test.js`<br>`approval-cache.test.js`<br>`approval-headless.test.js`<br>`approval-loop-r13-2026-10-24.test.js`<br>`architecture.test.js`<br>`audit-2026-09-17.test.js`<br>`audit-2026-10-03.test.js`<br>`audit.test.js`<br>`body-2026-10-30.test.js`<br>`body-skin-2026-10-30.test.js`<br>`bot-api.test.js`<br>`budget-cost.test.js`<br>`capability-guard.test.js`<br>`channel-delivery.test.js`<br>`channels-config.test.js`<br>`channels.test.js`<br>`chaos.test.js`<br>`circuit-breaker.test.js`<br>`clarify-no-responder.test.js`<br>`compaction.test.js`<br>`context-budget-wiring-2026-11-16.test.js`<br>`context-eng-optimize.test.js`<br>`context-overflow.test.js`<br>`cost-gate-wiring.test.js`<br>`datadir.test.js`<br>`dedupe-adv.test.js`<br>`delegate.test.js`<br>`eval-production-events.test.js`<br>`eviction.test.js`<br>`evolution-loop.test.js`<br>`evolve.test.js`<br>`fixes-2026-09-18.test.js`<br>`global-memory.test.js`<br>`goal-board-2026-10-05.test.js`<br>`guard.test.js`<br>`hardening-2026-10-04.test.js`<br>`hardening-2026-10-24.test.js`<br>`hardening-r2-2026-10-24.test.js`<br>`hardening-r3-2026-10-24.test.js`<br>`hardening-r4-2026-10-24.test.js`<br>`hardening-r5-2026-10-24.test.js`<br>`health-cache.test.js`<br>`http-invalid-json.test.js`<br>`http-session-routes.test.js`<br>`legion-mode.test.js`<br>`lifecycle-2026-10-04.test.js`<br>`list-dir-in-sandbox.test.js`<br>`mcp-admin.test.js`<br>`mcp-e2e-r14-2026-10-24.test.js`<br>`mcp-pagination-stdio.test.js`<br>`mcp-server.test.js`<br>`memory-extract-real.test.js`<br>`memory-governance-2026-10-04.test.js`<br>`memory-l4-writer-2026-10-30.test.js`<br>`memory-query.test.js`<br>`memory.layers.test.js`<br>`methods.test.js`<br>`mode.test.js`<br>`model-config-r16-2026-10-24.test.js`<br>`model-routing.test.js`<br>`multimodal.test.js`<br>`observability.test.js`<br>`orchestration-tools.test.js`<br>`output-selfcheck.test.js`<br>`permission-confirm.test.js`<br>`permission-intersection.test.js`<br>`permissions-apply-patch.test.js`<br>`pii-reply-mask.test.js`<br>`plan-mode.test.js`<br>`plugin.test.js`<br>`postcondition-gate-2026-10-05.test.js`<br>`prefix-cache-static-region.test.js`<br>`prompt-workspace-neutral.test.js`<br>`prompt-workspace.test.js`<br>`protocol-eq-tools.test.js`<br>`protocol-sq-real.test.js`<br>`protocol-turn-r12-2026-10-24.test.js`<br>`redteam.test.js`<br>`refine.test.js`<br>`reflect-loop.test.js`<br>`reward.test.js`<br>`scene.test.js`<br>`seam-shell.test.js`<br>`security-headers.test.js`<br>`session.test.js`<br>`settings-api.test.js`<br>`skill-upgrade.test.js`<br>`skills-priority.test.js`<br>`step-event.test.js`<br>`task-cmd-r17-2026-10-24.test.js`<br>`taskbench-timeout-guard.test.js`<br>`team-orchestration.test.js`<br>`team-room.test.js`<br>`tool-evidence-context.test.js`<br>`tool-exposure-2026-10-30.test.js`<br>`tool-vis.test.js`<br>`tools.test.js`<br>`turn-archive-batch-2026-10-30.test.js`<br>`user-test-fixes.test.js`<br>`verify.test.js`<br>`watchdog.test.js`<br>`worktree-isolation-2026-11-16.test.js` |
| `src/agent/loop/policy.js` | `audit-2026-10-03.test.js`<br>`clarify-no-responder.test.js`<br>`hardening-2026-10-24.test.js`<br>`hardening-r4-2026-10-24.test.js`<br>`parallel-tools.test.js`<br>`policy.test.js`<br>`postcondition-gate-2026-10-05.test.js`<br>`tool-loop-hardening-2026-10-30.test.js`<br>`trace.test.js`<br>`turn-abort-r12-2026-10-24.test.js` |
| `src/agent/loop/tool-loop.js` | `overflow-generation-guard-2026-11-16.test.js` |
| `src/agent/modes/index.js` | `mode.test.js` |
| `src/agent/modes/legion.js` | `hardening-2026-10-24.test.js`<br>`legion-mode.test.js` |
| `src/agent/plugins/builtin.js` | `amem-plugin.test.js`<br>`memory-backend-slot.test.js` |
| `src/agent/prompts.js` | `project-md.test.js` |
| `src/agent/questions.js` | `questions-2026-11-17.test.js` |
| `src/ans/boundary.js` | `boundary.test.js` |
| `src/ans/guard.js` | `catalog-guard.test.js` |
| `src/ans/lifecycle.js` | `ans-features.test.js`<br>`architecture.test.js` |
| `src/ans/proactive.js` | `ans-features.test.js`<br>`architecture.test.js` |
| `src/ans/reward.js` | `reward.test.js` |
| `src/ans/values.js` | `architecture.test.js` |
| `src/ans/watchdog.js` | `watchdog.test.js` |
| `src/audit/audit-chain.js` | `audit-chain.test.js`<br>`diagnose.test.js`<br>`hardening-2026-10-24.test.js`<br>`memory-governance-2026-10-04.test.js` |
| `src/audit/verifier.js` | `audit.test.js` |
| `src/boot/banner.js` | `banner-ui.test.js` |
| `src/boot/crashguard.js` | `audit-2026-09-17.test.js` |
| `src/bus/circuit-breaker.js` | `circuit-breaker-util.test.js`<br>`fixes-2026-09-18b.test.js` |
| `src/bus/runtime-bus.js` | `fixes-2026-09-18b.test.js` |
| `src/channels/ans-lane.js` | `ans-lane-2026-11-16.test.js` |
| `src/channels/base.js` | `architecture.test.js`<br>`channel-delivery.test.js`<br>`channels-config.test.js` |
| `src/channels/delivery.js` | `channel-delivery.test.js` |
| `src/channels/feishu.js` | `channels-config.test.js`<br>`hardening-2026-10-04.test.js`<br>`hardening-2026-10-24.test.js`<br>`hardening.test.js` |
| `src/channels/http.js` | `approval-loop-r13-2026-10-24.test.js`<br>`audit-2026-09-17.test.js`<br>`audit-2026-10-03.test.js`<br>`bot-api.test.js`<br>`channels.test.js`<br>`hardening-2026-10-04.test.js`<br>`http-invalid-json.test.js`<br>`http-session-routes.test.js`<br>`http-token-persist.test.js`<br>`mcp-e2e-r14-2026-10-24.test.js`<br>`model-config-r16-2026-10-24.test.js`<br>`permission-confirm.test.js`<br>`plan-mode.test.js`<br>`security-headers.test.js` |
| `src/channels/index.js` | `architecture.test.js`<br>`channel-delivery.test.js`<br>`channels-config.test.js` |
| `src/channels/output.js` | `channels-pure-2026-11-16.test.js` |
| `src/channels/receipts.js` | `channels-pure-2026-11-16.test.js` |
| `src/channels/telegram.js` | `channels-pure-2026-11-16.test.js`<br>`telegram-channel-2026-11-16.test.js` |
| `src/channels/wechat-crypto.js` | `hardening.test.js`<br>`wechat-channel.test.js`<br>`wechat-crypto.test.js` |
| `src/channels/wechat.js` | `channels-config.test.js`<br>`hardening-2026-10-04.test.js`<br>`hardening-r2-2026-10-24.test.js`<br>`hardening.test.js`<br>`wechat-channel.test.js` |
| `src/channels/workspace.js` | `channels-pure-2026-11-16.test.js` |
| `src/cli-doctor.js` | `cli-doctor-2026-11-17.test.js` |
| `src/config/channels.js` | `audit-2026-09-17.test.js`<br>`channels-config.test.js`<br>`hardening.test.js` |
| `src/config/index.js` | `config-consistency.test.js`<br>`config-yaml-env-2026-11-17.test.js` |
| `src/config/placeholder.js` | `user-test-fixes.test.js` |
| `src/config/providers.js` | `api-key-cmd.test.js`<br>`model-config-r16-2026-10-24.test.js`<br>`providers-api.test.js` |
| `src/config/settings.js` | `settings-api.test.js` |
| `src/core/run-context.js` | `workgraph-runid-2026-11-16.test.js` |
| `src/core/selfcheck.js` | `output-selfcheck.test.js` |
| `src/core/trace.js` | `eval-production-events.test.js`<br>`fixes-2026-09-18.test.js`<br>`hardening-r5-2026-10-24.test.js`<br>`permission-intersection.test.js`<br>`plan-mode.test.js`<br>`services.test.js`<br>`tool-evidence-context.test.js`<br>`trace.test.js`<br>`workgraph-runid-2026-11-16.test.js` |
| `src/edit/anchors.js` | `unit-gaps-2026-11-16.test.js` |
| `src/edit/editblock.js` | `apply-patch-codex.test.js`<br>`apply-patch-unprovable.test.js`<br>`edit-editblock.test.js` |
| `src/edit/snapshot.js` | `edit-snapshot.test.js`<br>`hardening-r2-2026-10-24.test.js` |
| `src/evidence/index.js` | `evidence.test.js`<br>`goal-board-2026-10-05.test.js`<br>`goal-board-crossproc-2026-10-05.test.js` |
| `src/evolve/delta-producer.js` | `hardening-2026-10-24.test.js` |
| `src/evolve/healer.js` | `audit-2026-09-17.test.js`<br>`selfheal-cleanup.test.js`<br>`user-test-fixes.test.js` |
| `src/evolve/loop.js` | `evolution-loop.test.js` |
| `src/evolve/playbook.js` | `hardening-2026-10-24.test.js`<br>`playbook.test.js` |
| `src/evolve/trigger.js` | `evolve.test.js` |
| `src/flow/kernel.js` | `flow-kernel-2026-11-17.test.js` |
| `src/flow/policy.js` | `trigger-policy.test.js` |
| `src/flow/trigger.js` | `trigger-policy.test.js`<br>`trigger.test.js` |
| `src/hooks/index.js` | `hook-args.test.js`<br>`hooks.test.js`<br>`memory-governance-2026-10-04.test.js`<br>`user-hooks.test.js` |
| `src/hooks/user-hooks.js` | `user-hooks.test.js` |
| `src/llm/adapters/anthropic.js` | `anthropic-adapter-2026-11-17.test.js` |
| `src/llm/adapters/responses.js` | `responses-adapter-2026-11-17.test.js` |
| `src/llm/client.js` | `ans-api.test.js`<br>`fence.test.js`<br>`hardening-2026-10-04.test.js`<br>`hardening-r4-2026-10-24.test.js`<br>`health.test.js`<br>`step-event.test.js`<br>`tool-hooks.test.js`<br>`tool-vis.test.js`<br>`turn-abort-r12-2026-10-24.test.js` |
| `src/llm/dsml.js` | `dsml-prompt.test.js`<br>`dsml.test.js` |
| `src/llm/embedder.js` | `document.test.js`<br>`oobox.test.js`<br>`v31-embed-local.test.js` |
| `src/llm/fence.js` | `dsml.test.js`<br>`fence.test.js` |
| `src/llm/local-embedder.js` | `local-embedder.test.js`<br>`oobox.test.js` |
| `src/llm/presets.js` | `audit-2026-10-03.test.js`<br>`model-presets.test.js` |
| `src/llm/pricing.js` | `budget-cost.test.js` |
| `src/llm/retry.js` | `retry.test.js` |
| `src/llm/router.js` | `api-key-cmd.test.js`<br>`model-config-r16-2026-10-24.test.js`<br>`router.test.js`<br>`user-test-fixes.test.js` |
| `src/mcp-stdio.js` | `mcp-pagination-stdio.test.js`<br>`mcp-stdio-progress-2026-11-17.test.js` |
| `src/mcp/admin.js` | `mcp-admin.test.js` |
| `src/mcp/client.js` | `mcp-e2e-r14-2026-10-24.test.js`<br>`mcp-pagination-stdio.test.js`<br>`mcp.test.js` |
| `src/mcp/http.js` | `audit-2026-10-03.test.js`<br>`mcp-server.test.js`<br>`mcp-stream.test.js` |
| `src/mcp/index.js` | `hardening.test.js`<br>`mcp-namespace.test.js`<br>`mcp.test.js` |
| `src/mcp/server.js` | `hardening-2026-10-04.test.js`<br>`mcp-admin.test.js`<br>`mcp-pagination-stdio.test.js`<br>`mcp-server.test.js`<br>`mcp-stdio-progress-2026-11-17.test.js`<br>`mcp-stream.test.js` |
| `src/mcp/tasks.js` | `mcp-admin.test.js`<br>`task-cmd-r17-2026-10-24.test.js` |
| `src/memory/compaction.js` | `compaction.test.js` |
| `src/memory/eviction.js` | `eviction.test.js` |
| `src/memory/experience.js` | `fork.test.js`<br>`global-memory.test.js`<br>`reflect-loop.test.js` |
| `src/memory/fact-store.js` | `config-consistency.test.js`<br>`extract-cost.test.js`<br>`fact-prune.test.js`<br>`fact-reload-signature-2026-10-30.test.js`<br>`fact-tombstone-purge-2026-10-04.test.js`<br>`fact-wal.test.js`<br>`fixes-2026-09-18.test.js`<br>`fork.test.js`<br>`hardening-2026-10-04.test.js`<br>`hardening.test.js`<br>`inverted-index.test.js`<br>`longterm-tail-retention-2026-10-04.test.js`<br>`memory-extract.test.js`<br>`memory-governance-2026-10-04.test.js`<br>`memory-governance.test.js`<br>`memory-query.test.js`<br>`memory-recall-lexicon-2026-10-30.test.js`<br>`memory-recall-multi-source-2026-11-16.test.js`<br>`oobox.test.js`<br>`provenance-injection-render.test.js`<br>`retrieval.test.js`<br>`schema-migration.test.js`<br>`user-test-fixes.test.js`<br>`v31-embed-local.test.js`<br>`wal-bound-2026-10-05.test.js` |
| `src/memory/failure-episode.js` | `failure-episode.test.js` |
| `src/memory/fork.js` | `fork.test.js` |
| `src/memory/hash-embedder.js` | `hardening-2026-10-24.test.js`<br>`memory-recall-lexicon-2026-10-30.test.js` |
| `src/memory/index.js` | `amem-plugin.test.js`<br>`legion-board.test.js`<br>`memory-backend-slot.test.js`<br>`memory.layers.test.js` |
| `src/memory/l2.js` | `memory-governance-2026-10-04.test.js`<br>`scene-active.test.js`<br>`scene-id-backfill-2026-10-04.test.js`<br>`schema-migration.test.js` |
| `src/memory/l3.js` | `fork.test.js`<br>`persona-read-cache.test.js`<br>`prefix-cache-static-region.test.js` |
| `src/memory/lexicon.js` | `memory-recall-lexicon-2026-10-30.test.js` |
| `src/memory/memory-ticker.js` | `extract-cost.test.js`<br>`longterm-tail-retention-2026-10-04.test.js`<br>`memory-extract.test.js`<br>`memory-governance-2026-10-04.test.js`<br>`memory-query.test.js`<br>`perf-memory-hotpath.test.js`<br>`provenance-injection-render.test.js`<br>`turn-archive-batch-2026-10-30.test.js` |
| `src/memory/project-md.js` | `project-md.test.js` |
| `src/memory/session.js` | `compaction.test.js`<br>`extract-cost.test.js`<br>`memory-extract.test.js`<br>`memory-governance-2026-10-04.test.js`<br>`perf-memory-hotpath.test.js`<br>`rename-override.test.js`<br>`session-append.test.js`<br>`session-cache.test.js`<br>`session-concurrency-2026-10-05.test.js`<br>`session-daily-shard.test.js`<br>`session-manage.test.js`<br>`session.test.js`<br>`tool-evidence-context.test.js` |
| `src/memory/vector-disk.js` | `hardening-2026-10-24.test.js` |
| `src/orchestrator/dag.js` | `dag.test.js`<br>`fixes-2026-09-18b.test.js`<br>`hardening.test.js` |
| `src/orchestrator/expert-pack.js` | `expert-pack.test.js` |
| `src/orchestrator/experts.js` | `experts.test.js`<br>`orchestration-tools.test.js`<br>`teams.test.js`<br>`user-experts.test.js` |
| `src/orchestrator/governor.js` | `cross-process-quota.test.js`<br>`governor.test.js`<br>`legion-governor.test.js`<br>`orchestration-tools.test.js` |
| `src/orchestrator/legion.js` | `hardening-2026-10-24.test.js`<br>`hardening.test.js`<br>`legion-governor.test.js`<br>`legion.test.js`<br>`lifecycle-2026-10-04.test.js`<br>`worktree-isolation-2026-11-16.test.js` |
| `src/orchestrator/personas.js` | `expert-pack.test.js` |
| `src/orchestrator/quota-file.js` | `cross-process-quota.test.js` |
| `src/orchestrator/room.js` | `team-room.test.js` |
| `src/orchestrator/teams.js` | `orchestration-tools.test.js`<br>`teams.test.js` |
| `src/orchestrator/worktree.js` | `worktree-isolation-2026-11-16.test.js` |
| `src/permissions/index.js` | `apply-patch-codex.test.js`<br>`apply-patch-unprovable.test.js`<br>`apply-patch-works.test.js`<br>`capability-guard.test.js`<br>`hardening-2026-10-24.test.js`<br>`permission-intersection.test.js`<br>`permissions-apply-patch.test.js`<br>`permissions.test.js`<br>`plan-mode.test.js` |
| `src/permissions/intersection.js` | `permission-intersection.test.js` |
| `src/plugin/context.js` | `plugin-access.test.js` |
| `src/plugin/index.js` | `amem-plugin.test.js`<br>`memory-backend-slot.test.js`<br>`plugin-access.test.js`<br>`plugin-dx.test.js`<br>`plugin-manifest.test.js`<br>`plugin.test.js` |
| `src/protocol/index.js` | `protocol-eq-tools.test.js`<br>`protocol-sq-real.test.js`<br>`protocol-turn-r12-2026-10-24.test.js`<br>`protocol.test.js` |
| `src/repomap/index.js` | `hardening-r2-2026-10-24.test.js`<br>`repomap.test.js` |
| `src/repomap/wiki.js` | `wiki.test.js` |
| `src/seam/shell.js` | `command-guard.test.js`<br>`docker-shell.test.js`<br>`seam-shell.test.js` |
| `src/security/injection.js` | `hardening-2026-10-04.test.js`<br>`redteam.test.js` |
| `src/security/shell-parse.js` | `hardening-2026-10-24.test.js` |
| `src/selfcode/engine.js` | `selfcode.test.js` |
| `src/selfcode/graph.js` | `selfcode-graph-2026-11-16.test.js` |
| `src/selfcode/selfiterate.js` | `selfiterate.test.js` |
| `src/selfcode/source-text.js` | `unit-gaps-2026-11-16.test.js` |
| `src/selfcode/verify.js` | `selfcode.test.js` |
| `src/server.js` | `ans-api.test.js`<br>`api-expansion-2026-10-07.test.js`<br>`audit-2026-09-17.test.js`<br>`channels.test.js`<br>`mcp-server.test.js`<br>`mcp-stream.test.js`<br>`providers-api.test.js`<br>`server-channels.test.js`<br>`settings-api.test.js`<br>`tasks-api.test.js` |
| `src/services/diagnose.js` | `diagnose.test.js` |
| `src/services/learning-service.js` | `hardening-2026-10-24.test.js`<br>`services.test.js` |
| `src/services/memory-service.js` | `services.test.js` |
| `src/services/update.js` | `update-check.test.js` |
| `src/session/plan-live.js` | `unit-gaps-2026-11-16.test.js` |
| `src/session/projection.js` | `protocol-turn-r12-2026-10-24.test.js` |
| `src/session/turn.js` | `protocol-turn-r12-2026-10-24.test.js`<br>`session-turn.test.js` |
| `src/session/workstack.js` | `body-2026-10-30.test.js` |
| `src/skills/importer.js` | `plugin-dx.test.js`<br>`skill-importer.test.js` |
| `src/skills/lint.js` | `skills-registry.test.js` |
| `src/skills/loader.js` | `absorb.deepseek.test.js`<br>`skill-sections.test.js`<br>`skill-usage.test.js`<br>`skills-priority.test.js`<br>`skills-registry.test.js`<br>`skills-scan-cache.test.js`<br>`skills-search.test.js` |
| `src/skills/registry.js` | `orchestration-tools.test.js`<br>`skill-hub-2026-11-16.test.js`<br>`skills-priority.test.js`<br>`skills-registry.test.js` |
| `src/skills/search.js` | `skills-search.test.js` |
| `src/skills/verify.js` | `audit.test.js`<br>`skill-upgrade.test.js`<br>`verify.test.js` |
| `src/tools/anchored-edit.js` | `unit-gaps-2026-11-16.test.js` |
| `src/tools/builtin-memory.js` | `memory-recall-multi-source-2026-11-16.test.js` |
| `src/tools/builtin.js` | `codeact.test.js`<br>`hardening-r2-2026-10-24.test.js`<br>`hardening-r3-2026-10-24.test.js`<br>`list-dir-in-sandbox.test.js`<br>`multimodal.test.js`<br>`parallel-tools.test.js`<br>`postcondition-gate-2026-10-05.test.js`<br>`provenance-injection-render.test.js`<br>`tool-result-header.test.js`<br>`write-selfcheck-2026-10-05.test.js` |
| `src/tools/catalog.js` | `audit-chain.test.js`<br>`catalog-guard.test.js`<br>`codeact.test.js`<br>`custom-tools.test.js`<br>`document.test.js`<br>`evolution-loop.test.js`<br>`git-tools.test.js`<br>`goal-board-2026-10-05.test.js`<br>`hardening-r2-2026-10-24.test.js`<br>`hardening-r3-2026-10-24.test.js`<br>`mcp.test.js`<br>`multimodal.test.js`<br>`ocr.test.js`<br>`prefix-cache-static-region.test.js`<br>`provenance-injection-render.test.js`<br>`redteam.test.js`<br>`selfcode.test.js`<br>`selfiterate.test.js`<br>`skills-search.test.js`<br>`supervisor-overround.test.js`<br>`tool-result-header.test.js`<br>`tools.test.js` |
| `src/tools/command-guard.js` | `command-guard.test.js`<br>`guard-cmd-del.test.js`<br>`hardening-2026-10-04.test.js`<br>`hardening-2026-10-24.test.js`<br>`redteam.test.js` |
| `src/tools/custom.js` | `custom-tools.test.js` |
| `src/tools/delegate.js` | `delegate.test.js`<br>`hardening.test.js`<br>`legion-board.test.js`<br>`lifecycle-2026-10-04.test.js`<br>`supervisor-overround.test.js`<br>`team-orchestration.test.js`<br>`user-experts.test.js` |
| `src/tools/document.js` | `document.test.js`<br>`ocr.test.js` |
| `src/tools/git.js` | `git-tools.test.js` |
| `src/tools/index.js` | `absorb.deepseek.test.js`<br>`absorb.hermes.test.js`<br>`advanced.tools.test.js`<br>`apply-patch-codex.test.js`<br>`apply-patch-unprovable.test.js`<br>`apply-patch-works.test.js`<br>`capability-guard.test.js`<br>`clarify-no-responder.test.js`<br>`error-semantics.test.js`<br>`fetch-page.test.js`<br>`fixes-2026-09-18.test.js`<br>`lifecycle-2026-10-04.test.js`<br>`list-dir-in-sandbox.test.js`<br>`memory-recall-multi-source-2026-11-16.test.js`<br>`methods.test.js`<br>`policy.test.js`<br>`postcondition-gate-2026-10-05.test.js`<br>`protected-read.test.js`<br>`redteam.test.js`<br>`sandbox-heap-cap.test.js`<br>`session-written-js.test.js`<br>`skill-usage.test.js`<br>`skills-priority.test.js`<br>`tool-exposure-2026-10-30.test.js`<br>`tool-hooks.test.js`<br>`tool-log-noargs.test.js`<br>`tools.test.js`<br>`v31-embed-local.test.js`<br>`write-selfcheck-2026-10-05.test.js` |
| `src/tools/net-guard.js` | `fetch-page.test.js`<br>`fixes-2026-09-18.test.js` |
| `src/tools/ocr.js` | `ocr.test.js` |
| `src/tools/plan-live.js` | `unit-gaps-2026-11-16.test.js` |
| `src/tools/sandbox.js` | `hardening-2026-10-04.test.js`<br>`sandbox-heap-cap.test.js` |
| `src/tools/scheduler.js` | `absorb.hermes.test.js`<br>`fixes-2026-09-18.test.js` |
| `src/tools/seam.js` | `timeout.test.js`<br>`tool-result-header.test.js`<br>`unit-gaps-2026-11-16.test.js` |
| `src/tools/selfcode.js` | `selfcode.test.js` |
| `src/tools/selfiterate.js` | `evolution-loop.test.js`<br>`selfiterate.test.js` |
| `src/tools/selfmod.js` | `skill-usage.test.js`<br>`skills-search.test.js` |
| `src/tools/skill-hub.js` | `skill-hub-2026-11-16.test.js` |
| `src/tools/v3.js` | `apply-patch-codex.test.js`<br>`apply-patch-unprovable.test.js`<br>`apply-patch-works.test.js`<br>`fixes-2026-09-18.test.js`<br>`fixes-2026-09-18b.test.js`<br>`goal-board-2026-10-05.test.js`<br>`postcondition-gate-2026-10-05.test.js`<br>`session-written-js.test.js`<br>`write-selfcheck-2026-10-05.test.js` |
| `src/tools/voice.js` | `oobox.test.js`<br>`voice.test.js` |
| `src/tools/world-model.js` | `unit-gaps-2026-11-16.test.js` |
| `src/utils/canonical.js` | `tool-loop-hardening-2026-10-30.test.js` |
| `src/utils/config-file.js` | `config-location.test.js` |
| `src/utils/http.js` | `fixes-2026-09-18.test.js` |
| `src/utils/logger.js` | `goal-board-2026-10-05.test.js`<br>`orchestration-tools.test.js`<br>`prefix-cache-static-region.test.js`<br>`provenance-injection-render.test.js`<br>`team-orchestration.test.js`<br>`team-room.test.js`<br>`tool-log-noargs.test.js` |
| `src/utils/pii.js` | `agent.test.js` |
| `src/utils/schema.js` | `schema-migration.test.js` |
| `src/utils/session-key.js` | `team-room.test.js` |
| `src/utils/store.js` | `eval-production-events.test.js`<br>`global-memory.test.js`<br>`lock-async-guard.test.js`<br>`longterm-tail-retention-2026-10-04.test.js`<br>`memory-governance-2026-10-04.test.js`<br>`session-concurrency-2026-10-05.test.js`<br>`trace.test.js`<br>`wal-bound-2026-10-05.test.js` |
| `src/utils/text.js` | `context-budget-wiring-2026-11-16.test.js`<br>`context-overflow.test.js`<br>`hardening-2026-10-24.test.js`<br>`token-calibration.test.js`<br>`tool-evidence-context.test.js` |
| `src/utils/token-calibration.js` | `token-calibration.test.js` |
| `src/utils/trace.js` | `eval-production-events.test.js`<br>`hardening.test.js`<br>`trace-replay.test.js` |
| `src/utils/wal.js` | `fact-wal.test.js`<br>`wal-bound-2026-10-05.test.js` |
| `src/verify/postcondition.js` | `postcondition-gate-2026-10-05.test.js` |
| `src/verify/review.js` | `hardening-r2-2026-10-24.test.js`<br>`hardening-r4-2026-10-24.test.js`<br>`review.test.js` |
| `src/web/bot-api.js` | `permission-confirm.test.js` |
| `src/web/bot-store.js` | `bot-api.test.js` |
| `src/web/bot-view.js` | `body-2026-10-30.test.js`<br>`body-skin-2026-10-30.test.js`<br>`bot-api.test.js` |
| `src/web/read-json.js` | `unit-gaps-2026-11-16.test.js` |
| `src/workgraph/service.js` | `workgraph-runid-2026-11-16.test.js` |
| `src/workgraph/store.js` | `workgraph-runid-2026-11-16.test.js` |
| `src/worldmodel/index.js` | `worldmodel-engine-2026-11-16.test.js`<br>`worldmodel-parse-2026-11-16.test.js` |
| `src/worldmodel/server.js` | `worldmodel-engine-2026-11-16.test.js` |

## 孤儿测试 (不 import src)

- `test/bench-raw-requests.test.js`
- `test/bench-tasks-verify.test.js`
- `test/bench-verifiers-falsifiable.test.js`
- `test/cache-audit-integrity.test.js`
- `test/cli-gate.test.js`
- `test/eval-ledger-report.test.js`
- `test/eval-multilingual.test.js`
- `test/lock-two-process-rmw.test.js`
- `test/majority-verdict.test.js`
- `test/pixel-avatar.test.js`
- `test/readme-sync-check.test.js`
- `test/regression-check.test.js`
- `test/skill-memory-drift.test.js`
- `test/taskbench-offline-legacy.test.js`
- `test/taskbench-repeat.test.js`
- `test/taskbench-report.test.js`
- `test/taskbench.test.js`
- `test/trajectory-score.test.js`
- `test/webapp-appearance.test.js`
- `test/wechat-cdata.test.js`
- `test/zz-selfrepair-probe.test.js`
