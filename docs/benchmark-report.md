# MemoryOps Benchmark Report

> 当前为评测报告草稿，后续会随着 `memoryops eval` 实现逐步补充真实结果。

## 1. 评测目标

Kairos 的 Benchmark 不是为了追求抽象指标，而是回答三个问题：

1. 系统是否能在大量无关信息中找回关键记忆？
2. 系统是否能正确处理新旧记忆冲突？
3. 系统是否能量化减少重复查询和沟通成本？

## 2. 评测集设计

### 2.1 抗干扰测试

构造方式：

- 插入一条关键项目决策；
- 添加 20 / 50 / 100 条无关聊天；
- 提问与关键决策相关的问题。

指标：

- Recall@1；
- Recall@3；
- Answer Accuracy；
- Evidence Citation Rate。

### 2.2 矛盾更新测试

示例：

```text
旧记忆：周报发给 Alice
新记忆：周报改发给 Bob
查询：周报发给谁？
期望：Bob，同时保留 Alice 历史版本
```

指标：

- Conflict Detection Accuracy；
- Current Value Accuracy；
- Old Memory Superseded Rate；
- History Preservation Rate。

### 2.3 遗忘提醒测试

使用 fast-forward 模拟时间，验证 review_at 与 decay_policy 是否按预期触发。

### 2.4 效能指标测试

比较使用前后：

- 操作步数；
- 查询耗时；
- 输入字符数；
- 重复沟通次数。

## 3. 当前状态

- [ ] smoke cases
- [ ] full benchmark cases
- [ ] eval runner
- [ ] report generator
