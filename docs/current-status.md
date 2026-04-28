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
- LLMDecisionExtractor 可选路径：`extract-decision --llm --fallback`，读取本地 `.env`，支持 OpenAI-compatible 接口；另有显式 `eval --suite llm-decision-extraction`，不进入 core eval
- Decision Card 文本版：`decision-card <memory_id>`，可把决策、理由、被否方案和证据渲染为 Markdown
- OpenClaw 飞书入口 Hook：`hooks/kairos-feishu-ingress` 监听 `message:received` 并调用 `feishu-workflow`；默认只记录 workflow 输出，可通过环境变量开启 webhook 发送
- 飞书 Decision Card payload 预览：`decision-card <memory_id> --feishu-json`，只生成 interactive card JSON；另支持 `--send-feishu-webhook` 通过飞书机器人 webhook 真实发送，必须显式提供 webhook
- Recall 确定性格式化回答：将最相关记忆整理为历史决策/风险/流程回答，并提示可运行的 decision-card 命令
- DecisionCandidate → MemoryAtom 写入
- 核心评测 runner：decision-extraction / conflict-update / recall / anti-interference / remind
- Vitest 单元测试

## 真实边界

- Decision Extractor 默认仍是规则 baseline；LLMDecisionExtractor 已有可选路径和小型显式评测，当前观测 3/4 通过且存在超时样本，不能按生产效果宣传。
- Candidate Segment Pipeline 仍是输入清洗 baseline，不应作为核心智能卖点。
- 飞书接收入口确定采用 OpenClaw hook/外挂 Agent 模式：OpenClaw 负责接收 `message:received`，Kairos 负责工作流判断；Kairos CLI 不自建飞书事件服务器，也尚未内置 OAuth。
- `recall` 目前是检索 + 确定性格式化回答，不是完整自然语言问答生成。
- 遗忘提醒 `remind` 已有本地 MVP：支持按 `review_at <= --now` 查询到期记忆，并支持 `ack` / `snooze`；尚未实现飞书推送和周期性自动投递。
- 历史决策卡片已有 CLI 文本版、飞书 payload 生成和 webhook 发送路径；尚未实现 Kairos CLI 内置飞书 OAuth。

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

1. LLMDecisionExtractor：当前已有可选路径和小型显式评测，下一步需要扩大真实样本、优化超时/重试和失败回退策略。
2. Remind / Forgetting：当前已有本地到期查询、ack、snooze；仍需飞书推送和周期性自动投递。
3. Decision Card：CLI 文本版、飞书 payload 和 webhook 发送路径已完成；下一步是接入 OAuth 或 OpenClaw 演示流。
4. Benchmark 扩充：当前 core eval 为 26 个最小用例，仍需扩到可展示数据集。
5. 飞书端演示闭环：至少完成导出文档 → CLI → recall 的稳定 demo。
