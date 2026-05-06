# Kairos 复赛提交模板（草稿）

> 这份文件是按官方模板 `feishu-ai-campus-challenge-submission-template.md` 填好内容的草稿，提交前：
> 1. 在飞书里创建模板副本
> 2. 把下面内容复制进去
> 3. 填个人信息（本人姓名/学校等）
> 4. 嵌入录屏视频（或放在云盘给公开链接）
> 5. **开启【互联网获取链接可阅读权限】**
> 6. 在官方收集表单 https://bytedance.larkoffice.com/share/base/form/shrcnph2V6vmNHIXvw1r5X5tFSO 提交文档链接

---

# 一、个人信息

## 个人参赛

| 姓名 | 项目中负责的工作简述 | 个人基本信息介绍 | 实习信息 |
|---|---|---|---|
| 韦贺文 | 独立完成 Kairos 全部设计与开发：架构设计、MemoryAtom schema、lark-cli 适配器、LLM 抽取管道、Reconcile 状态机、Dashboard 可视化、评测体系、OpenClaw 接入、白皮书与交付物 | 《填：学校 / 专业 / 学历 / 毕业时间》 | 《填：实习地点 / 最快到岗时间 / 可实习时长。如不投递可留空》 |

> ⚠️ 单人参赛只填个人参赛表；小组参赛表留空或删除。

---

# 二、项目结果展示

## 1、总项目结果展示

### 1）Demo 展示（录屏）

📹 **演示视频**：《填：视频链接或附件》

**演示内容**（约 4-6 分钟）：

1. 问题场景：飞书群聊失忆
2. 端到端 demo：飞书群三角色讨论 → Kairos 17 秒内完成记忆沉淀与历史决策卡片推送
3. 创新亮点：结构化记忆、慢归纳、冲突状态机、自证评测
4. 技术深度：LLM prompt、双阶段判断、可观测性
5. 源码仓库：https://github.com/CalWade/Kairos

**现场可运行**（不录屏也可实时演示）：

```bash
git clone https://github.com/CalWade/Kairos.git
cd Kairos && npm install && npm run build
# 配好 .env
npm run dashboard                                  # 终端 1
npm run lark-runtime                               # 终端 2
npm run demo:inject -- --script storage-decision   # 终端 3 注入 6 条 demo 消息
```

### 2）核心部分代码展示

| 模块 | 文件 | 行数 | 职责 |
|---|---|---:|---|
| lark-cli 适配器 | `src/larkCliAdapter.ts` | 396 | 官方 lark-cli 封装、消息标准化、噪声过滤、【角色】前缀解析 |
| lark-runtime worker | `src/larkRuntime/worker.ts` | 246 | 常驻轮询、去重、线程化、induction 并行、activation、webhook 推卡 |
| LLM 决策抽取器 | `src/extractor/llmDecisionExtractor.ts` | 369 | 5 类 kind 结构化抽取、prompt 工程、错误降级 |
| LLM thread linker | `src/candidate/llmThreadLinker.ts` | 144 | 交错群聊会话解缠、字段别名兼容、timeout 兜底 |
| MemoryAtom Store | `src/memory/store.ts` | 365 | 检索、召回、历史追溯、双后端抽象 |
| Reconcile 状态机 | `src/memory/reconcile.ts` | 129 | ADD / DUPLICATE / SUPERSEDE / CONFLICT_PENDING |
| 决策卡片渲染 | `src/memory/decisionCard.ts` | 231 | 飞书 interactive payload + Markdown |
| 飞书激活工作流 | `src/workflow/feishuWorkflow.ts` | 145 | 激活判断、噪声识别、斜杠命令过滤 |
| Dashboard | `src/visualization/dashboard.ts` | 321 | 只读 HTTP 可视化，中文数据流 |
| 评测 runner | `src/eval/runner.ts` | 284 | 8 套 benchmark suite |

**总规模**：~7000 行 TypeScript + ~1900 行 Vitest 测试 + ~1800 行文档（白皮书 / benchmark / 演示脚本 / API runbook）。

### 3）项目亮点介绍

#### 亮点 1：结构化记忆而非文本检索

