# PPXANS-Harness 用户实测报告

> 测试人：以真实用户视角操作（非单元测试）　|　测试时间：2026-09-17　|　被测版本：**v2.7.0**
> 测试环境：Windows / Node v22.22.2 / 无本地 LM Studio；云端 key：DEEPSEEK_API_KEY（**实测无效**）、ZHIPU_API_KEY（可用）
> 说明 1：**第一轮为纯观察，未改动任何代码。** 所有结论附可复现证据；测试数据全部落在隔离目录，已清理，未污染项目 `data/`。
> 说明 2：**第二轮已完成问题修复**（P1-1 / P1-2 / P2-1 / P2-2 / P2-3 全部处理），详见 **第七章 修复记录**。
> 　　　DeepSeek key 无效为**发布前主动删除**所致（非缺陷），按要求不作处理。

---

## 一、结论总览

| 能力 | 实测结果 |
|---|---|
| 内核启动 | ✅ 46 ms 完成，43 工具注册 |
| 本地意图（零 LLM） | ✅ 8/8 命中，0–211 ms |
| 真实 LLM 对话 + 工具循环 | ✅ 工具真执行，答案准确，多轮上下文正确 |
| **多 provider 回退** | ✅ **实测救场成功**（一个 key 失效，会话未中断） |
| 记忆跨进程持久化 | ✅ 写入 → 退出 → 新进程 → 召回成功 |
| Web 服务 + 静态资源 | ✅ 首页 14,989 B，静态资源 4/4 与本地文件字节一致 |
| MCP 服务端 | ✅ 握手 / tools / resources / prompts / call 全通，**65 项工具** |
| 安全边界 | ✅ **7/7 全拦**（含云元数据 SSRF） |
| 自愈 | ✅ 已修：`Healer` 接受真实 `dataDir`（原只认 `<root>/data`，见 P1-2） |
| 记忆质量 | ✅ 已修：疑问/指令句不再入库（原用户提问被当长期事实，见 P1-1） |

**一句话**：核心链路比预期健壮——多 provider 回退、安全拦截、MCP 三块表现尤其扎实；发现的 2 个 P1 + 3 个 P2 **已全部修复并补回归测试**。

---

## 二、实测通过的部分（含证据）

### 2.1 启动与本地意图

```
[启动耗时] 46 ms
[工具数] 43
[生命周期] born

> 你好            [2ms]   在的兄弟, 说。
> 现在几点         [16ms]  [工具] 2026/9/17 14:23:07
> 谢谢            [0ms]   客气啥, 应该的。
> 再见            [1ms]   再见兄弟, 有事随时喊我。
> 记住: 我在做…    [211ms] [工具] {"ok":true,"id":"f_8fff6d83-…"}
> 记得 皮皮虾       [20ms]  我记得: - 我在做一个叫皮皮虾的 Agent 项目
> 列出 .          [4ms]   [D] .git [D] .github …
> 读文件 package.json [4ms] { "name": "ppxans-harness", …
```
本地意图层确实做到"零 LLM 成本、毫秒级响应"。`记住 → 记得` 闭环正确。

### 2.2 真实 LLM 对话与工具循环

```
> 帮我数一下 config/ppx.json 里 providers 数组配了几个条目，只回答数字。
  [5.7s | 模型 glm-5v-turbo | 工具 read_file(ok) 17ms]
  6                                    ← 答案正确

> 刚才我让你数的是什么文件？
  [2.0s | 模型 glm-5v-turbo | 工具 无]
  config/ppx.json                      ← 上下文连续正确
```
工具真的被调用（`read_file` 17 ms，非幻觉），答案与文件实际内容一致（6 个 provider）。

### 2.3 多 provider 回退 —— 本轮最有价值的一次实测

配置顺序为 `lmstudio → deepseek → zhipu`。逐个健康探测的实际结果：

```
YOUR_LOCAL_MODEL_NAME   health = false     ← 本地服务未运行
deepseek-chat           health = false     ← key 失效
glm-5v-turbo            health = true
```

直连验证 DeepSeek 确实不可用（**不是项目问题，是 key 本身过期**）：
```
HTTP 401  {"error":{"message":"Authentication Fails, Your api key: ****6715 is invalid"}}
```

