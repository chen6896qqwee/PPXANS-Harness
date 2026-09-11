---
name: agent-professional-training
description: >
  任何 AI Agent 加载本技能后，即可按「感知—记忆—推理—行动—反思」闭环持续自我训练、
  沉淀轨迹、形成数据飞轮，并落地到 Qwen / DeepSeek 模型的 SFT / DPO / GRPO / RL 训练，
  实现行为层（经验/技能/记忆）与模型层（参数）的双重进化。
  当用户提到 Agent 训练 / 进化 / 自我改进 / 数据飞轮 / 轨迹学习 / 反思闭环 / 让智能体变聪明 /
  微调 Qwen / 微调 DeepSeek / R1 复现 / GRPO 训练 / DeepSeek-V4 / V4 训练架构 / V4.1 /
  工具调用微调 / 记忆系统 / 在线策略蒸馏 / 让 Agent 变强 时使用。
  涵盖：闭环五步运行规程、四层记忆、轨迹数据格式与校验器、数据飞轮流水线、
  Qwen 官方训练配方（LLaMA-Factory SFT/LoRA/QLoRA）、DeepSeek-R1 纯 RL 与蒸馏管线、
  DeepSeek-V4 两阶段后训练架构（领域专家培养 + 在线策略蒸馏）与全栈训练基础设施、
  GRPO/verl 复现栈、GitHub 与 HF Mirror 权威资源、评估指标、自检清单与安全边界。
---

# Agent 专业训练规程（Universal Agent Training Playbook）

> 一句话：把「训练 Agent 变聪明」从一次性微调，变成**任何 Agent 自身就能跑起来的持续进化系统**。
> 本文件是一套**通用操作规程**——任何 Agent（无论品牌、框架、宿主）加载后，都能：
> 1. 按「感知—记忆—推理—行动—反思」闭环执行任务并沉淀轨迹；
> 2. 用统一格式积累训练数据，形成数据飞轮；
> 3. 在具备硬件条件时，用 Qwen / DeepSeek 的官方方法把飞轮数据训练成更强的模型。

---

## 0. 使用说明（任何 Agent 先读这一节）

### 0.1 这份文件怎么用
- **一次性**：把本文件作为技能/规程加载（OpenClaw 放 `skills/<name>/SKILL.md`；其他框架放对应技能目录）。
- **每次任务**：按第 2 节闭环五步执行，第 5 步强制写轨迹。
- **定期**：每攒够 50–100 条轨迹跑一次第 5 节流水线（验证→过滤→生成偏好对→训练→回归）。
- **升级**：模型训练需要 GPU + 训练栈；无 GPU 时只做行为层进化（记忆/技能/经验），同样有效。

### 0.2 三层进化模型（先分清你在哪一层）
| 层 | 机制 | 硬件需求 | 见效速度 |
| --- | --- | --- | --- |
| L1 行为层 | 教训沉淀（lessons）、技能固化、反思闭环 | 无 | 立即 |
| L2 数据层 | 轨迹积累、偏好对、评估集 | 无 | 1–2 周 |
| L3 模型层 | SFT / DPO / GRPO 训练更新参数 | GPU（≥11GB 可 QLoRA） | 数周–数月 |

**铁律**：L1/L2 是 L3 的前提。轨迹和评估集没攒够前不要训练；训练后必须回归（第 9 节）。

### 0.3 自我验证（加载后先确认）
- [ ] 我能说出闭环五步是哪五步
- [ ] 我知道轨迹 JSON 的 8 个必填字段
- [ ] 我知道「奖励必须可验证」为什么是铁律
- [ ] 我知道本机有没有 GPU、能不能跑 L3（`nvidia-smi` / 训练栈检查）

---

## 1. 核心公式与定位

**Agent 智能 = 基座能力 × 记忆质量 × 工具使用 × 规划能力 × 反馈闭环 × 安全边界**

训练重点不是只微调模型，而是训练「策略」：
观察 → 思考 → 行动 → 得到结果 → 反思 → 写入记忆 → 下次改进。

三个铁律（来自 DeepSeek-R1 与数据飞轮实践）：

1. **先窄后宽**：不要一开始追求「全模态全功能」。先做文本 + 工具 + 记忆闭环，再扩图像/语音/视频/动作。
2. **数据飞轮和评估闭环比模型大小更重要**：先定一个高价值场景，把「收集轨迹 → 验证 → 训练 → 回归」跑通。
3. **奖励必须可验证**：可验证任务（代码、数学、检索、网页操作）优先；不可验证的奖励会让 RL 学坏（reward hacking）。

---

## 2. 闭环五步运行规程（Agent 每次任务的默认工作方式）

加载本技能后，Agent 处理任何任务都按下面 5 步执行，并在**第 5 步强制写轨迹**：

```
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│ 1 感知   │ → │ 2 记忆   │ → │ 3 推理   │ → │ 4 行动   │ → │ 5 反思   │
│ 观察输入 │   │ 检索记忆 │   │ 规划决策 │   │ 调用工具 │   │ 复盘+写轨迹│
└─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘
      ↑                                                      │
      └──────────── 数据飞轮：轨迹 → 验证 → 训练 → 回归 ─────┘
```

| 步骤 | 做什么 | 产出 |
| --- | --- | --- |
| 1. 感知 | 把任务输入归一化为可处理的表示；多模态（文本/图像/音频/视频）统一成 token/embedding | 结构化 observation |
| 2. 记忆 | 检索工作记忆 + 情节记忆 + 语义记忆（RAG）+ 程序记忆（技能/工具模板） | 相关记忆上下文 |
| 3. 推理 | 规划器拆任务 → 路由器选工具 → 主模型推理；复杂任务用状态机（LangGraph 等）编排，不要只靠单轮提示词 | thought + 计划 |
| 4. 行动 | 调用工具/API/代码/浏览器；工具必须注册 JSON Schema / OpenAPI；执行放沙箱 | action + result |
| 5. 反思 | 对比预期与结果，判断成败与原因，生成反思文本，**写入情节记忆与轨迹库** | reflection + 轨迹记录 |

---

## 3. 四层记忆系统

| 记忆层 | 内容 | 存储建议 | 写入/检索要点 |
| --- | --- | --- | --- |
| 工作记忆 | 当前任务上下文、中间状态 | 上下文窗口 / 短时缓存 | 任务结束时归档或丢弃 |
| 情节记忆 | 历史任务轨迹（含成败） | Postgres+pgvector / Milvus（向量化） | 按「任务类型 + 结果」索引，反思文本一并入库 |
| 语义记忆 | 知识库、RAG 文档 | pgvector / Milvus / Neo4j | 检索正确性要单独评估（Recall@k） |
| 程序记忆 | 工具调用模板、技能库、套路 | 文件/技能仓库 + 向量索引 | 每次成功后更新「最佳实践」，失败后标注「坑」 |