决策类记忆包含 10+ 个结构化字段（decision / reasons / rejected_options / opposition / conclusion / stage / aliases / negative_keys / evidence_message_ids / confidence）。用户问"为什么不用 PostgreSQL？"能命中，不是因为关键词匹配，而是抽取时就显式记录了"PostgreSQL 被否定原因"这个反向检索 key。**可解释、可审计、可回归测试**。

#### 亮点 2：慢归纳（Slow Induction）架构

消息进 induction queue 异步抽取，不阻塞群聊。LLM 调用容忍 90s timeout，失败走启发式兜底。**单轮 cycle 17 秒处理 6 条消息 + 1 次 LLM 抽取 + 1 张卡片推送，零错误**。

#### 亮点 3：冲突更新而非覆盖

记忆有状态机：`active → superseded → expired`。"周报发给 Alice" 被 "发给 Bob" 覆盖时，旧记忆标记 superseded 但不删除，历史可追溯。Reconcile 输出 4 种动作：ADD / DUPLICATE / SUPERSEDE / CONFLICT_PENDING，全测试覆盖。

#### 亮点 4：自证评测体系

**不让评委相信口头承诺**：

- 103 个 Vitest 测试用例全绿
- 8 套 benchmark suite：decision-extraction / conflict-update / recall / anti-interference / remind / feishu-workflow / thread-linking / llm-decision-extraction
- 赛题 3 类强制测试（抗干扰 / 矛盾更新 / 效能指标）全通过
- 所有数字可一键重跑：`npm run eval:core && npm run dev -- eval --suite thread-linking`

#### 亮点 5：OpenClaw 原生接入

- `openclaw.setup.json` 描述完整安装流程
- `hooks/kairos-feishu-ingress/` 提供 OpenClaw hook pack
- Agent 宿主 `git clone + npm install + npm run build` 即可运行
- 三段文档分工清晰：`OPENCLAW.md`（Agent 宿主视角）/ `QUICKSTART.md`（快速接入）/ `INSTALL.md`（详细部署）

#### 亮点 6：完整可观测性

每轮 runtime / 每条 memory / 每次 activation / 每次 induction job / 每次 throttle 判定都有 JSONL 事件日志。Dashboard 实时聚合为中文数据流可视化：

```
飞书消息进入 → 会话解缠与归纳 → 长期记忆生成 → 历史记忆激活 → 反馈与修正 → 本地评测结果
```

比赛录屏可直接用 "左飞书群 + 右 Dashboard" 的双屏布局。

### 4）AI 亮点介绍

#### A. 使用了哪些高阶 AI 技巧

1. **结构化输出**：LLM 直接产出带 kind 判别的 JSON schema，不依赖后处理 parse
2. **Prompt 工程迭代**：system prompt 从 1507 字符瘦身到 861 字符（-43%），保类型边界 + 字段枚举，LLM eval 4/4 全过
3. **字段名约束显式化**：prompt 里强调 `message_ids` 而非 `messages`，normalizer 兼容别名字段（messages / theme / msg_ids）防 silent degrade
4. **reasoning 模型适配**：`KAIROS_LLM_DISABLE_THINKING=1` 开关，对 Doubao-Thinking 等模型跳过 CoT，延迟从 30-60s 降到 3-5s
5. **双阶段判断**：启发式门槛（salience_score、has_resolution_cue）+ LLM 精判；LLM 只调用 ~10% 的消息量
6. **错误降级三层**：LLM thread link 失败 → heuristic；LLM 抽取失败 → 规则 baseline；整体失败 → markFailed 但不崩 runtime

#### B. 人和 AI 的分工

| 环节 | AI（LLM）| 人（规则代码）|
|---|---|---|
| 噪声过滤 | — | 启发式（msg_type / 内容特征）|
| 会话解缠 | LLM thread linker | heuristic 时间窗 + reply 信号 |
| 结构化抽取 | **核心 LLM 路径** | 规则 baseline fallback |
| 类型判别 | LLM 5 类 kind | 测试用例驱动边界 |
| 冲突识别 | — | Reconcile 规则 + subject / tag 匹配 |
| 召回激活 | — | keywords + aliases + negative_keys |
| 状态转移 | — | 状态机 |
| 频控 | — | ActivationThrottle 冷却 |

