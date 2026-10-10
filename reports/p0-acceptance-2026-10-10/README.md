# P0 repair and live acceptance — 2026-10-10

修复统一工具状态与实际派发回执；命令非零退出进入恢复链，业务读取正文与错误元数据分离。模型回退共用当前消息、回执和轮次；普通及流式入口均保留已执行操作，超时或失败不能证明未提交。钩子与审批改参后的实际参数进入账本，原提案与实际参数共享一次回执消费。localIntent经过统一权限入口，mandatory安全订阅者和畸形判定拒绝执行。PII开启时完整缓冲后脱敏，覆盖HTTP/MCP增量、工具、错误及最终出口。基准按产物、真实读取内容和回执判定，失败exit非零，重复尝试完整计费；未知usage/价格保持unknown。工具关闭时上下文如实说明仅文字能力。

Original package was preserved. Base: `873cfdb1477660defb1524aaff43f8d3394cd4d1`. Final source hashes, provider usage, synthetic outputs and trajectory reviews are in `metrics.json` and `trials.json`.

| 指标 | 最终冻结代码的独立40次结果 |
|---|---|
| 严格端到端任务完成率（含用户回复） | 38/40 = 95.0% |
| 产物与持久状态完成率 | 40/40 = 100.0% |
| 未知工具幻觉率 | 0/153 |
| 参数幻觉率 | 0/153 |
| 影子调用率 | 0/103 |
| 额外无依据验证宣称 | 0 |
| 已知首回复不满意 | 2 |
| 错误恢复率 | 15/15 |
| 每成功任务成本 | USD 0.00124639 |
| 最终轮总成本 | USD 0.04736270 |
| 平均 / P95 耗时 | 8.17s / 16.87s |
| 完整回归 | 1691通过 / 4跳过 / 0失败 (v24.21.0) |

Completion and recovery are controlled-fixture rates, not production guarantees. Five repeats per task cannot establish population-wide stability. Tool hallucination classes do not measure every factual error in prose. Unsupported verification claims are reported separately from pure shadow calls. Safe approval refusals and deliberately injected exit errors are not parameter hallucinations.

Artifact/state completion is distinct from strict end-to-end completion: 2 initial replies were unsatisfactory (memory-restart-1, memory-restart-2); memory was actually persisted and subsequently recalled, while unnecessary verification exhausted the first turn. These count as strict failures and remain in the cost denominator calculation. Other P1 quality observations are retained in metrics and reviews.

Cost uses actual DeepSeek cache-hit/cache-miss/output usage and the [official 2026-10-10 off-peak USD tariff](https://api-docs.deepseek.com/quick_start/pricing/). It includes auxiliary, retry and fallback requests; it is not an invoice. The opt-in script leaves cost unknown for another model/provider/date or missing usage.

Reproduce with your secret manager injecting `PPX_LIVE_API_KEY` into the process environment, then `node scripts/p0-live-acceptance.mjs --repeat 5 --output <fresh directory>`. The credential is removed from the shell-tool environment. Re-check current tariffs before future evaluation. The script leaves semantic rates null until trajectory review; do not equate schema pass with semantic accuracy.

Offline validation: all test files in an isolated system TEMP copy, Node v24.21.0, `--test --test-force-exit --test-concurrency=4`, `PPX_NET_TEST=0`; four gated tests remain skipped. Verifier falsification: 20 reference cases accepted and 44 wrong/missing/changed-output cases rejected. P0 hooks/approval/PII/runtime adjacent regression 98/98.

Development receipts retain the 37/40 pre-fix cohort (three disabled-tool DSML responses), earlier command approval/network failures, and interrupted runs. They are not pooled into the final release score. See `developmentHistory` for known spend and missing/in-flight usage.

Residual limits: business idempotency keys are required for semantically equivalent but differently represented commands and external irreversible actions; configured PII pattern detection is not universal privacy protection; masking buffers delay first delta; unnecessary shell validation requests and factual overclaims may remain. Production 100% safety inspection and task-level stratified 5% quality sampling are not deployed by this isolated repair. Existing Windows Node 24.19 force-exit native crashes were reproduced with upstream code; resource cleanup and the already-installed 24.21 runtime passed the final suite without claiming to cure Node itself.
