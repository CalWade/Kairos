# MemoryOps / OpenMemory Feishu

> 面向飞书与 OpenClaw 的企业级长程协作记忆引擎。

MemoryOps 是一个针对飞书 AI 校园挑战赛 OpenClaw Memory 赛道设计的企业协作记忆系统。它的目标不是做一个简单的聊天记录搜索工具，也不是泛泛的飞书 AI 助手，而是把飞书协作流中的碎片化信息沉淀为可管理、可检索、可更新、可遗忘、可评测的企业长期记忆。

## 背景问题

AI Agent 在企业协作中经常“失忆”：

- 忘记项目之前为什么选择方案 B，而不是方案 A；
- 忘记团队已经约定过的周报、审批、发布流程；
- 忘记某个风险事项几天前已经被提醒过；
- 无法区分旧规则和新规则，容易把过期信息当成当前事实；
- 只能搜索原始聊天记录，不能理解“这条信息是否还有效”。

单纯增加上下文长度或把聊天记录全部向量化，并不能解决这些问题。MemoryOps 试图把“记忆”设计成一种有生命周期、有证据链、有状态、有冲突处理能力、有评测指标的工程资产。

## 一句话定位

> MemoryOps 将飞书群聊、文档、任务、日程和 CLI 操作中的协作信息，转化为结构化的 MemoryAtom，并通过冲突更新、遗忘提醒和 Benchmark 证明长期记忆的实际价值。

## 核心设计

```text
飞书 / CLI / OpenClaw 输入
        ↓
Stage 1: Extract Candidate Facts
        ↓
Retrieve Similar Memories
        ↓
Stage 2: Reconcile Memory Events
        ↓
MemoryAtom Store + Event Log
        ↓
Recall / Search / Remind / Benchmark
        ↓
OpenClaw / CLI / 飞书端交互
```

## 关键能力

### 1. MemoryAtom 结构化记忆

MemoryOps 不直接存一段聊天文本，而是抽取结构化记忆单元：

- 记忆类型：决策、约定、偏好、工作流、风险、人员角色、截止日期、CLI 命令、知识；
- 作用域：个人、团队、组织、项目；
- 证据链：来源消息、文档、片段、时间；
- 多时间戳：系统创建时间、观察时间、现实生效时间、失效时间、系统过期时间；
- 状态：active、superseded、expired、deleted、conflict_pending；
- 冲突关系：supersedes / superseded_by；
- 遗忘策略：ebbinghaus、linear、step、none。

### 2. 两阶段记忆写入

借鉴 Mem0 的思路，MemoryOps 将 LLM 写入过程拆成两步：

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

MemoryOps 支持可配置的遗忘策略，并通过 fast-forward 模拟时间进行评测。

例如高风险事项：

```text
生产环境 API Key 已更新，新 key 只允许服务端使用，不允许前端直连。
```

系统可以在指定时间触发复习提醒，降低团队知识断层风险。

### 5. Benchmark 自证价值

MemoryOps 不只做 demo，还会设计评测集证明系统有效：

- 抗干扰测试：大量无关聊天中召回关键决策；
- 矛盾更新测试：新旧规则冲突时返回当前有效记忆；
- 遗忘提醒测试：通过 fast-forward 验证提醒逻辑；
- 效能指标测试：比较使用前后的查询步数、耗时和重复沟通成本。

## 计划中的 CLI

```bash
# 用户友好命令
memoryops add --text "最终决定使用 PostgreSQL，不使用 MongoDB"
memoryops search "数据库方案"
memoryops recall "我们为什么不用 MongoDB？" --evidence
memoryops history <atom_id>
memoryops remind --now 2026-05-30
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

- [x] 项目方向确定
- [x] GitHub 仓库初始化
- [x] README 初稿
- [x] 白皮书目录初稿
- [x] OpenClaw Skill 草案
- [x] CLI skeleton
- [x] MemoryAtom schema 实现
- [ ] SQLite Store + JSONL Event Log
- [ ] 两阶段 Extract / Reconcile
- [ ] 飞书文档 / 群聊读入 POC
- [ ] 冲突更新
- [ ] fast-forward 遗忘提醒
- [x] smoke benchmark 数据集草案
- [ ] Demo 录屏

## 设计参考

MemoryOps 会借鉴但不复刻以下系统：

- Mem0：两阶段记忆写入与 action/event 决策；
- Graphiti：多时间戳、双时态、非损失效更新；
- Letta：分层记忆与工具化 memory 操作；
- Zep：混合检索与长期记忆评测思路；
- LoCoMo / LongMemEval：长期交互记忆 Benchmark 思路。

最终目标是把这些成熟范式收敛到飞书企业协作场景，重点解决项目决策、团队约定、风险提醒和长期上下文遗忘问题。