**结果：会话完全没被打断，自动落到智谱 glm-5v-turbo 并正常完成。** 这正是多 provider 回退存在的意义——它在一个真实故障场景下救了场，不是纸面功能。

### 2.4 记忆跨进程持久化

```
进程A: 记住: 我的止损线是 5%        → L1 记忆 3 → 5 条
       agent.shutdown()
进程B: (全新进程) L1 记忆: 5 条
       > 记得 止损线    → 我记得: - 我的止损线是 5%
       > 记得 简体中文   → 我记得: - 我偏好简体中文回复
       > 记得 皮皮虾     → 我记得: - 我在做一个叫皮皮虾的 Agent 项目
```
落盘核查：`memory/facts.json` 存在、`memory/lifecycle.json` 存在、`sessions/user-test.jsonl` 存在。**"重启不丢"属实。**

### 2.5 Web 服务与 MCP 端点

```
/health  → {"status":"ok","agent":"皮皮虾","version":"2.7.0","web":"/","mcp":"/mcp"}
/        → HTTP 200, 14,989 B, text/html
无 token 访问 /api/settings → HTTP 401                ← 鉴权生效
静态资源 app.css / app.js / favicon.svg / vendor/marked.min.js
         → 4/4 HTTP 200，且与 public/ 下源文件字节数完全一致
```
MCP（`POST /mcp`，Bearer 鉴权）：
```
initialize     → protocolVersion 2024-11-05, serverInfo 皮皮虾/2.7.0  ✓
tools/list     → 65 项（43 内置 + 22 个 ppx.* 管理工具）              ✓
resources/list → memory://facts、memory://scenes …                    ✓
prompts/list   → humanize / plan / debug / verify / write_article      ✓
tools/call get_time     → 2026/9/17 14:26:30                          ✓
tools/call memory_add   → {"ok":true,"id":"f_b9db0c9b-…"}             ✓
```
**"任何 MCP 客户端开箱即用"这句不是宣传——实测握手、发现、调用三段全通。**

### 2.6 安全边界 —— 7/7 全拦

| # | 攻击 | 结果 |
|---|---|---|
| 1 | `rm -r""f / --no-preserve-root`（引号混淆） | 🛡 拦截：命中高危黑名单 |
| 2 | `r""m -rf /`（引号混淆） | 🛡 拦截：硬黑名单「rm -rf / 类删除根目录」 |
| 3 | `:(){ :\|:& };:`（fork bomb） | 🛡 拦截：硬黑名单「fork bomb 进程炸弹」 |
| 4 | `http_request` → `http://127.0.0.1:8899/health` | 🛡 拦截：SSRF 拒绝内网地址 |
| 5 | `http_request` → `http://169.254.169.254/latest/meta-data/` | 🛡 拦截：SSRF 拒绝内网地址 |
| 6 | `memory_clear_layer {hard:true}` | 🛡 拦截：免疫闸门「危险工具未授信」 |
| 7 | `run_command "node -v"`（正常只读） | ✅ 放行，返回 v22.22.2 |

两个引号混淆变体都被**正确识别**（说明反混淆检测真的在工作）；**云元数据地址 169.254.169.254 被拦截**是个加分项，很多 Agent 项目会漏。拦截提示还带了"不要重试或改写绕过"的行为引导，写得清楚。

### 2.7 自愈

注入 3 类破坏（`facts.json` 语法损坏 + `integrity.json` 标记异常退出 + 残留 `.tmp`）后启动：

```
healer 报的修复项: created dir: memory/daily | created dir: experience
                  | created dir: sessions | created dir: logs
                  | facts.json corrupt -> backed up to facts.json.corrupt-1789626430182, reset
残留 .tmp 是否清掉: 已清理 ✓
损坏文件备份      : facts.json.corrupt-1789626430182
```
**备份而非直接丢弃**这个处理是对的。但见下面 P1-2。

---

## 三、实测发现的问题

> **第二轮状态（2026-09-17）**：以下 P1-1 / P1-2 / P2-1 / P2-2 / P2-3 **五项已全部修复**，
> 每项均新增回归测试（`test/user-test-fixes.test.js`，14 例）。各项标题下标注了修复落点，详见第七章。
> DeepSeek 401 属发布前主动删除 key，**不作为缺陷处理**。

### 🔴 P1-1　用户提问被当作长期事实入库（记忆污染）

