# MemoryOps 白皮书

## 1. Define：什么是企业协作记忆

企业协作记忆不是完整聊天记录，也不是简单向量库。它是对未来协作有复用价值、能降低重复沟通成本、能保留证据链、能处理冲突更新、能被评测验证的长期上下文资产。

## 2. Build：系统架构

```text
Feishu / CLI / OpenClaw Inputs
        ↓
Extract Candidate Facts
        ↓
Retrieve Similar Memories
        ↓
Reconcile Memory Events
        ↓
MemoryAtom Store
        ↓
Recall / Search / Remind / Eval
```

## 3. Prove：评测设计

MemoryOps 将通过以下 benchmark 自证价值：

1. 抗干扰测试：大量无关聊天中召回关键项目决策。
2. 矛盾更新测试：新旧规则冲突时正确保留历史并返回当前有效记忆。
3. 遗忘提醒测试：通过 fast-forward 模拟时间验证 review / decay 策略。
4. 效能指标测试：比较使用前后的查询步数、耗时和重复沟通成本。
