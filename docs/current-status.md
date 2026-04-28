# Kairos 当前项目状态

更新时间：2026-04-28

## 已完成且可运行

- CLI：`memoryops`
- MemoryAtom v0.2 类型与 Zod Schema
- SQLite Memory Store
- JSONL Event Log
- `add / search / recall / list / history`
- `supersede` 非损失效覆盖
- 飞书会话导出解析：`normalize-chat-export`
- 候选片段 baseline：`segment-chat-export`
- 结构化决策抽取 baseline：`extract-decision`
- LLMDecisionExtractor 可选路径：`extract-decision --llm --fallback`，读取本地 `.env`，支持 OpenAI-compatible 接口
- Decision Card 文本版：`decision-card <memory_id>`，可把决策、理由、被否方案和证据渲染为 Markdown
- DecisionCandidate → MemoryAtom 写入
- 核心评测 runner：decision-extraction / conflict-update / recall / anti-interference / remind
- Vitest 单元测试

## 真实边界

- Decision Extractor 默认仍是规则 baseline；LLMDecisionExtractor 已有可选路径，但缺少大规模真实样本评测，不能按生产效果宣传。
- Candidate Segment Pipeline 仍是输入清洗 baseline，不应作为核心智能卖点。
- 飞书接入目前依赖 OpenClaw 工具拉取/导出文档，Kairos CLI 尚未内置飞书 API OAuth 调用。
- `recall` 目前是检索式回答，不是完整自然语言问答生成。
- 遗忘提醒 `remind` 已有本地 MVP：支持按 `review_at <= --now` 查询到期记忆；尚未实现飞书推送、处理状态和重复提醒控制。
- 历史决策卡片已有 CLI 文本版；尚未实现飞书交互式卡片推送。

## 当前主线

Kairos 当前聚焦：项目决策记忆引擎。

```text
飞书会话导出/项目讨论文本
→ 候选窗口
→ 决策/规则/风险结构化抽取
→ MemoryAtom
→ 检索召回
→ 矛盾更新
→ Benchmark 自证
```

## 当前最重要缺口

1. LLMDecisionExtractor：当前只有可选路径，下一步需要扩大真实样本评测、稳定 JSON schema 和失败回退策略。
2. Remind / Forgetting：当前只有本地到期查询 MVP，仍需处理状态、重复提醒控制和飞书推送。
3. Decision Card：CLI 文本版已完成，下一步是飞书卡片 payload 与推送。
4. Benchmark 扩充：当前 core eval 为 26 个最小用例，仍需扩到可展示数据集。
5. 飞书端演示闭环：至少完成导出文档 → CLI → recall 的稳定 demo。