> ✅ **已修复**　`src/memory/fact-store.js` `addMemory()`：把形同虚设的 `length <= 8` 前置条件拆掉，
> 改为四道与长度无关的句式判据（问号/助词收尾、疑问词起手、句中强制疑问词、祈使句起手）。

**现象**：一轮正常使用后，L1 记忆里混进了用户自己的提问。

实测 5 条记忆中有 **2 条是提问**（污染率 40%）：
```
source=agent-self   | 我在做一个叫皮皮虾的 Agent 项目      ← 正常
source=conversation | 帮我数一下 config/ppx.json 里 providers 数组配了几个条目，只回答数字。   ← 提问
source=conversation | 刚才我让你数的是什么文件？              ← 提问
source=agent-self   | 我的止损线是 5%                       ← 正常
source=agent-self   | 我偏好简体中文回复                    ← 正常
```
附带证据：老板既有数据 `data/memory/facts.json` 里唯一一条就是 `讲个笑话` —— 同样是指令被当成事实。说明这不是偶发。

**根因**（`src/memory/fact-store.js:557-558`）：
```js
// 疑问/指令短句 (如 "现在几点", "文件在哪") → 临时查询, 不作长期事实
if (clean.length <= 8 && /[?？]|几点|多少|什么|怎么|为什么|在哪|帮我|请|查一下/.test(clean)) return null;
```
过滤意图是对的，但被 **`length <= 8` 这个前置条件废掉了** —— 现实中提问几乎都超过 8 个字，全部穿过过滤网。两条实测噪音分别是 45 字和 15 字。

**影响**：
- 长期使用会持续污染 L1，挤占 1000 条上限（超限时按分数裁剪最弱项，但噪音会先占位再被裁）
- 污染的记忆会被注入 system prompt，可能干扰模型判断
- L3 画像取 `USER_SOURCES` 包含 `conversation`，**提问会进用户画像**

**建议方向**：疑问句判定与长度解耦。安全且低风险的两条规则：
1. 以 `？` / `?` 结尾 → 判为提问，不论长度
2. 以祈使前缀开头（`帮我` / `请` / `麻烦` / `你能` / `数一下` / `查一下` / `看看` / `列出`）→ 判为指令

这两条不会误伤陈述型事实（`我的止损线是 5%` 无问号、无祈使前缀）。

---

### 🔴 P1-2　自愈只认 `<root>/data`，不认实际 `dataDir`

> ✅ **已修复**　`src/selfheal/healer.js` 构造函数新增可选 `dataDir` 参数（默认 `rootDir/data`，15 处旧调用点零改动）；
> `src/plugin/builtin.js` 的 `healerPlugin` 改为传 `ctx.consume("dataDir")` 真实数据目录。

**现象**：当 `dataDir ≠ <root>/data` 时，自愈修的是**另一个目录**。

实测（`root=proj`，`dataDir=custom-data`）：
```
root/data   : 建目录 ✓ | facts.json 备份+重置 ✓ | .tmp 清理 ✓ | integrity.json 跟踪 ✓
custom-data : 只是"碰巧"变得可解析（被 readJson 静默兜底后重写），
              无备份、无崩溃检测、无残留清理
```

**根因**：
- `src/selfheal/healer.js:13` —— `this.dataDir = path.join(rootDir, "data")`（**硬编码**）
- `src/plugin/builtin.js:58` —— `new Healer(ctx.consume("root"))`（**传的是 root，不是 dataDir**）

**影响（按严重度排序）**：
1. **npm 全局安装场景最严重**：`PPXAgent._defaultDataDir()` 检测到路径含 `node_modules` 时会把数据外置到 `~/.ppx`。此时自愈会去修 `<包目录>/data`（node_modules 内部），而**真实的 `~/.ppx` 完全没有崩溃检测、没有损坏备份**。
2. 本地开发设了 `PPX_DATA_DIR` 的用户：同上，自愈动作落在错误目录。
3. 崩溃恢复失效：`integrity.json` 写在 `<root>/data`，与实际数据目录无关，等于跨目录误判。

**建议方向**：`Healer` 构造改为接收 `dataDir`（而非 root），`healerPlugin` 传 `ctx.consume("dataDir")`。改动面很小，但要同步检查 `healer.js` 内所有 `path.join(this.dataDir, …)` 与备份目录命名。