**设计哲学**：LLM 擅长的（自然语言理解 / 结构化抽取 / 交错话题解缠）用 LLM；LLM 不擅长的（状态机、时序、规则、一致性检查）用代码。这让系统既强又稳。

#### C. 核心模型选型思路

- **必须 OpenAI-compatible**：避免被 vendor 锁定，`src/llm/config.ts::buildOpenAIChatBody` 统一抽象
- **结构化 JSON 能力**：主路径要求产出严格 JSON，测试 DeepSeek-v4-Flash / Doubao / OpenAI 均可
- **reasoning vs flash**：thread linking / 抽取用 flash 类（低延迟、结构化稳定）；reasoning 类开启 `thinking.disabled`
- **本次默认**：DeepSeek-v4-Flash，实测每次调用 3-5s，单轮 runtime 17s 总延迟

#### D. 引入 AI 后对工作流的改变

| 场景 | 引入前 | 引入后 |
|---|---|---|
| 历史决策复议 | 人工翻群聊、搜索、复制结论（~7 步、~42 字输入） | Kairos 自动推卡片（~2 步、0 字）|
| 会话解缠质量 | 时间窗启发式 F1=0.524 | LLM F1=1.000 |
| 决策抽取深度 | 单句摘要 | 10+ 字段结构化（含被否方案、反对意见、反向 key）|
| 冲突感知 | 人工发现 | 自动 DIRECT_CONFLICT 标记 |

### 5）其他信息补充

- **开源**：MIT License，代码 https://github.com/CalWade/Kairos
- **真实飞书链路已跑通**：2026-05-07 凌晨实测 6 条消息 → 1 张卡片，17 秒端到端
- **完全兼容 OpenClaw 生态**：见 `OPENCLAW.md` 与 `openclaw.setup.json`

---

# 三、其他信息（自由发挥区）

## 技术架构图（完整版见白皮书）

```
┌─────────────────────────────────────────────────────────────┐
│  飞书群聊 ← → lark-cli ← → Kairos Runtime ← → 飞书 Webhook  │
└─────────────────────────────────────────────────────────────┘
                           ↓                ↑
            NormalizedMessage → 会话解缠 → 候选窗口
                           ↓
                    Induction Queue（异步）
                           ↓
              LLM 结构化抽取（decision/risk/conv/workflow/none）
                           ↓
                 Reconcile（ADD/DUP/SUPERSEDE/CONFLICT）
                           ↓
                   MemoryAtom Store（JSONL/SQLite）
                           ↓
                 Activation（历史决策激活 + 频控）
                           ↓
                  Decision Card → webhook 推回群
                           ↑
                  Dashboard 旁路观察 / 可重跑评测
```

## 关键数字一览

| 维度 | 数字 |
|---|---:|
| 本地测试通过率 | 103/103 |
| 真实群单轮延迟 | 17 秒 |
| 抗干扰 F1 | 1.0 |
| Thread linking F1（LLM vs heuristic）| 1.000 vs 0.524 |
| 操作步数节省 | -71.4% |
| 额外输入字符节省 | -100% |
| 代码规模 | 7000 行 src + 1900 行 test |
| 性能提升（优化前 vs 后）| 93s → 17s（5.5x）|

## 文档列表

| 文档 | 用途 |
|---|---|
| `docs/whitepaper.md` | 记忆定义与架构白皮书 |
| `docs/benchmark-report.md` | 自证评测报告 |
| `docs/demo-script.md` | 复赛演示脚本 |
| `docs/demo-rehearsal.md` | 录屏分镜头讲稿 |
| `docs/lark-cli-runbook.md` | lark-cli 授权 / 群接入 / 排障 |
| `QUICKSTART.md` | OpenClaw Agent 接入一条命令 |
| `OPENCLAW.md` | OpenClaw 宿主视角部署指南 |
| `INSTALL.md` | 详细安装部署 |
| `README.md` | 项目总览 |

## 联系方式

- GitHub：https://github.com/CalWade/Kairos
- Email：《填》
