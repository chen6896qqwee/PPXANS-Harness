# 外部基准适配器 (EXTERNAL-BENCH)

> 目的: 仓库全部基准 (taskbench / selfheal / memory-recall) 都是自建的 —— 防回归一流，
> 但回答不了"和外部水平比怎么样"。本适配器把 agent 接到**外部基准的数据格式**上，
> 数据集由使用者提供，仓库不内置任何外部数据。

## 数据格式

JSONL，每行一题（GAIA 文本题风格）：

```json
{"id": "gaia-001", "question": "……", "answer": "……", "eval_type": "exact_match"}
{"id": "gaia-002", "question": "……", "answer": "3288", "eval_type": "numeric", "files": {"notes.txt": "……"}}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 题目标识（进报告与趋势） |
| `question` | ✓ | 题面（末尾会自动追加 FINAL ANSWER 协议要求） |
| `answer` | ✓ | 标准答案（判分器据此判分，不调 LLM —— 确定性、可证伪） |
| `eval_type` | ✓ | `exact_match`（归一化命中）/ `contains`（全词按次数命中）/ `numeric`（数值容差比对） |
| `files` | — | `{文件名: 内容}`，落进任务沙箱供 agent 读取 |
| `category` | — | 自由标注（报告分组用） |

## 判分协议

题面末尾注入一行回答要求（GAIA 官方口径）：

> 最终答案独占一行，以 `FINAL ANSWER: ` 开头 —— 判分只认这一行。

- 有协议行 → 只判该行内容，回执带 `viaFinalAnswer: true`；
- 没有协议行 → 回退判全文（并如实标注），不会因此判红。

判分器全部纯函数、离线可测（`test/external-bench.test.js`），且内置**负对照**：
离线自检时对每题喂"故意答错"的回复，错答案必须判红，否则判分器直接报错退出 ——
尺子自己也要可证伪。

## 跑法

```bash
# 离线自检 (零 LLM 零网络): 脚本模型按协议作答 + 负对照, 证明管线与判分器
npm run bench:external -- --dataset bench/external/sample.jsonl --offline

# 真 LLM 模式 (复用仓库 config/ppx.json 的 Key, 沙箱内干活):
npm run bench:external -- --dataset <你的数据集.jsonl>
npm run bench:external -- --dataset ... --limit 20      # 只跑前 20 题
npm run bench:external -- --dataset ... --json --strict # 机读 + 有失败即非零
```

结果落 `data/bench/external-bench-history.jsonl`（趋势，保留最近 60 条），
`--json` 输出全量明细。

## 从 GAIA 拿数据

GAIA 数据集在 HuggingFace 是 gated 下载（需同意条款），**不进仓库**。拿到
`validation` 集后可转换 level-1 文本题（纯文本问答、无图片/表格附件的子集）：

```python
import json, datasets
ds = datasets.load_dataset("gaia-benchmark/GAIA", "textOnly", split="validation")
with open("gaia-l1.jsonl", "w", encoding="utf-8") as f:
    for row in ds:
        if row["Level"] != 1 or row["Final answer"] is None:
            continue
        f.write(json.dumps({
            "id": row["task_id"],
            "question": row["Question"],
            "answer": row["Final answer"],
            "eval_type": "exact_match",   # GAIA 官方判分即精确匹配
            "category": f"gaia-l1",
        }, ensure_ascii=False) + "\n")
```

> 说明: GAIA 官方判分对答案做精确匹配（含数字/逗号归一）。本适配器的 `exact_match`
> 是"归一化后命中"（回复含归一化答案即过），适配 agent 完整句回复的习惯 —— 与官方
> 判分存在口径差异，跑分对比时请注明用的是哪把尺子。

## 边界（诚实声明）

- `--offline` 只证明**管线与判分器**，不证明模型能力（脚本模型是"完美应试者"）；
- 真 LLM 模式的分数依赖模型能力、上下文长度与工具可用性 —— 与公开榜单对比时
  需注明模型、题数与判分口径，本仓库不冒充"GAIA 榜单成绩"；
- `bench/external/sample.jsonl` 是合成样本（category 标 `synthetic-*`），只用于
  离线自检，不是任何外部基准的真实题目。