---

### 🟠 P2-1　本地意图回复泄漏内部标记与原始 JSON

> ✅ **已修复**　`src/agent/index.js` 新增 `_humanToolResult()`：错误前缀 → "没办成: …"，
> JSON → 抽载荷字段，数组 → 逐项罗列；`[工具]` 标记彻底去掉，时间改说"现在是 …"，记忆改说"好，记下了: …"。

用户说人话，它回机器话：

| 用户输入 | 实际回复 | 问题 |
|---|---|---|
| `记住: 我在做一个叫皮皮虾的 Agent 项目` | `[工具] {"ok":true,"id":"f_8fff6d83-0c6e-4030-830a-beb63713bda7"}` | 直接吐原始 JSON + 内部 ID |
| `现在几点` | `[工具] 2026/9/17 14:23:07` | `[工具]` 是内部标记，不该给用户看 |
| `列出 .` | `[工具] [D] .git [D] .github …` | 同上 |

**根因**：`src/agent/index.js` 的 `_localIntent()` 里直接 `return \`[工具] ${await this.tools.call(...)}\``，把工具返回值原样透传；`memory_add` 返回的是 JSON 字符串。

**影响**：对用户而言这是最"掉价"的一处——明明是最快路径（0–4 ms），体验却像调试输出。对一个主打"双击即用的桌面产品"，这类细节的权重很高。

**建议方向**：为本地意图的各分支加人类可读包装，例如 `记住:` → `好，记下了。`；`现在几点` → 直接给时间（去掉 `[工具]`）；工具原始输出保留在 `[工具]` 前缀场景下（有用户确实想看原样），但 `memory_add` 这类应做语义化。

---

### 🟠 P2-2　静默回退，用户全程无感知

> ✅ **已修复**　`_llmWithFallback()` 记录降级事实并广播 `llm/fallback` 总线事件；
> `chat()` 在回复末尾追加可见提示「> ⚠ 主模型 X 不可用: <原因归类>。本轮回答已自动切换到 Y」。
> 关键约束：**回退返回值保持模型原文**（透明语义不变，chaos 测试断言未动），
> 提示在写入会话历史/记忆**之后**才拼接，下一轮上下文不被污染。

实测中 DeepSeek key 失效（401），系统静默切到智谱完成对话。日志里有 `warn`，但**对话界面没有任何提示**。

**影响**：用户会以为自己正在用 DeepSeek（配置里的第二顺位），实际在用智谱——模型能力、计费、数据流向都不同。对在意模型选择的用户这是个信任问题。

**建议方向**：回退发生时，在回复末尾附一行轻提示（如 `（DeepSeek 不可用，已切换至 glm-5v-turbo）`），或在 Web UI 顶部状态区显示当前实际模型 + 异常 provider 角标。

---

### 🟠 P2-3　占位符模型名被选为主模型，且校验器看不见它

> ✅ **已修复**　新增 `src/config/placeholder.js` 作为占位符判定**唯一真相源**
> （原三份正则分散在 `llm/router.js` / `config/index.js` / `config/providers.js`，
> 且都漏掉 `YOUR_*_MODEL` 形态）；`isUsableProvider` 现在同时检查 `model` 与 `base_url`；
> `_warnMissingCloudApi` 改为复用同一判定，并明确列出"看着配了其实是占位符"的条目。

**现象**：`resolveLLM()` 选出的主模型是 **`YOUR_LOCAL_MODEL_NAME`** —— 配置模板里的占位符，指向未运行的本地端点。

```
主模型  : http / YOUR_LOCAL_MODEL_NAME
可用列表: YOUR_LOCAL_MODEL_NAME | deepseek-chat | glm-5v-turbo[vision]
```

**三处叠加导致新用户会踩**：
1. `config/ppx.json` 里 `lmstudio.model = "YOUR_LOCAL_MODEL_NAME"` 未被替换；
2. `validateConfig()` 的占位符检测正则是 `/REPLACE_WITH_|your.?endpoint|your[_-]?api[_-]?key/i`，**测不出** `YOUR_LOCAL_MODEL_NAME`（实测 `false`），因此 **警告数为 0**；
3. `_warnMissingCloudApi()` 只要看到 `127.0.0.1` 就认定"有本地模型"并提前 return，所以连"未检测到任何可用模型"的友好提示也不会打印。

