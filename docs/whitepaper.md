# MemoryOps 白皮书

> 面向飞书与 OpenClaw 的企业级长程协作记忆引擎

## 1. 背景

在日常办公与研发协作中，AI Agent 往往是“失忆”的。它可以在单轮任务中表现得很聪明，但面对跨天、跨文档、跨群聊、跨任务的协作上下文时，常常无法回答：

- 上次我们为什么做出这个技术决策？
- 当前规则是最新的吗？
- 旧结论是否已经被覆盖？
- 哪些风险事项需要在几天后提醒？
- 哪些团队约定值得长期保留？

企业环境下的记忆，不应该只是更长的上下文窗口，也不应该只是向量数据库里的聊天记录。它应该是一套可管理的协作基础设施。

## 2. Define：什么是企业协作记忆

Kairos 将企业协作记忆定义为：

> 对未来协作有复用价值，能够被追溯、检索、更新、遗忘和评测的长期上下文资产。

初步分类如下：

| 类型 | 含义 | 示例 |
|---|---|---|
| 决策记忆 | 项目中已经形成结论的方案、取舍和理由 | 最终选择 PostgreSQL，不选 MongoDB |
| 约定记忆 | 团队协作中的固定规则 | 周报每周五 18:00 前发到项目群 |
| 偏好记忆 | 用户或团队的隐式习惯 | 用户偏好表格视图 |
| 工作流记忆 | 可复用的操作流程 | 发布流程：测试 → 构建 → 部署 → 通知 |
| 风险记忆 | 需要长期提醒的高风险事项 | API Key 更新，不允许前端直连 |
| 人员角色记忆 | 成员职责、模块归属、联系人 | 张三负责前端 |
| 截止日期记忆 | DDL、里程碑、阶段交付时间 | 复赛材料 5 月 7 日提交 |
| CLI 命令记忆 | 高频命令、项目路径、常用参数 | 项目部署命令 |
| 知识记忆 | 文档、规范、背景知识中的长期有效信息 | 接口鉴权采用 OAuth2 |

## 3. Build：系统架构

```text
飞书群聊 / 文档 / 任务 / 日程 / CLI 操作
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

## 4. MemoryAtom 数据模型

MemoryAtom 是 Kairos 的核心记忆单元。它不仅包含文本内容，还包含证据链、状态、时间、冲突关系和遗忘策略。

关键字段包括：

- `type`：记忆类型；
- `scope`：personal / team / org；
- `project`：项目上下文；
- `layer`：behavior / rule / knowledge；
- `formation`：explicit / implicit / derived；
- `source`：来源渠道和证据片段；
- `created_at`：系统创建时间；
- `observed_at`：系统看到来源材料的时间；
- `valid_at`：事实现实中开始生效的时间；
- `invalid_at`：事实现实中失效的时间；
- `expired_at`：系统标记过期的时间；
- `status`：active / superseded / expired / deleted / conflict_pending；
- `supersedes` / `superseded_by`：冲突覆盖关系；
- `decay_policy` / `review_at`：遗忘与复习策略。

## 5. 记忆写入：两阶段 Pipeline

Kairos 不让 LLM 一次性完成抽取、查重、冲突判断和写库，而是拆成两阶段：

### Stage 1：Extract Candidate Facts

只从输入中抽取候选事实，不判断是否更新已有记忆。

### Stage 2：Reconcile Memory Events

把候选事实和相似旧记忆一起交给 LLM 判断：

- ADD：新增记忆；
- UPDATE：更新已有记忆；
- SUPERSEDE：覆盖旧记忆；
- DUPLICATE：重复，丢弃；
- CONFLICT：冲突但无法自动判定，等待人工确认；
- NONE：不值得记忆。

最终写库动作由程序执行，避免 LLM 直接修改数据库。

## 6. 冲突更新：非损失效

Kairos 采用非损失效更新。新旧信息冲突时，系统不删除旧记忆，而是设置失效时间并保留历史。

例如：

```text
旧记忆：周报发给 Alice
新记忆：周报以后发给 Bob
```

系统会：

1. 将 Alice 版本标记为 `superseded`；
2. 设置旧记忆的 `invalid_at`；
3. 新增 Bob 版本并标记为 `active`；
4. 查询时默认返回当前有效版本；
5. 用户需要时可查看历史版本。

## 7. 遗忘机制

遗忘不是简单删除，而是基于记忆类型、重要性、访问次数和作用域进行降权、复习或归档。

MVP 阶段采用可配置策略：

- `ebbinghaus`：适合个人偏好；
- `linear`：线性衰减；
- `step`：适合团队规则和风险提醒；
- `none`：组织级知识不轻易遗忘。

由于比赛周期较短，真实时间尺度的长期遗忘效果将作为 future work；MVP 通过 fast-forward 模拟时间验证提醒逻辑。

## 8. Prove：Benchmark 设计

Kairos 将通过以下 Benchmark 自证价值：

### 8.1 抗干扰测试

在大量无关聊天中插入一条关键项目决策，测试系统是否能准确召回并引用证据。

### 8.2 矛盾更新测试

构造新旧规则冲突场景，测试系统是否返回当前有效记忆，同时保留历史版本。

### 8.3 遗忘提醒测试

使用 fast-forward 模拟时间，测试不同 decay policy 下的 review / remind 逻辑。

### 8.4 效能指标测试

对比使用前后：

- 查询步数；
- 查询耗时；
- 输入字符数；
- 重复沟通次数。

## 9. 设计参考与取舍

| 功能 | 外部参考方向 | 具体设计 | Kairos 取舍 |
|---|---|---|---|
| Schema | Graphiti | 多时间戳 / 双时态 | 增加 scope / project / layer / formation，适配企业协作 |
| 抽取 | Mem0 | 两阶段抽取 + action 决策 | 适配飞书消息、文档、CLI 事件源 |
| 存储分层 | Letta | Core / Recall / Archival | 映射为 Hot / Warm / Cold 与 Personal / Team / Org |
| 冲突检测 | Graphiti | 语义检索 + LLM 对比 + 非损失效 | 扩展为企业协作冲突关系 |
| 遗忘 | Letta + 认知科学 | 摘要 / 驱逐 / 衰减 | 多策略 decay_policy + fast-forward 评测 |
| 检索 | Zep | 混合检索 + rerank | 加入 scope、project、status、importance 加权 |
| API | Mem0 / Letta | 简洁 API + 工具化 memory 操作 | 同时提供用户 CLI 与 OpenClaw agent-friendly 命令 |
| 评测 | 长期记忆评测研究 | 召回、更新、时间推理等评测维度 | 自建飞书协作场景 benchmark，不把外部摘要当作算法证明 |

## 10. 当前边界

MVP 不追求：

- 完整图数据库；
- 复杂 Web UI；
- 生产级实时飞书事件订阅；
- 完整复现公开 Benchmark；
- 真实长期遗忘曲线实验。

这些将作为后续迭代方向。
