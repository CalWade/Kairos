# MemoryOps

> 企业级长程协作记忆引擎，面向飞书与 OpenClaw 场景。

MemoryOps is a long-term collaborative memory engine for Feishu/Lark and OpenClaw. It turns fragmented collaboration streams — messages, docs, tasks, meetings, and CLI operations — into structured, traceable, updatable, and benchmarkable enterprise memories.

## Problem

AI agents in enterprise collaboration are often "stateless": they forget previous project decisions, team conventions, delivery deadlines, risk notices, and user preferences. Simply increasing context length or storing raw chat logs is not enough.

MemoryOps treats memory as a managed lifecycle:

```text
Feishu / CLI / OpenClaw Inputs
        ↓
Extract Candidate Facts
        ↓
Retrieve Similar Memories
        ↓
Reconcile: ADD / UPDATE / SUPERSEDE / DUPLICATE / CONFLICT / NONE
        ↓
MemoryAtom Store + Event Log
        ↓
Recall / Search / Remind / Benchmark
```

## Key Ideas

- **MemoryAtom**: structured memory unit with type, scope, project, evidence, confidence, status, timestamps, conflict links, and decay policy.
- **Two-stage extraction**: inspired by Mem0, separate fact extraction from memory reconciliation.
- **Bi-temporal update**: inspired by Graphiti, preserve old memories with `invalid_at` / `expired_at` instead of destructive deletion.
- **Agent-friendly CLI**: designed to be callable by OpenClaw and other AI agents.
- **Benchmark-first**: anti-interference, conflict update, fast-forward forgetting, and efficiency evaluation.

## Planned CLI

```bash
memoryops add --text "..."
memoryops search "query"
memoryops recall "query" --evidence
memoryops history <atom_id>
memoryops remind --now 2026-05-30
memoryops eval --smoke

# Agent-friendly commands
memoryops atom.add
memoryops atom.search
memoryops atom.update
memoryops atom.forget
memoryops sync.feishu
```

## Documents

- `docs/whitepaper.md` — Memory definition and architecture whitepaper.
- `docs/benchmark-report.md` — Benchmark design and results.
- `docs/demo-script.md` — Demo script for the competition.

## Roadmap

- [ ] MemoryAtom schema
- [ ] CLI skeleton
- [ ] SQLite store + JSONL event log
- [ ] Two-stage extractor/reconciler
- [ ] Feishu document/chat ingestion POC
- [ ] OpenClaw skill
- [ ] Conflict resolver
- [ ] Fast-forward forgetting engine
- [ ] Smoke benchmark
- [ ] Demo recording