**实际后果**：新用户首启 → 主模型指向不存在的模型名 + 死端点 → **只能靠回退链救场**（本轮正是如此）。功能上"能用"，但用户完全不知道自己在用什么，配置错误被掩盖。

**建议方向**：
- 占位符正则补 `YOUR_[A-Z_]*MODEL|your[_-]?model|MODEL_NAME` 一类模式
- `_warnMissingCloudApi` 的 `hasLocal` 判定从"配置里有 127.0.0.1"升级为"**本地端点实际可达**"
- `config/ppx.json.example` 里把 `YOUR_LOCAL_MODEL_NAME` 换成注释说明或更明确的 `<<< 替换为你的本地模型名 >>>`

---

### 🟡 P3　观察项（非缺陷，供参考）

1. **生命周期计数含本地意图轮次**：`lifecycle` 在 11 次对话后进入 `mature`，但其中多数是问候/查时间这类零 LLM 轮次。阶段推进略"虚"，若用于能力评估会有水分。
2. **README 工具数口径可统一**：内置 43，MCP 暴露 65（含 22 个 `ppx.*` 管理工具）。建议 README 明确"43 内置 + 22 管理 = MCP 共 65 项"，比单一数字更准确也更有说服力。

---

## 四、未发现问题的部分（原本担心的点，实测正常）

| 担心 | 实测 |
|---|---|
| 首页白屏 | ❌ 未发生，14,989 B 正常渲染 |
| 静态资源 404 | ❌ 未发生，4/4 且字节一致 |
| 无 token 被绕过 | ❌ 未发生，401 正确 |
| 工具循环幻觉编造 | ❌ 未发生，`read_file` 真执行且答案正确 |
| 危险命令可混淆绕过 | ❌ 未发生，两种引号混淆均被拦 |
| SSRF 云元数据 | ❌ 未发生，169.254.169.254 被拦 |
| 记忆重启丢失 | ❌ 未发生，跨进程召回正确 |
| 崩溃后数据损坏不可恢复 | ⚠️ 部分：`<root>/data` 备份恢复 ✓，自定义 dataDir 无备份（见 P1-2） |

---

## 五、给老板的优先级建议

| 优先级 | 项 | 理由 | 改动量 |
|---|---|---|---|
| **P1** | 记忆污染（P1-1） | 直接影响记忆与画像质量，用越久越脏 | 小（一个判定条件） |
| **P1** | 自愈目录归属（P1-2） | 影响 npm 发布形态的崩溃恢复，且属"静默失效" | 小（改一处传参 + 构造） |
| **P2** | 本地意图回复包装（P2-1） | 用户感知最直接，最"掉价" | 小 |
| **P2** | 回退可见性（P2-2） | 信任问题 | 小 |
| **P2** | 占位符校验（P2-3） | 新用户首启体验，掩盖配置错误 | 小 |
| P3 | 生命周期计数口径 / README 工具数 | 文档与观测准确性 | 极小 |

**共性**：5 项里 4 项都是"改动很小但影响用户感知/数据质量"的类型，没有需要动架构的。核心架构（回退链、安全闸门、MCP、记忆分层）在本轮实测中表现扎实。

---

## 六、测试方法与可复现性

- 全部测试在隔离目录进行（`tmp/user-test/`、独立 `root`），测试后已清理；项目 `data/` 经核查未被污染（仍为 1 条既有记忆、`sessions/` 仍只有 `live-test.jsonl`）。
- `integrity.json` 已确认为 `clean:true`，不会导致下次启动误报崩溃。
- 本轮**未修改任何代码**；上表所有结论均附带原始输出。
- 复现路径：本地意图 → 直接 `agent.chat()`；LLM 对话 → 需有效云端 key；MCP → `bin/ppx-web.js` 起服务后 `POST /mcp`（Bearer token 见 `<dataDir>/http-token`）。

---

## 七、修复记录（第二轮，2026-09-17）

> 原则：**只修实证问题，不动架构**；每项配回归测试，锁死不被回退。
> 新增测试文件：`test/user-test-fixes.test.js`（14 例，按 P1-1 / P1-2 / P2-1 / P2-2 / P2-3 分组）。
> 全量回归：**768 tests / 764 pass / 0 fail / 4 skip**（754 → 768，+14 项回归守卫）。

