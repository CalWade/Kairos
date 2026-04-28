# Kairos Benchmark Report

> 当前为 MVP 阶段评测报告，记录真实已实现的最小评测，不夸大效果。

## 1. 当前评测命令

```bash
npm run dev -- eval --core
```

当前包含 4 个 suite：

| Suite | 目标 | Case 数 |
|---|---|---:|
| decision-extraction | 验证结构化决策 / 规则 / 风险 / 工作流 / none 抽取 | 12 |
| conflict-update | 验证新旧规则冲突覆盖，包含 direct / temporal / risk policy | 4 |
| recall | 验证反向问题能否召回决策理由、风险和流程 | 5 |
| anti-interference | 验证多条相似记忆下不召回错误对象 | 3 |

## 2. 当前结果

截至 2026-04-28：

```text
decision-extraction: 12 / 12 passed
conflict-update: 4 / 4 passed
recall: 5 / 5 passed
anti-interference: 3 / 3 passed
```

这说明核心链路已经覆盖到 24 个最小评测用例，但仍然是小规模、人工构造数据集，不能说明系统已经具备真实生产效果。

## 3. 已覆盖能力

### 3.1 决策抽取

示例：

```text
最终决定 MVP 阶段使用 SQLite，同时保留 JSONL Event Log。
PostgreSQL 对复赛 demo 来说部署成本太高。
```

期望：

- kind = decision；
- topic = local_storage_selection；
- decision 包含 SQLite；
- rejected_options 包含 PostgreSQL；
- reasons 包含部署成本。

### 3.2 矛盾更新

示例：

```text
旧：以后周报每周五发给 Alice。
新：不对，周报以后发给 Bob。
```

期望：

- 当前值为 Bob；
- Alice 旧记忆 status = superseded；
- 历史版本仍可查询。

### 3.3 反向召回

示例问题：

```text
为什么不用 PostgreSQL？
```

期望召回：

```text
MVP 阶段使用 SQLite + JSONL；PostgreSQL 部署成本较高，可能影响复赛 demo 运行。
```

## 4. 当前不足

- Case 数仍然偏少，距离可展示 Benchmark 还有差距；
- 评测数据仍是人工构造；
- Decision Extractor 是规则 baseline；
- 没有覆盖飞书端主动决策卡片；
- 没有真实用户耗时对比数据。

## 5. 下一步评测计划

复赛前应扩充：

1. 继续扩充抗干扰测试：真实飞书导出噪声 + 隐藏关键决策；
2. 扩展决策更新测试：条件生效、跨阶段迁移、多人反对意见；
3. 风险提醒测试：review_at 到期提醒；
4. 效能指标：手动翻聊天 vs Kairos recall 的步数和时间对比。
