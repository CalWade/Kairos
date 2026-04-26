---
name: memoryops
description: 当用户需要查询、沉淀、更新或评测飞书 / OpenClaw 企业协作长期记忆时使用。适用于项目决策、团队约定、风险提醒、个人偏好、CLI 工作流等场景。
---

# MemoryOps Skill

Kairos 是面向飞书与 OpenClaw 的企业级长程协作记忆引擎。

## 何时使用

当用户需要处理以下问题时使用：

- 查询之前的项目决策；
- 追溯某个结论的来源；
- 判断团队规则是否已经更新；
- 记录长期有效的协作约定；
- 处理新旧记忆冲突；
- 设置风险事项复习提醒；
- 对长期记忆系统做 Benchmark。

## 常用命令

```bash
memoryops add --text "..."
memoryops recall "query" --evidence
memoryops search "query"
memoryops history <atom_id>
memoryops remind
memoryops eval --smoke
```

## 使用原则

- 查询历史决策时，优先使用 `recall --evidence`。
- 不要破坏性覆盖旧记忆，应使用 supersede / invalidation。
- 飞书来源必须尽量保留 message_id、doc_token 或原文片段。
- 当新旧记忆冲突且无法确定时，标记为 conflict_pending，而不是擅自覆盖。
```