### 7.1 改动清单

| 项 | 文件 | 改动 |
|---|---|---|
| **P1-1** | `src/memory/fact-store.js` | `addMemory()` 拆掉 `length <= 8` 前置条件，改为四道句式判据（问号/助词收尾 · 疑问词起手 · 句中强制疑问词 · 祈使句起手） |
| **P1-2** | `src/selfheal/healer.js` · `src/plugin/builtin.js` | Healer 新增可选 `dataDir` 参数（默认 `rootDir/data`，兼容 15 处旧调用点）；`healerPlugin` 传 `ctx.consume("dataDir")` |
| **P2-1** | `src/agent/index.js` | 新增 `_humanToolResult()` 做"外向化"；去掉 `[工具]` 标记与原始 JSON 泄漏 |
| **P2-2** | `src/agent/index.js` | `_llmWithFallback()` 记录降级事实 + 广播 `llm/fallback`；`chat()` 追加可见提示；新增 `_shortReason()` 归因 / `_fallbackNotice()` 生成 / `_stripFallbackNotice()` 剥离 |
| **P2-3** | **新增** `src/config/placeholder.js` · `src/llm/router.js` · `src/config/index.js` · `src/config/providers.js` · `src/agent/index.js` | 占位符判定收敛为唯一真相源；`isUsableProvider` 同时校验 `model` 与 `base_url`；`_warnMissingCloudApi` 复用同一口径 |

### 7.2 三个关键设计约束

1. **向后兼容优先**：`new Healer(root)` 在项目里有 15 处调用（`builtin.js` / `run.js` / 6 处测试 / 7 处 bench 脚本）。
   修 P1-2 时没有改签名必填性，而是给 `dataDir` 一个等于旧行为的默认值，只让装配层传真实目录 —— 15 处旧代码零改动。
2. **不破坏既有断言**：`test/chaos.test.js` 锁死了 `_llmWithFallback` 成功时**必须返回模型原文**。
   因此 P2-2 的降级提示不能改返回值，而是走"旁路留痕 + 上层拼接"：`_llmWithFallback` 只记录，
   `chat()` 在 `persist`（写历史/记忆）**之后**才拼提示，保证下一轮上下文干净。
3. **正则收敛而非再补一条**：P2-3 的根因不是"漏了一种写法"，而是**同一个语义有三份正则且各自漂移**。
   只补 `YOUR_*_MODEL` 能治当下，下次加模板还会漏。所以抽出 `config/placeholder.js` 作为唯一真相源，三处共用。

### 7.3 修复效果（前后对比）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `addMemory("今天几号了现在")` | 入库（长度 9 > 8，逃逸） | `null`（拒绝） |
| `addMemory("兄弟喜欢做A股量化交易")` | 入库 | 入库（陈述句不被误杀） |
| `PPX_DATA_DIR=<自定义>` 启动 | 自愈体检 `root/data`，真实目录永不体检 | 体检真实 `dataDir`，`root/data` 不再被创建 |
| `_localIntent("现在几点")` | `[工具] 2026/9/17 13:49:58` | `现在是 2026/9/17 13:49:58` |
| `_localIntent("记住: X")` | `[工具] {"ok":true,"id":"f_xxx"}` | `好, 记下了: X` |
| DeepSeek 401 后 | 静默切智谱，用户无感 | 回复末尾 `> ⚠ 主模型 deepseek-chat 不可用: 鉴权失败 (key 无效或已过期)。本轮回答已自动切换到 glm-5v-turbo。` |
| `resolveLLM()`（模板默认配置） | 选中 `lmstudio` / `YOUR_LOCAL_MODEL_NAME` | `null` + 启动明确指出"仍是模板占位符" |

### 7.4 未处理项（有意为之）

| 项 | 原因 |
|---|---|
| DeepSeek 401 | **key 为发布前主动删除**，非缺陷；重新配置即恢复，不作代码处理 |
| P3-1 生命周期计数含本地意图轮次 | 观察项，改动涉及语义定义，留待后续评估 |
| P3-2 README 工具数口径 | 已在上一轮文档修订中处理（"43 内置工具"口径统一） |

---

*报告结束。第一至六章为第一轮纯实测记录（未含推测性结论）；第七章为第二轮修复记录。*