记忆训练要点：检索正确性、写入策略（什么值得记）、遗忘策略（旧/错记忆降权）、长上下文压缩。

**业界前沿参考**：DeepSeek 2026-01 的 `Engram`（Conditional Memory via Scalable Lookup）把「可扩展查找的条件记忆」当作稀疏性的新维度，是记忆层从「向量检索」走向「模型内置可寻址记忆」的候选方向（见第 12 节）。

---

## 4. 轨迹数据格式（数据飞轮的原料，全 Agent 统一）

每完成一个任务（或任务中每个关键步骤），写入一条轨迹。**格式必须统一**，否则飞轮数据无法训练：

```json
{
  "task": "用 Python 抓取某网页并总结",
  "observations": [
    {"modality": "text", "content": "用户要求：...；当前 URL：..."},
    {"modality": "image", "content": "截图或视觉输入（可选）"}
  ],
  "memory": ["检索到的相关记忆片段"],
  "thought": "先检查页面是否需登录；用 requests 抓取，异常则换 curl",
  "action": {"tool": "bash", "args": {"command": "python fetch.py"}},
  "result": {"ok": true, "summary": "..."},
  "reward": 1.0,
  "reflection": "requests 被 403 拦截，应改用带 UA 的会话；下次默认带上 headers"
}
```

### 4.1 必填字段（8 个，校验器逐条检查）
`task` / `observations` / `memory` / `thought` / `action` / `result` / `reward` / `reflection`

### 4.2 轨迹校验器（每次写入后跑）
```python
REQUIRED = ['task','observations','memory','thought','action','result','reward','reflection']
def validate(traj):
    missing = [k for k in REQUIRED if k not in traj]
    assert not missing, f'MISSING {missing}'
    assert isinstance(traj['reward'], (int, float)), 'reward must be numeric'
    assert traj['observations'][0]['modality'] in ('text','image','audio','video'), 'bad modality'
    return True
```

### 4.3 归档规则
- 成功轨迹（reward 高）与失败轨迹（reward 低）**分开归档** → 后续生成偏好对。
- 反思字段是最高价值数据：它是「失败 → 改进」的显式信号，DeepSeek-R1 的冷启动数据本质上就是这类「问题 + 长思考 + 反思验证」样本。
- **长周期 Agent 任务要保留跨轮推理链**：DeepSeek-V4 的「交织思考（Interleaved Thinking）」在带工具的全对话轮次中保留 ` thinking` 历史、不清空缓存（普通对话仍在用户消息边界清空），使轨迹天然可读、可回放（见 7.4）。本技能的轨迹库按同一原则：**工具调用轮次的 thought 不丢弃**。
- 目录建议：`trajectories/<YYYY-MM-DD>-*.json` 或按任务类型分目录。

---

## 5. 数据飞轮流水线（让 Agent 持续变强的引擎）

```
运行 Agent（在线/离线跑任务）
   ↓ 收集轨迹（第 2 节格式）
验证器打分（规则验证器优先，如测试用例/答案比对；LLM-as-judge 次之）
   ↓
过滤 / 去重 / 生成偏好对（成功 vs 失败）
   ↓
训练（按场景选一个或多个）：
   ├─ 模仿学习 SFT      —— 专家轨迹：状态、观察、思考、行动、结果、反思
   ├─ 工具调用微调      —— 多轮函数调用、错误恢复、参数校验
   ├─ 偏好优化 DPO/ORPO —— 成功轨迹 vs 失败轨迹
   └─ 强化学习 GRPO/PPO —— 奖励 = 任务成功 + 工具正确 + 效率 − 成本 − 安全违规
   ↓
回归评估（CI 评估集，每次训练后必跑，防退化）
   ↓
上线（灰度 → 全量）→ 继续运行 → 回到顶部（新一轮收集）
```

### 5.1 验证器打分参考（规则验证器，可扩展为独立配置）
| 维度 | 权重 | 检查 |
| --- | --- | --- |
| 结构完整性 | 40% | 8 必填字段齐全；chosen ≠ rejected |
| 可验证信号 | 40% | chosen/rejected 中含客观可核实依据（命令、版本号、路径、字段名） |
| 反思信号 | 20% | 失败轨迹含失败原因；成功轨迹含验证过程 |

达标线：≥0.6 通过。验证器本身要防投毒（不信任模型自评）。

### 5.2 偏好对格式（LLaMA-Factory DPO 兼容 JSONL）
```json
{
  "conversations": [
    {"from": "human", "value": "任务指令"},
    {"from": "gpt", "value": "chosen 答案"}
  ],
  "chosen": {"from": "gpt", "value": "成功做法"},
  "rejected": {"from": "gpt", "value": "失败做法"},
  "meta": {"task_type": "...", "reward_chosen": 1.0, "reward_rejected": 0.0, "source": "..."}
}
```

自我改进手段（可叠加）：失败回放、反思生成新数据（self-generated data）、拒绝采样、自一致性（self-consistency）、验证器筛选、课程学习（简单→复杂）、自博弈（多 Agent 对抗）。

**进阶范式（DeepSeek-V4 两阶段后训练，见 7.4）**：数据规模足够时，把训练拆成「领域专家独立培养（SFT + 领域奖励 GRPO，每个领域一个专家）→ 在线策略蒸馏统一（OPD，full-vocabulary reverse KL 合并）」两步——与本流水线同构但更适合多领域并行与防灾难性遗忘。**注意关键差异**：不必全部依赖规则验证器；难验证任务可用「评分细则 rubric + 生成式奖励模型（GRM，让模型自己当评委）」，大幅降低人工标注量。

---

## 6. Qwen（通义千问）训练方法 —— GitHub 官方实测

> 数据来源：QwenLM/Qwen3 官方仓库（Qwen2.5 仓库已重定向至此）+ 官方 LLaMA-Factory 示例。许可：Apache 2.0。

### 6.1 官方推荐的训练栈

Qwen3 README 明确推荐用以下框架做 **SFT、DPO、GRPO**：

