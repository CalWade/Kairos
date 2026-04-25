---
name: memoryops
description: Use MemoryOps to add, search, recall, update, forget, and benchmark long-term enterprise collaboration memories for Feishu/OpenClaw workflows.
---

# MemoryOps Skill

Use this skill when the user asks about prior project decisions, team conventions, recurring workflows, risk reminders, or long-term collaboration memory.

## Common Commands

```bash
memoryops add --text "..."
memoryops recall "query" --evidence
memoryops search "query"
memoryops history <atom_id>
memoryops remind
memoryops eval --smoke
```

## Rules

- Prefer `recall --evidence` when answering questions about project history.
- Do not overwrite old memory destructively; use supersede / invalidation.
- For Feishu sources, preserve source message/doc evidence whenever available.
