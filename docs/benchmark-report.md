# Kairos Benchmark Report

> 当前为 MVP 阶段评测报告，记录真实已实现的最小评测，不夸大效果。

## 1. 当前评测命令

```bash
npm run dev -- eval --core
# 单独运行飞书工作流触发评测
npm run dev -- eval --suite feishu-workflow
```

当前包含 6 个 suite：

| Suite | 目标 | Case 数 |
|---|---|---:|
| decision-extraction | 验证结构化决策 / 规则 / 风险 / 工作流 / none 抽取 | 12 |
| conflict-update | 验证新旧规则冲突覆盖，包含 direct / temporal / risk policy | 4 |
| recall | 验证反向问题能否召回决策理由、风险和流程 | 5 |
| anti-interference | 验证多条相似记忆下不召回错误对象 | 3 |
| remind | 验证风险记忆 review_at 到期提醒 | 2 |
| feishu-workflow | 验证飞书消息触发/误触发控制/斜杠命令忽略 | 4 |

## 2. 当前结果

截至 2026-04-28：

```text
decision-extraction: 12 / 12 passed
conflict-update: 4 / 4 passed
recall: 5 / 5 passed
anti-interference: 3 / 3 passed
remind: 2 / 2 passed
feishu-workflow: 4 / 4 passed
```

这说明核心链路已经覆盖到 30 个最小评测用例，但仍然是小规模、人工构造数据集，不能说明系统已经具备真实生产效果。

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
3. 扩展风险提醒测试：多级 review_at、已处理提醒、飞书推送；
4. 效能指标：手动翻聊天 vs Kairos recall 的步数和时间对比。


## 6. LLM 抽取显式评测

LLMDecisionExtractor 不进入 `eval --core`，需要显式运行：

```bash
npm run dev -- eval --suite llm-decision-extraction
```

当前数据集：`eval/datasets/llm-decision-extraction.jsonl`，包含自然语言决策、风险、流程和未定问题样本。

截至 2026-04-28 的一次主办方模型观测：

```text
llm-decision-extraction: 3 / 4 passed
PASS llm_decision_storage_natural_001 decision
FAIL llm_risk_api_key_001 timeout / AbortError
PASS llm_workflow_export_001 workflow
PASS llm_none_unresolved_001 none
```

解释：失败样本是风险抽取请求超时，不是 schema 校验错误；CLI 的 `extract-decision --llm --fallback` 可回退到规则 baseline。该结果说明 LLM 路径已可用，但稳定性和超时控制仍需改进，不能作为生产效果宣传。