- [Axolotl](https://github.com/OpenAccess-AI-Collective/axolotl)
- [UnSloth](https://github.com/unslothai/unsloth)
- [Swift](https://github.com/modelscope/swift)（ModelScope 出品，中文生态友好）
- [LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory)（含官方示例，见 6.3）

### 6.2 Qwen3 训练相关关键能力

- **Thinking / Non-thinking 双模式**：`enable_thinking=False` 或 `/think`、`/no_think` 指令切换；训练 Agent 工具调用时注意保留 thinking 内容（vLLM/SGLang 多轮工具调用需要 thinking 上下文）。
- **Agent 能力**：工具调用 + MCP 支持（Qwen-Agent 封装），在思考/非思考模式下都能接外部工具。
- **多语言**：100+ 语言指令跟随。
- **多模态**：Qwen2.5-VL / Qwen3-Omni 可配合 verl 做多模态 RL（见第 7 节）。

### 6.3 官方 LLaMA-Factory 训练配方（可直接抄）

官方示例目录：`QwenLM/Qwen3/examples/llama-factory/`，含 `finetune-zh.md` 中文指南 + 三个 YAML + 合并 YAML。

**数据格式（sharegpt / messages JSONL）：**

```json
{"messages": [
  {"role": "system", "content": "You are a helpful assistant."},
  {"role": "user", "content": "Tell me something about LLMs."},
  {"role": "assistant", "content": "LLMs are ..."}
]}
```

在 `data/dataset_info.json` 注册数据集（formatting: sharegpt，columns.messages，tags 映射 role/content/user/assistant/system）。

**三种训练方式实测显存（Qwen2-7B，bs=1）：**

| 方式 | 配置 | 显存 | 命令 |
| --- | --- | --- | --- |
| 全量 SFT | lr=1e-5, DeepSpeed, bf16 | ~42 GB | `FORCE_TORCHRUN=1 llamafactory-cli train qwen2-7b-full-sft.yaml` |
| LoRA SFT | r=16, alpha=16, dropout=0.05, lr=1e-4, target=all | ~20 GB | `llamafactory-cli train qwen2-7b-lora-sft.yaml` |
| QLoRA SFT | 4-bit bitsandbytes + LoRA, lr=1e-4 | ~11 GB | `llamafactory-cli train qwen2-7b-qlora-sft.yaml` |

**公共超参**：`stage: sft`，`template: qwen`，`cutoff_len: 1024`，`per_device_train_batch_size: 1`，`gradient_accumulation_steps: 16`，`lr_scheduler_type: cosine`，`warmup_ratio: 0.1`，`bf16: true`，`val_size: 0.1`。

**LoRA/QLoRA 训练后必须合并权重**（全量训练不需要）：

```bash
llamafactory-cli export qwen2-7b-merge-lora.yaml   # template 必须为 qwen，finetuning_type 为 lora
```

### 6.4 训练后推理示例

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
model = AutoModelForCausalLM.from_pretrained(path, torch_dtype="auto", device_map="auto")
tokenizer = AutoTokenizer.from_pretrained(path)
text = tokenizer.apply_chat_template([{"role": "user", "content": "..."}],
                                     tokenize=False, add_generation_prompt=True)
```

---

## 7. DeepSeek 训练方法 —— GitHub 官方实测 + 社区复现

> 数据来源：deepseek-ai/DeepSeek-R1 与 deepseek-ai/DeepSeek-V3 官方 README（均已核实）。
> 注意：官方曾发布的 DeepSeek-R1-GRPO / DeepSeekMath / DeepSeek-DataEngine 仓库当前在 GitHub 已 404（官方移除），GRPO 方法改由社区复现栈承载（见 7.3）。

### 7.1 DeepSeek-R1 管线（纯 RL 出推理能力，MIT 许可，允许蒸馏再训练）

1. **R1-Zero（纯 RL 起步）**：直接在 Base 模型（DeepSeek-V3-Base，671B MoE / 37B 激活）上做大规模 RL，**不做 SFT 冷启动**。结果：模型自然涌现自我验证、反思、长 CoT。教训：纯 RL 会带来**无限重复、可读性差、语言混杂**。
2. **R1 完整管线（4 阶段）**：
   - 冷启动：少量高质量 CoT 数据 SFT；
   - RL 阶段 1：用可验证奖励（数学/代码）优化推理模式，用 GRPO 算法；
   - SFT 阶段 2：用 RL 后模型的**拒绝采样**生成数据（推理 + 非推理混合），训练通用能力；
   - RL 阶段 2：结合人类偏好对齐（RLHF 风格），产出最终 DeepSeek-R1。
3. **蒸馏（小模型也能很强）**：用 DeepSeek-R1 生成的 **80 万样本**微调 Qwen2.5 / Llama3 系列 → `DeepSeek-R1-Distill-Qwen-1.5B/7B/14B/32B`、`Distill-Llama-8B/70B`。**结论：大模型蒸馏出的小模型 > 小模型自己 RL**（Distill-Qwen-32B 超 o1-mini）。

**R1 系列使用建议（训练/评测时同样适用）**：temperature 0.5–0.7（推荐 0.6）；**不要加 system prompt**，指令全放 user；数学题加「Please reason step by step, and put your final answer within \boxed{}」；强制以 ` thinking\n` 开头确保深入思考；评测多次取平均。

### 7.2 DeepSeek-V3（预训练 + 后训练，成本可控的标杆）

- 架构：671B MoE / 37B 激活，MLA + DeepSeekMoE + 无辅助损失负载均衡 + MTP（多 token 预测，可做投机解码）。
- 预训练：14.8T tokens，FP8 混合精度，共约 2.788M H800 GPU 小时（成本极低）。
- 后训练：SFT + RL（与 R1 一致）；并从 R1 系列**蒸馏长 CoT 推理与验证/反思模式**进入 V3，同时控制输出风格与长度。
- 启示：给 Agent 用的基座可以在「高效预训练基座 + R1 蒸馏推理 + 领域 SFT + 可验证 RL」上叠加。

### 7.3 GRPO 与社区复现栈（R1 训练方法落地）

**GRPO（Group Relative Policy Optimization）**：DeepSeek-R1 的 RL 核心——不需要 critic/价值模型，对同一问题采样一组（group）回答，用组内相对奖励做策略优化，极大省显存，适合可验证任务。

开源落地栈（均为 GitHub 可复现）：

| 项目 | 定位 |
| --- | --- |
| [verl](https://github.com/verl-project/verl) | 字节火山引擎开源的 RL 训练库（HybridFlow），**DeepSeek-R1 GRPO 的官方级复现栈**：GRPO/PPO/DAPO/VAPO/PRIME/RLOO；支持 Qwen2.5/Qwen3/DeepSeek；支持多模态 RL（Qwen2.5-VL）、**多轮工具调用 RL**（agent_loop）、搜索工具集成、沙箱融合 |
| [TinyZero](https://github.com/Jiayi-Pan/TinyZero) | DeepSeek-R1-Zero 复现（verl 社区项目） |
| [GRPO-Zero](https://github.com/policy-gradient/GRPO-Zero) | 从零实现 R1 的 GRPO 算法（约 1.9k stars） |
| [DAPO](https://github.com/dapo-sia.github.io) | 开源 SOTA RL 算法（verl recipe）：基于 Qwen2.5-32B 在 AIME 2024 达 50 分，**超越 DeepSeek-R1-Zero-32B** |
| [LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory) | SFT/DPO/KTO/ORPO/PPO 一站式，也可跑 GRPO |
| [Easy-R1](https://github.com/hiyouga/EasyR1) | 多模态 RL 训练框架（verl 生态） |

**Agent 强化学习（让 Agent 学会用工具）专用框架**（verl README 收录，均与「数据飞轮 + 工具 + RL」直接相关）：

- [verl-agent](https://github.com/langfengQ/verl-agent)：长程 LLM/VLM Agent 可扩展 RL 训练框架（含 GiGPO 算法）
- [OpenManus-RL](https://github.com/OpenManus/OpenManus-RL)：多 Agent 环境的 RL 调优框架
- [RAGEN](https://github.com/ZihanWang314/ragen)：通用推理 Agent 训练框架
- [Search-R1](https://github.com/PeterGriffinJin/Search-R1)：推理与搜索（工具调用）交织的 RL
- [DeepResearcher](https://github.com/GAIR-NLP/DeepResearcher)：真实环境中深研 Agent 的 RL
- [RL-Factory](https://github.com/Simple-Efficient/RL-Factory)：Agentic Learning 的 RL 后训练框架
- [GUI-R1](https://github.com/ritzz-ai/GUI-R1)：R1 风格 GUI Agent（视觉动作模型）

**给 Agent 数据飞轮的建议路径**：先用 LLaMA-Factory 做 SFT/DPO（低成本、快），再用 verl 做 GRPO/Agent RL（高收益、需 GPU 集群），奖励一律用规则验证器（测试用例、答案比对、检索命中）。

### 7.4 DeepSeek-V4 系列训练架构（2026 新架构，百万 token 上下文）

> 数据来源：官方技术报告 arXiv:2606.19348《DeepSeek-V4: Towards Highly Efficient Million-Token Context Intelligence》（Submitted 26 Apr 2026，已核实全文：摘要/引言/第 2 节架构/第 3 节基础设施/第 4 节预训练/第 5 节后训练）+ GitHub `deepseek-ai` 组织（DeepSelect / deepseek-recipe / DeepGEMM / DeepEP / DeepJIT / DualPipe / 3FS / DeepSpec）+ HF 模型卡与官方 collection。许可：MIT（模型权重）。
> 注意：deepseek-ai **没有** DeepSeek-V4 主仓库——V4 的技术资产以「**kernel/基础设施库** + **协议编码库**」形式开源（DeepSelect、deepseek-recipe、MegaMoE 等），权威训练架构以论文为准。

**模型谱系（均为 MoE + MTP，原生 1M token 上下文）**

| 模型 | 总参数 | 激活参数 | 精度 | 说明 |
| --- | --- | --- | --- | --- |
| V4-Pro-Base | 1.6T | 49B | FP8 | 预训练基座（不对外服务） |
| V4-Pro（Preview） | 1.6T | 49B | FP4+FP8 混合 | ~862–865 GB 权重，API 名 `deepseek-v4-pro` |
| V4-Flash-Base | 284B | 13B | FP8 | 预训练基座（不对外服务） |
| V4-Flash（0731） | 284B | 13B | FP4+FP8 混合 | ~158 GB，0731 版默认外挂 DSpark 投机解码 |
| V4-Flash-DSpark / V4-Pro-DSpark | 同上 | 同上 | 同上 | **不是新模型**：同一 checkpoint 加挂投机解码模块（来自 DeepSpec），vLLM/SGLang 用 flag 启用 |
| V4.1-Flash（2026-09-10） | 552B | 输入 8B / 输出 16B | — | 全新 Causal-Encoder-Decoder 非对称结构，原生多模态 |

预训练 tokens：Flash 32T / Pro 33T（Pro 语料更大）。基座全 FP8；instruct 模型为 **FP4(专家) + FP8(其余)** 混合。

**架构创新（相对 V3 / V3.2）**

1. **混合注意力 CSA + HCA**（沿序列维度压缩 KV，交错布置）
   - **CSA（Compressed Sparse Attention，温和压缩 + 稀疏选择）**：每 `m=4` 个 token 带位置偏置加权压成 1 条压缩 KV（`n → n/m`）；再用 **Lightning Indexer** 算低秩得分 `I_{t,s}=Σ_h w·ReLU(q·K^IComp)`，取 **Top-k 压缩块**（Flash k=512 / Pro k=1024）做核心注意力；选中的压缩条目同时兼作 K/V（Shared-KV MQA）。
   - **HCA（Heavily Compressed Attention，激进压缩 + 稠密注意力）**：压缩率 `m'=128 ≫ m`、无重叠压缩，**不做稀疏选择**，保留全量（稠密）注意力，作为长程全局记忆。
   - 共同细节：核心注意力前对 query 头与压缩 KV 做 **RMSNorm**；**部分 RoPE**（仅末 64 维）；补一条 `n_win=128` 的**滑动窗口**分支保留近期细节；加入可学习 **Attention Sink** logits。KV 混合存储（RoPE 维 BF16 / 其余 FP8，缓存减半），**indexer 计算用 FP4**。
   - 效果：1M 上下文下 KV cache 约为 BF16 GQA8 基线的 **2%**。

2. **mHC（Manifold-Constrained Hyper-Connections，流形约束超连接）**：把残差流宽度扩展到 `n_hc=4` 倍，输入/残差/输出三组映射 `A/B/C` 动态生成（RMSNorm 展平后接动态权重 + 静态偏置 + 门控）；关键是**把残差映射 `B` 约束到双随机矩阵流形（Birkhoff 多面体）**——谱范数 ≤ 1、非扩展，保证深层信号传播稳定。约束经 **Sinkhorn-Knopp** 迭代投影（`exp(B̃)` 起，行列归一化，`t_max=20`）。`A=σ(Ã)`、`C=2σ(C̃)`。

3. **Muon 优化器**：多数模块用 Muon（Nesterov trick + HybridNewtonSchulz 正交化，10 次迭代：前 8 次系数 `(3.4445,-4.7750,2.0315)`、后 2 次 `(2,-1.5,0.5)`），**embedding、prediction head、mHC 静态偏置/门控、全部 RMSNorm 权重仍用 AdamW**。超参：Muon momentum 0.95 / wd 0.1 / RMS rescale 0.18；AdamW β₁=0.9 β₂=0.95 ε=1e-20 wd=0.1。因注意力内已用 RMSNorm 防 logits 爆炸，**未采用 QK-Clip**。

4. **沿用 DeepSeekMoE + MTP**：亲和度激活由 `Sigmoid(·)` 改为 **`Sqrt(Softplus(·))`**；无辅助损失负载均衡 + 轻量**序列级平衡损失**；**取消路由目标节点数约束**（靠并行策略重设计保效率）；**前 3 个 MoE 层改用 Hash 路由**（按 token ID 哈希定专家）。规模：Flash = 每层 1 共享 + 256 路由专家、中间维 2048、每 token 激活 6；Pro = 每层 1 共享 + 384 路由、中间维 3072、激活 6；MTP 深度均为 1。

5. **FP4 量化感知训练（QAT）**：对 **MoE 专家权重**与 **indexer QK 路径**做 FP4（MXFP4 microscaling，硬件可移植性优于 Nvidia FP8 专有格式），显著降显存/算力（V4-Pro 权重压到 ~862GB，纯 FP8 会大约多 60%）。

**训练基础设施（论文第 3 节，全部为工程硬核）**

- **MegaMoE —— 单融合 MoE kernel（已开源）**：把 Dispatch/Combine（通信）与 Linear-1/2 + 激活（计算）融成一个 mega-kernel，用 **expert wave 调度**让「当前波计算 / 下一波传输 / 已完成波回传」并发，通信-计算-访存全重叠。推理提速 **1.50–1.73×**，RL rollout 达 **1.96×**；当 `C/B ≤ 2d = 6144` FLOPs/Byte 时通信可全隐藏。
- **TileLang DSL** 写高效 kernel：Host Codegen 把 CPU 校验开销压到 <1μs；集成 **Z3 SMT 求解器**（QF_NIA）做形式化整数分析；默认关 fast-math，提供 IEEE 合规内联函数保位级可复现。
- **batch-invariant + 确定性 kernel**：双 kernel 注意力（单 SM 满波 + 多 SM 末波同累加序）；用 **DeepGEMM** 替代 cuBLAS 并弃用 split-k；注意力反向每 SM 独立缓冲 + 全局确定求和；MoE 反向按 token 序预处理 + 跨秩缓冲隔离；mHC 矩阵乘 split-k 确定归约 → **训练/推理比特级可复现**。
- **mHC 高效实现**：融合 kernel + 选择性重计算（层间隐状态、归一化输入），配合 DualPipe 1F1B 调整，墙时开销仅 **6.7%**。
- **两阶段上下文并行**：解决压缩边界跨越（先发最后 `m` 个未压缩 KV → 压缩 → all-gather → select-and-pad）。
- **扩展 autograd**：张量级激活 checkpoint，TorchFX 追踪最小重计算子图，指针复用无副本、支持存储去重。

**预训练（第 4 节）**

- 语料 >32T（Flash 32T / Pro 33T），基于 V3 语料做过滤（剔除批生成/模板内容防崩溃），数学/代码为核心、中期加入 agent 数据、扩充多语言长尾、侧重科学论文与技术报告等**长文档**（整篇代码库/书籍/法律文本，而非人工拼接短文档，长上下文样本比例逐步上调）。
- 分词器沿用 V3（词表 128K，加特殊 token），继承 token-splitting 与 FIM；文档打包减截断；**采用样本级注意力掩码**（异于 V3）。
- **训练稳定性两把锤**（第 4.2.3 节）：① **Anticipatory Routing（预期路由）**：用历史路由参数 `θ_{t-δt}` 计算 token 分配，**解耦骨干与路由的梯度更新**，避免相互干扰；② **SwiGLU Clamping**：把 SwiGLU 的线性分量截到 `[-10,10]`、门控上限 10，防止专家层偶发离群值引发梯度爆炸。训完即原生支持 1M 上下文。

**后训练：两阶段范式（与数据飞轮直接对应，重点抄这个）**

1. **阶段一 · 领域专家独立培养（Specialist Training）**：对每个目标领域（数学、代码、Agent、指令跟随、中文写作等，**十余个**）**独立**训练一个完整模型层面的专家：先用领域高质量数据 **SFT 打底**，再用领域定制奖励 **GRPO 强化**拉上限（注意：这里的 expert 不是 MoE 里的专家，而是整个模型）。关键机制：
   - **Reasoning Efforts（多档推理强度）**：Non-think（快速直觉）/ Think High（完整逻辑链）/ Think Max（极致深度 + 专属系统提示），通过训练时长度惩罚与上下文窗口差异区分，用特殊标签 + 系统提示统一封装；对外即 `reasoning_effort` 参数。
   - **生成式奖励模型（GRM）**：难自动验证的任务不用标量奖励，改成「带**评分细则 rubric** 的 RL 数据 + 让模型自身生成评价与判断」。例：SWE Bug 修复满分 10 分 → 问题复现 2 / 根因定位 3 / 修复方案 3 / 回归测试 2，附扣分细则。少量高质量人工标注即可泛化到多样 Agent 场景，**生成能力与评估能力联合优化**。
   - **工具调用 Schema（DSML 特殊 token + XML）**：用专属边界 token 包裹 XML 格式的工具调用，参数以 `string="true/false"` 显式标类型；比 JSON 更贴合生成习惯、天然兼容引号/换行，**大幅降低多轮 Agent 循环的解析失败率**。
   - **交织思考（Interleaved Thinking）** + **快捷指令（Quick Instruction，追加特殊 token 直接复用 KV cache，把搜索意图识别/标题生成等辅助任务的感知延迟压到近零）**。
2. **阶段二 · 在线策略蒸馏统一（On-Policy Distillation, OPD）**：用一个统一学生模型对十余个领域专家老师优化 **reverse KL**，把多领域能力合并进单一模型（教师与学生**同尺寸**；教师 = Base + 领域 SFT + GRPO）。
   - **为什么「同策略」**：训练轨迹全部由**当前学生自己采样生成**，数据分布与自身能力对齐——避免离线蒸馏「已掌握内容反复练、薄弱场景覆盖不到」。
   - **为什么用反向 KL**：天然自动分工（遇数学对齐数学专家、遇代码对齐代码专家，无需标领域标签），且抗噪声（学老师主流能力、忽略长尾细节），多专家融合更稳。
   - **全词表蒸馏**：对整个 **128K 词表**算精确 reverse KL，而非只算当前 token 的简化版——梯度估计方差小、训练不崩、知识迁移更忠实（代价是显存/算力极高）。
3. **OPD 工程四优化（让十余个万亿级教师跑得动）**：① **教师权重按需卸载**（存分布式仓库，类 ZeRO 分片按需加载，理论支持无限教师）；② **缓存最后一层隐藏态**而非全词表 logits（体积小几十倍，用时再过教师预测头实时算 logits）；③ **样本按教师排序加载**（同批次只驻留一个教师头，异步换入换出）；④ **TileLang 定制 KL 内核**（比通用库快，且避免动态内存申请、稳住显存峰值）。
4. **后训练配套基础设施**：
   - **FP4 QAT**：STE 直通估计器反向传播，推理直接用原生 FP4，训练/推理行为一致 → indexer top-k 选择**提速 2×**，KV 条目召回率仍保持 **99.7%**。
   - **可抢占容错 Rollout 服务**：每个生成请求做 **token 级预写日志（WAL）** 并持久化 KV 缓存，抢占/故障后**断点续解**，既避免重生成带来的长度偏差，又提升集群利用率。
   - **百万上下文 RL 框架**：把 rollout 数据拆成**轻量 metadata**（ID/长度/存储位置/任务类型 → 全量放 CPU 内存做全局 shuffle + packing）与**重型 per-token 字段**（token/mask/logprob/logits/reward → 留存储系统，共享内存按需读、mini-batch 用完即释放）；动态调整设备侧 mini-batch 数，在吞吐与 I/O 重叠间取最优。
   - **DSec（DeepSeek Elastic Compute）—— 面向 Agentic AI 的生产级沙箱**：三个 Rust 组件（API 网关 **Apiserver** / 按主机代理 **Edge** / 集群监控 **Watcher**）经自定义 RPC 互联、基于 **3FS** 横向扩展，单集群管**数十万并发沙箱**。统一 Python SDK（`libdsec`）抽象**四种执行基质**：**Function Call**（预热点容器池，零冷启动）/ **Container**（Docker 兼容 + EROFS 按需加载）/ **microVM**（Firecracker，VM 级隔离）/ **fullVM**（QEMU，任意 guest OS）——切换只改一个参数。**分层存储**（3FS 只读 EROFS 层挂 overlay lowerdir，microVM 用 overlaybd 链式快照、毫秒级恢复）+ **密度优化**（去重页缓存、内存回收超卖、缓解 runtime 自旋锁竞争）+ **全序轨迹日志**（客户端快进 / 细粒度溯源 / 确定性重放三重用途，**抢占后重放已完成命令的缓存结果，避免非幂等操作重复执行**）。
   - **与前文对应**：DSec 的「轨迹日志 + 抢占安全恢复」正是本技能第 4/5 节轨迹飞轮的生产级工程标杆。

**效率（对比 V3.2，1M 上下文）**：V4-Pro 只需 **27% 的单 token 推理 FLOPs、10% 的 KV cache**（论文与模型卡口径均为 Pro；V4-Flash 的同口径数字官方未单独披露）。1M 上下文 KV cache 约为 BF16 GQA8 基线的 2%。

**评测与定位（官方口径）**

| 推理档位（V4-Flash） | GPQA Diamond | LiveCodeBench | Apex |
| --- | --- | --- | --- |
| Non-think | 71.2 | 55.2 | 1.0 |
| Think High | 87.4 | 88.4 | 19.1 |
| Think Max | 88.1 | 91.6 | 33.0 |

- **Flash-Max 的推理可媲美 Pro-High**（LiveCodeBench 91.6 vs 89.8）→ 成本受限场景下 Flash-Max 是性价比最优，Pro-Max 只留给「基准差距确实影响下游结果」的任务。
- **Agentic 是最大系统性差距项**（Terminal Bench 2.0 落后最佳闭源约 7 分），但 **MCPAtlas（工具选择与组合）与 SWE Multilingual 基本追平**；官方自评知识能力落后前沿约 3–6 个月。
- 长上下文是强项：MRCR 1M 83.5、CorpusQA 1M 62.0（领先同场闭源对照）。V4-Pro-Max 为当前开源 SOTA，Codeforces 估算 Elo 达 3206 量级。

**V4.1（2026-09-10 发布，最新一代结构）**：V4.1-Flash 为 **552B MoE**，采用全新 **Causal-Encoder-Decoder 非对称结构**（输入激活 8B / 输出激活 16B），原生多模态视觉理解；KV cache 需求再降（HBM 降至上一代 **1/4**、SSD 降至 **1/8**，相对初代 KV cache 累计缩小 **437×**）；在基准上超越 V4-Pro，API 名 `deepseek-flash`，旧 `deepseek-v4-flash` / `-vision-exp` 已下线并临时路由至此。

**GitHub 配套实现（全部 github.com/deepseek-ai/）**

| 仓库 | 定位 |
| --- | --- |
| [DeepSelect](https://github.com/deepseek-ai/DeepSelect) | DSA（DeepSeek Sparse Attention）的 **TopK kernel + sampler** 高性能实现，比 `torch.topk` **快 2–20×**，V3.2 / V4 / V4.1 通用（Lightning Indexer 场景 bf16 topk≤4096；采样场景 fp32 vocab≈128K） |
| [deepseek-recipe](https://github.com/deepseek-ai/deepseek-recipe) | Rust 库 + Python 绑定，把不同格式的 API 请求统一转成 Conversation、编码为 **V4 / V4.1 的 prompt 或 token ID**（含 thinking/工具调用/图像预处理/输出解析，`apply_patch` 自定义工具）。**V4 未随模型发布 Jinja chat template**，本地推理要自己用 / 用这个库编码 |
| [DeepGEMM](https://github.com/deepseek-ai/DeepGEMM) | 干净高效的 GPU BLAS kernel 库（batch-invariant 确定性路径依赖它） |
| [DeepEP](https://github.com/deepseek-ai/DeepEP) | MoE 专家并行通信库 |
| [DeepJIT](https://github.com/deepseek-ai/DeepJIT) | xPU kernel JIT 编译轻量库 |
| [DualPipe](https://github.com/deepseek-ai/DualPipe) | V3/R1 训练的双向流水线并行（计算-通信重叠） |
| [DeepSpec](https://github.com/deepseek-ai/DeepSpec) | 投机解码算法的训练与评测全栈（**DSpark** 草稿模型方案来源） |
| [3FS](https://github.com/deepseek-ai/3FS) | 面向 AI 训练/推理的高性能分布式文件系统（DSec 的存储底座） |
| [ESFT](https://github.com/deepseek-ai/ESFT) | **Expert-Specialized Fine-Tuning**：只调 MoE 中任务相关的专家，小资源定制大模型（EMNLP 2024）——「领域专家培养」的轻量版实现 |
| [LPLB](https://github.com/deepseek-ai/LPLB) | 基于线性规划的 MoE 专家并行负载均衡（早期研究） |
| [Engram](https://github.com/deepseek-ai/Engram) | 条件记忆 / 可扩展查找作为稀疏性新维度（记忆层前沿方向） |

**部署参考**：vLLM ≥ v0.8.0（`vllm serve deepseek-ai/DeepSeek-V4-Pro --max-model-len 131072`）或 SGLang ≥ v0.4.0；DSpark 用 flag 开启。

**给本技能的含义**：V4 的两阶段后训练 = 数据飞轮的「并行专家 + 蒸馏合并」进阶版，且**全面替代了前代的混合 RL**。小规模 Agent 团队可照抄其「领域 SFT → GRPO（领域奖励）→ 多专家 → OPD 合并」范式；难验证任务改用 **rubric + GRM** 少标注；工具调用改用 **XML + 特殊 token** 降解析失败；跨轮保留 ` thinking` 做长周期 Agent；其「**轨迹日志 + 沙箱 + 可抢占恢复 + WAL**」正是飞轮基础设施的工程标杆，与第 2/4/5 节一一对应。

---

## 8. 模型下载（HF Mirror 国内镜像 + 原站）

HF Mirror（https://hf-mirror.com）是 HuggingFace 的国内镜像站，用于**下载模型/数据集并查看模型卡**（模型卡里含训练方法说明）。本技能涉及的权威模型卡：

- Qwen3-8B（Apache-2.0）：https://hf-mirror.com/Qwen/Qwen3-8B
- DeepSeek-R1（MIT）：https://hf-mirror.com/deepseek-ai/DeepSeek-R1
- DeepSeek-V4-Pro / V4-Flash（MIT，1M 上下文）：https://hf-mirror.com/deepseek-ai/DeepSeek-V4-Pro 、https://hf-mirror.com/deepseek-ai/DeepSeek-V4-Flash
- V4 家族其他成员：`DeepSeek-V4-Pro-Base` / `V4-Flash-Base`（FP8 基座）、`V4-Flash-0731`（0731 重后训练版）、`V4-Pro-DSpark` / `V4-Flash-DSpark`（**非新模型**，同 checkpoint 外挂投机解码模块）、`V4-Flash-Vision-Exp`（视觉实验版，已下线）、`V4.1-Flash`（2026-09-10 最新）——全部在 `hf-mirror.com/deepseek-ai`
- 官方模型集合（V4 全家桶）：https://hf-mirror.com/collections/deepseek-ai/deepseek-v4
- 更多 Qwen：`hf-mirror.com/Qwen`；DeepSeek 系列：`hf-mirror.com/deepseek-ai`

> 实测提示：hf-mirror 会检测 IP 归属——**非中国大陆 IP 会被自动跳转到 HuggingFace 原站**；国内网络下镜像直连正常。若在境外环境调试脚本，用 `huggingface.co` 即可。

**下载方法（三种任选）：**

```bash
# 1) 环境变量（最通用，huggingface 工具链自动生效）
export HF_ENDPOINT=https://hf-mirror.com            # Linux
$env:HF_ENDPOINT = "https://hf-mirror.com"          # Windows PowerShell

# 2) huggingface-cli
pip install -U huggingface_hub
huggingface-cli download --resume-download Qwen/Qwen3-8B --local-dir Qwen3-8B
huggingface-cli download --repo-type dataset --resume-download wikitext --local-dir wikitext

# 3) hfd（aria2 高速下载，断线续传）
wget https://hf-mirror.com/hfd/hfd.sh && chmod a+x hfd.sh
./hfd.sh Qwen/Qwen3-8B
```

注意：Gated Repo（如 Llama 系）需先在官网申请许可并带 `--token ***` 下载；镜像站不支持登录。V4-Pro 权重 ~862GB / V4-Flash ~158GB，下载前先确认磁盘。

---

## 9. 评估指标与回归（每次训练后的必测项）

| 维度 | 指标 | 基准 |
| --- | --- | --- |
| 任务成功 | 任务成功率、pass@1、步骤数 | GAIA、AgentBench、WebArena、SWE-bench、ToolBench |
| 工具使用 | 工具调用准确率、参数校验通过率、错误恢复率 | ToolBench、BFCL、MCPAtlas |
| 质量 | 幻觉率、指令跟随（IF-Eval） | MMMU、VideoMME（多模态） |
| 长上下文 | 1M 检索/聚合准确率 | MRCR、CorpusQA、LongBench-V2 |
| 效率成本 | 延迟、Token 成本、GPU 小时 | — |
| 安全 | 安全违规率、越权调用率 | 自建红队集 |

**必须自建 CI 评估集**：每次训练后回归测试（防灾难性遗忘与退化），通过才上线。

**推理档位要单独评估**：同一模型在 Non-think / Think High / Think Max 下的分数差异极大（V4-Flash 的 LiveCodeBench 从 55.2 → 88.4 → 91.6），回归时必须固定 `reasoning_effort` 与思考预算，否则分数不可比。

---

## 10. 落地路线图（先窄后宽）

| 阶段 | 内容 | 里程碑 |
| --- | --- | --- |
| 0–2 周 | 定一个高价值场景 + 指标；选基座（Qwen3-8B/32B 或 DeepSeek-R1-Distill 系列）；搭编排（LangGraph 等）；做 3–5 个工具 | 闭环 demo 跑通，轨迹格式定稿 |
| 2–6 周 | 文本 + 工具 + 记忆闭环上线；收集轨迹；建 CI 评估集；LLaMA-Factory 跑第一轮 SFT/LoRA | 评估集可回归，第一版 SFT 模型上线 |
| 6–12 周 | 轨迹→偏好对→DPO；加入反思数据；用 verl 跑 GRPO（可验证任务）；扩图像/语音 | 工具调用准确率、成功率显著提升 |
| 12 周+ | 多模态统一、自博弈、自动课程、持续学习（在线飞轮）；难验证任务引入 rubric + GRM | 飞轮稳定运转，每轮训练有可量化增益 |

---

## 11. 安全与合规（第一天就要有）

- 行动层必须沙箱化：Docker / E2B / Firecracker，权限最小化；工具按 JSON Schema/OpenAPI 注册并审计。**沙箱要能对齐训练调度**：像 DSec 那样支持抢占与轨迹重放（避免非幂等操作重复执行）。
- 奖励可验证：无法验证的奖励不用于 RL；验证器本身要防投毒。用 GRM 时，rubric 的判定标准也要审计（防止模型学到「讨好评委」）。
- 数据合规：轨迹数据脱敏；用户数据不进入训练集（除非授权）；遵循各模型许可（Qwen=Apache 2.0，DeepSeek-R1=MIT 且明确允许蒸馏再训练；**DeepSeek-V4 / V4.1 权重为 MIT**，但蒸馏出的模型建议保留来源声明）。
- 训练/评测用 R1 系列时遵守其使用建议（temperature 0.6、不加 system prompt 等），否则效果会打折；V4 系列则用 `deepseek-recipe` 按官方模板编码 prompt。

---

## 12. 权威参考来源（已核实，2026-09 现状）

**GitHub（官方 deepseek-ai 组织）**
- DeepSelect（DSA TopK kernel + sampler，比 torch.topk 快 2–20×）：https://github.com/deepseek-ai/DeepSelect
- deepseek-recipe（V4 / V4.1 prompt 与 token 编码，Rust + Python）：https://github.com/deepseek-ai/deepseek-recipe
- DeepGEMM / DeepEP / DeepJIT / DualPipe / 3FS / DeepSpec（训练与推理基础设施栈）
- ESFT（Expert-Specialized Fine-Tuning）、Engram（条件记忆）、LPLB（MoE 负载均衡）
- DeepSeek-R1（训练管线/蒸馏/使用建议）：https://github.com/deepseek-ai/DeepSeek-R1
- DeepSeek-V3（预训练/后训练/蒸馏）：https://github.com/deepseek-ai/DeepSeek-V3
- Qwen3（Qwen2.5 已重定向至此；训练栈与示例）：https://github.com/QwenLM/Qwen3
- Qwen3 官方 LLaMA-Factory 配方：https://github.com/QwenLM/Qwen3/tree/main/examples/llama-factory
- verl（GRPO/Agent RL 复现栈）：https://github.com/verl-project/verl

**论文（训练架构权威来源）**
- DeepSeek-V4 技术报告（CSA/HCA、mHC、Muon、>32T 预训练、Anticipatory Routing + SwiGLU Clamping、两阶段后训练 OPD、MegaMoE、DSec）：https://arxiv.org/abs/2606.19348 （HTML：https://arxiv.org/html/2606.19348v1 ，Submitted 26 Apr 2026）

**GitHub（社区复现）**
- TinyZero（R1-Zero 复现）、GRPO-Zero（GRPO 从零实现）、DAPO（超越 R1-Zero-32B 的 SOTA RL）
- Agent RL：verl-agent、OpenManus-RL、RAGEN、Search-R1、DeepResearcher、GUI-R1、RL-Factory、Easy-R1

**HF / HF Mirror（模型卡 + 下载）**
- HF Mirror 主站：https://hf-mirror.com ；Qwen3-8B：https://hf-mirror.com/Qwen/Qwen3-8B ；DeepSeek-R1：https://hf-mirror.com/deepseek-ai/DeepSeek-R1
- DeepSeek-V4 系列：https://hf-mirror.com/deepseek-ai/DeepSeek-V4-Pro 、https://hf-mirror.com/deepseek-ai/DeepSeek-V4-Flash ，集合页 https://hf-mirror.com/collections/deepseek-ai/deepseek-v4
- 原站等价地址：https://huggingface.co/collections/deepseek-ai/deepseek-v4 （含 Base / DSpark / V4.1-Flash）

---

## 13. Agent 操作要点（速查）

- 用户要「让 Agent 变强/自我进化」→ 按第 2 节闭环规程执行 + 第 5 节飞轮流水线；先跑通「轨迹→SFT→回归」最小环。
- 用户要「微调 Qwen」→ 第 6 节：LLaMA-Factory 配方（LoRA 起步，20GB 显存），数据按 sharegpt 格式。
- 用户要「复现 DeepSeek-R1 / 做 GRPO」→ 第 7 节：verl + TinyZero/DAPO；先可验证任务（数学/代码），奖励用规则验证器。
- 用户问「DeepSeek-V4 怎么训练的 / V4 架构」→ 第 7.4 节：论文 arXiv:2606.19348（CSA+HCA 混合注意力、mHC 流形约束超连接、Muon、32T+ 预训练、MegaMoE、两阶段后训练 = 领域专家 SFT+GRPO → 全词表 reverse KL 在线策略蒸馏 OPD）；配套代码看 DeepSelect / deepseek-recipe / DeepGEMM。
- 用户问「Agent 轨迹/沙箱怎么搭」→ 第 7.4 节 DSec：四档执行基质统一接口（Function Call / Container / microVM / fullVM）+ 3FS 分层存储 + 全序轨迹日志 + 抢占安全恢复。
- 用户问「工具调用老解析失败」→ 用 XML + 专属边界 token 的 DSML 格式（7.4 阶段一），参数标 `string="true/false"`。
- 用户问「长周期 Agent 怎么保持连贯」→ 交织思考（工具轮次保留 ` thinking`，不跨用户消息清空）+ 1M 上下文（7.4）。
- 用户在国内下载模型 → 第 8 节：`HF_ENDPOINT=https://hf-mirror.com`（注意非大陆 IP 会跳原站）。
- 用户问「训练后怎么知道变强没有」→ 第 9 节：CI 评估集回归对比，固定 reasoning 档位，不许只看 loss。
- 用户问「没 GPU 能不能变强」→ 能：L1 行为层（教训/技能/反思）立即可用；L2 数据层持续积累；L3 训练层等硬件到位再跑。

---

## 14. 训练前自检清单（Agent 每次训练前逐条过）

- [ ] 轨迹 ≥ 50 条且含失败样本（没有失败样本 = 数据没营养）
- [ ] 所有轨迹通过第 4.2 节校验器（8 字段 + reward 数值 + modality 合法）
- [ ] 已生成偏好对（chosen ≠ rejected，验证器打分 ≥ 0.6）
- [ ] 已建 CI 评估集（第 9 节），含本次训练目标场景的回归用例
- [ ] 硬件确认：显存满足所选方式（全量 42G / LoRA 20G / QLoRA 11G @7B）
- [ ] 训练栈就绪：LLaMA-Factory 或 verl 已安装，数据已在 dataset_info.json 注册
- [ ] 已备份：模型权重、数据集、评估集三方备份
- [ ] 安全：轨迹已脱敏，用户数据未混入，许可合规（Qwen=Apache2.0 / DS=MIT）

**任何一项不满足 → 不训练，先补齐。**

---

*本文件是活文档。任何 Agent 使用后发现的坑、新验证过的方法、环境差异，都应回写本文件（新增小节或修订），让它对下一个 Agent 更有用。*
*通用化改写：2026-09-11。基于 Agent Data Flywheel 原版（2026-09-10）实测两轮（闭环跑通、DPO 偏好对生成验证通过）。*
