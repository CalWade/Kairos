# Kairos

![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-3178C6?logo=typescript&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Status](https://img.shields.io/badge/status-WIP-orange)
![Feishu](https://img.shields.io/badge/Feishu%20%2F%20Lark-Memory-blue)
![OpenClaw](https://img.shields.io/badge/OpenClaw-Agent--Friendly-purple)

> 面向飞书与 OpenClaw 的企业级长程协作记忆引擎。

> **Kairos** 是项目对外名称，寓意“关键时刻 / 恰当时机”。它强调企业记忆不只是被动存储，而是在正确的时间召回正确的上下文。`memoryops` 仅作为 Kairos 的 CLI 命令名保留。

Kairos 是一个针对飞书 AI 校园挑战赛 OpenClaw Memory 赛道设计的企业协作记忆系统。它的目标不是做一个简单的聊天记录搜索工具，也不是泛泛的飞书 AI 助手，而是把飞书协作流中的碎片化信息沉淀为可管理、可检索、可更新、可遗忘、可评测的企业长期记忆。

## 背景问题

AI Agent 在企业协作中经常“失忆”：

- 忘记项目之前为什么选择方案 B，而不是方案 A；
- 忘记团队已经约定过的周报、审批、发布流程；
- 忘记某个风险事项几天前已经被提醒过；
- 无法区分旧规则和新规则，容易把过期信息当成当前事实；
- 只能搜索原始聊天记录，不能理解“这条信息是否还有效”。

单纯增加上下文长度或把聊天记录全部向量化，并不能解决这些问题。Kairos 试图把“记忆”设计成一种有生命周期、有证据链、有状态、有冲突处理能力、有评测指标的工程资产。

## 一句话定位

> Kairos 将飞书群聊、文档、任务、日程和 CLI 操作中的协作信息，转化为结构化的 MemoryAtom，并通过冲突更新、遗忘提醒和 Benchmark 证明长期记忆的实际价值。

## Quick Start（当前 WIP）

当前阶段已经可以运行 CLI 骨架、MemoryAtom Schema 校验和 smoke benchmark 数据集加载。

```bash
git clone git@github.com:CalWade/Kairos.git
cd Kairos
npm install

# 查看 CLI 命令
npm run dev -- --help

# 校验 MemoryAtom 示例是否符合 Zod Schema
npm run dev -- schema:check

# 加载 smoke benchmark 数据集
npm run dev -- eval --smoke
npm run dev -- eval --core
# 单独运行飞书工作流触发评测
npm run dev -- eval --suite feishu-workflow
# 显式运行 LLM 抽取评测（会调用外部模型，不进入 core eval）
npm run dev -- eval --suite llm-decision-extraction

# 一键本地端到端演示：抽取 → 召回 → 决策卡片 → 矛盾更新 → 到期提醒 → 评测
npm run demo:e2e
# 模拟 OpenClaw 飞书消息入口 → Kairos 工作流判断
npm run demo:feishu-workflow

# 当前 add / recall 仍是 dry-run mock
npm run dev -- add --text "最终决定使用 PostgreSQL，不使用 MongoDB" --project kairos --type decision --subject database_selection
npm run dev -- search "PostgreSQL" --project kairos
npm run dev -- recall "我们为什么不用 MongoDB？" --project kairos --evidence

# 摄取文件并触发 mock 冲突覆盖
npm run dev -- ingest --file examples/weekly-report-conflict.md --project kairos
npm run dev -- search "周报" --project kairos --include-history

# 验证飞书会话导出文档标准化
npm run dev -- normalize-chat-export --file /tmp/feishu-chat-export.md --doc-token <doc_token>
npm run dev -- segment-chat-export --file /tmp/feishu-chat-export.md --doc-token <doc_token>
npm run dev -- extract-decision --text "最终决定 MVP 阶段使用 SQLite，PostgreSQL 部署成本太高" --project kairos --write
# 可选：使用主办方提供的 OpenAI-compatible LLM 做结构化抽取，失败时回退 baseline
npm run dev -- extract-decision --llm --fallback --text "最终决定 MVP 阶段使用 SQLite，PostgreSQL 部署成本太高" --project kairos --write
npm run dev -- recall "为什么不用 PostgreSQL？" --project kairos --evidence
# 根据记忆 ID 输出历史决策卡片文本
npm run dev -- decision-card <memory_id>
# 预览飞书 interactive card payload（只生成 JSON，不发送）
npm run dev -- decision-card <memory_id> --feishu-json
# 真实发送到飞书机器人 webhook（外部动作，需显式提供 webhook）
npm run dev -- decision-card <memory_id> --send-feishu-webhook --feishu-webhook <webhook_url>
```

> 注意：当前 `add / search / recall / list / history` 已接入本地 SQLite Store 与 JSONL Event Log；`recall` 已有确定性格式化回答，但不是完整生成式 QA；LLMDecisionExtractor 已有 OpenAI-compatible 可选路径，并提供显式 LLM eval；但仍需更多真实数据评测，不应把它宣传成生产级效果。

## 核心设计

```mermaid
flowchart TD
    A[飞书群聊 / 文档 / 任务 / 日程] --> B[Ingestion 数据读入]
    A2[CLI 操作 / OpenClaw 对话] --> B
    B --> C[Stage 1: Extract Candidate Facts]
    C --> D[Retrieve Similar Memories]
    D --> E[Stage 2: Reconcile Memory Events]
    E --> F{Action 决策}
    F -->|ADD| G[新增 MemoryAtom]
    F -->|UPDATE| H[更新 MemoryAtom]
    F -->|SUPERSEDE| I[非损失效: 标记旧记忆失效]
    F -->|CONFLICT| J[conflict_pending 等待确认]
    F -->|DUPLICATE / NONE| K[丢弃或忽略]
    G --> L[(Memory Store)]
    H --> L
    I --> L
    J --> L
    L --> M[Recall / Search]
    L --> N[Remind / Forgetting]
    L --> O[Benchmark / Report]
    M --> P[OpenClaw / CLI / 飞书端回答]
    N --> P
    O --> Q[自证价值]
```

## 关键能力

### 1. MemoryAtom 结构化记忆

Kairos 不直接存一段聊天文本，而是抽取结构化记忆单元：

- 记忆类型：决策、约定、偏好、工作流、风险、人员角色、截止日期、CLI 命令、知识；
- 作用域：个人、团队、组织、项目；
- 证据链：来源消息、文档、片段、时间；
- 多时间戳：系统创建时间、观察时间、现实生效时间、失效时间、系统过期时间；
- 状态：active、superseded、expired、deleted、conflict_pending；
- 冲突关系：supersedes / superseded_by；
- 遗忘策略：ebbinghaus、linear、step、none。

### 2. 两阶段记忆写入

借鉴 Mem0 的思路，Kairos 将 LLM 写入过程拆成两步：

```text
Extract：只从飞书消息 / 文档中抽取候选事实
Reconcile：结合相似旧记忆，判断 ADD / UPDATE / SUPERSEDE / DUPLICATE / CONFLICT / NONE
```

LLM 不直接改数据库，只输出结构化决策；最终写入由程序执行，降低不可控性。

### 3. 非损失效冲突更新

借鉴 Graphiti 的双时态思想，MemoryOps 在新旧记忆冲突时不硬删除旧记忆，而是通过 `invalid_at`、`expired_at`、`superseded_by` 保留历史。

例如：

```text
旧记忆：周报发给 Alice
新记忆：不对，周报以后发给 Bob
```

系统应返回当前有效规则：Bob，同时保留 Alice 作为历史版本。

### 4. 遗忘与复习提醒

Kairos 支持可配置的遗忘策略，并通过 fast-forward 模拟时间进行评测。

例如高风险事项：

```text
生产环境 API Key 已更新，新 key 只允许服务端使用，不允许前端直连。
```

系统可以在指定时间触发复习提醒，降低团队知识断层风险。

### 5. Benchmark 自证价值

Kairos 不只做 demo，还会设计评测集证明系统有效：

- 抗干扰测试：大量无关聊天中召回关键决策；
- 矛盾更新测试：新旧规则冲突时返回当前有效记忆；
- 遗忘提醒测试：通过 fast-forward 验证提醒逻辑；
- 效能指标测试：比较使用前后的查询步数、耗时和重复沟通成本。

## 计划中的 CLI

说明：`memoryops` 是 Kairos 的 CLI 命令名，保留自项目早期。

```bash
# 用户友好命令
memoryops add --text "最终决定使用 PostgreSQL，不使用 MongoDB"
memoryops search "数据库方案"
memoryops recall "我们为什么不用 MongoDB？" --evidence
memoryops history <atom_id>
memoryops remind --project kairos --now 2026-05-30T00:00:00.000Z
memoryops remind snooze <memory_id> --until 2026-06-01T00:00:00.000Z
memoryops remind ack <memory_id>
memoryops eval --smoke
memoryops schema:check

# Agent-friendly 命令
memoryops atom.add
memoryops atom.search
memoryops atom.update
memoryops atom.forget
memoryops sync.feishu
```

## Demo 场景

### Demo 1：历史决策召回

输入一段飞书项目群讨论，系统自动提取“数据库选择 PostgreSQL，而不是 MongoDB”的决策记忆。之后用户询问“我们为什么不用 MongoDB？”，系统返回带证据链的历史决策。

### Demo 2：矛盾更新

系统先记住“周报发给 Alice”，随后收到“周报以后改发给 Bob”。再次查询时，系统返回 Bob，并把 Alice 标记为历史失效版本。

### Demo 3：团队遗忘预警

系统识别高风险事项，例如 API Key 更新、安全边界、上线窗口等，并根据遗忘策略在合适时间提醒团队复习。

## 目录结构

```text
memoryops/
  src/
    cli.ts
  docs/
    whitepaper.md
    benchmark-report.md
    demo-script.md
  skills/
    memoryops/
      SKILL.md
  examples/
  eval/
    datasets/
  runs/
  data/
```

## 当前进度

- [x] Candidate Segment Pipeline 第一步：Message Normalization 标准消息结构
- [x] Candidate Segment Pipeline 第二步：Conversation Segmentation 对话切分
- [x] Candidate Segment Pipeline 第三步：Salience Scoring + Adjacent Segment Merge
- [x] Candidate Segment Pipeline 第四步：Context Windowing + Denoising
- [x] Decision Extractor baseline：结构化抽取决策/规则/风险/工作流
- [x] LLMDecisionExtractor 可选路径：读取本地 `.env`，支持 OpenAI-compatible chat completions 与 baseline fallback
- [x] DecisionCandidate 写入 MemoryAtom 并支持反向召回
- [x] Decision Card 文本版：`memoryops decision-card <memory_id>`
- [x] 飞书 Decision Card payload 预览：`memoryops decision-card <memory_id> --feishu-json`
- [x] Recall 确定性格式化回答：把决策、理由、被否方案和卡片命令组织为可读答案
- [x] 核心评测 runner：决策抽取 / 矛盾更新 / 召回 / 抗干扰 / 到期提醒

- [x] 项目方向确定
- [x] GitHub 仓库初始化
- [x] README 初稿
- [x] 白皮书目录初稿
- [x] OpenClaw Skill 草案
- [x] CLI skeleton
- [x] MemoryAtom schema 实现
- [x] SQLite Store + JSONL Event Log
- [x] mock Extract / Reconcile 骨架
- [x] 飞书会话导出文档标准化 POC
- [x] 冲突更新
- [x] Remind 本地 MVP：按 review_at 查询到期风险记忆，支持 ack / snooze
- [ ] 飞书端提醒推送与提醒处理状态
- [x] 飞书机器人 webhook Decision Card 推送路径：`decision-card <id> --send-feishu-webhook`（需显式 webhook）
- [x] smoke benchmark 数据集草案
- [ ] Demo 录屏

## 设计参考

Kairos 会借鉴但不复刻以下系统：

- Mem0：两阶段记忆写入与 action/event 决策；
- Graphiti：多时间戳、双时态、非损失效更新；
- Letta：分层记忆与工具化 memory 操作；
- Zep：混合检索与长期记忆评测思路；
- LoCoMo / LongMemEval：长期交互记忆 Benchmark 思路。

最终目标是把这些成熟范式收敛到飞书企业协作场景，重点解决项目决策、团队约定、风险提醒和长期上下文遗忘问题。


## OpenClaw 飞书入口集成

Kairos 不自建飞书事件服务器；推荐通过 OpenClaw hook 接收飞书消息，再调用 Kairos 引擎：

```bash
openclaw hooks enable kairos-feishu-ingress
openclaw hooks check
```

Hook 位置：`hooks/kairos-feishu-ingress/`，监听 `message:received`。默认只把 workflow 输出写入 `runs/kairos-feishu-ingress.jsonl`；如需真实发送卡片，设置：

```bash
KAIROS_HOOK_SEND_FEISHU=1
KAIROS_FEISHU_WEBHOOK_URL=...
```

这一路线是“OpenClaw 负责飞书接收，Kairos 负责记忆判断和卡片生成/发送”，避免自建公网回调和 OAuth。


## 分发注意

`npm pack` 会自动运行 `npm run build`，并将 `dist/` 与 `hooks/` 一起打进发布包。通过 `openclaw plugins install ./memoryops-0.1.0.tgz` 安装时，用户不需要手动 build。开发机用 `openclaw plugins install -l .` 链接源码时，源码改动后需要重新运行 `npm run build`。


## 存储后端

默认存储后端为 JSONL portable store，适合 OpenClaw hook pack 免编译分发。开发环境如需使用 SQLite，可设置：

```bash
KAIROS_STORE=sqlite
```

SQLite 模式依赖 `better-sqlite3` native binding，不作为插件包默认运行模式。
