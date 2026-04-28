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
- DecisionCandidate → MemoryAtom 写入
- 核心评测 runner：decision-extraction / conflict-update / recall / anti-interference
- Vitest 单元测试

## 真实边界

- Decision Extractor 仍是规则 baseline，不是 LLM 版本。
- Candidate Segment Pipeline 仍是输入清洗 baseline，不应作为核心智能卖点。
- 飞书接入目前依赖 OpenClaw 工具拉取/导出文档，Kairos CLI 尚未内置飞书 API OAuth 调用。
- `recall` 目前是检索式回答，不是完整自然语言问答生成。
- 遗忘提醒 `remind` 尚未真正实现。
- 历史决策卡片尚未实现飞书卡片推送，只能先用 CLI 文本模拟。

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

1. LLMDecisionExtractor：替换规则 baseline。
2. Remind / Forgetting：风险记忆复习提醒。
3. Decision Card：历史决策卡片文本/飞书卡片。
4. Benchmark 扩充：当前 core eval 为 24 个最小用例，仍需扩到可展示数据集。
5. 飞书端演示闭环：至少完成导出文档 → CLI → recall 的稳定 demo。
