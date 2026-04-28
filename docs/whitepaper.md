# Kairos 白皮书

> 面向飞书与 OpenClaw 的企业级项目决策记忆引擎

## 1. 背景

在飞书项目协作中，很多重要信息散落在群聊、文档、任务和会议记录里：

- 之前为什么选择方案 B，而不是方案 A；
- 某个截止时间是谁确认的；
- 某个风险事项后来有没有更新；
- 团队规则是否已经被新规则覆盖。

如果这些信息只停留在聊天记录里，AI Agent 每次对话都会“从零开始”，团队也容易重复争论或遗忘关键上下文。

Kairos 的目标是把这些协作信息沉淀为可检索、可更新、可追溯、可评测的长期记忆。

---

## 2. 记忆定义

当前阶段 Kairos 聚焦 **项目决策记忆**，并保留团队规则、风险事项、工作流作为辅助类型。

核心记忆类型：

| 类型 | 含义 | 示例 |
|---|---|---|
| decision | 项目决策、理由、反对意见和结论 | MVP 阶段使用 SQLite，不使用 PostgreSQL |
| convention | 团队规则和约定 | 周报以后发给 Bob |
| risk | 高风险事项 | 预览测试需要配置独立 IP，否则可能出现中文乱码 |
| workflow | 可复用操作流程 | 提交前必须跑测试命令 |

其中最重要的是 decision，因为它最贴合赛题方向 B：飞书项目决策与上下文记忆。

---

## 3. 系统架构

```text
飞书会话导出 / 项目文档 / CLI 输入
  → 输入适配：标准化为 NormalizedMessage
  → 候选窗口：整理出可分析片段
  → Decision Extractor：抽取决策 / 规则 / 风险 / 工作流
  → MemoryAtom：结构化记忆单元
  → SQLite Store + JSONL Event Log
  → Search / Recall / Supersede / Remind
  → Benchmark Report
```

当前实现重点是先跑通最小闭环：

```text
文本或会话片段
→ 结构化决策抽取
→ 写入 MemoryAtom
→ 检索召回
→ 矛盾更新
→ 核心评测
```

---

## 4. MemoryAtom

MemoryAtom 是 Kairos 的基础记忆单元。

关键字段：

```ts
type MemoryAtom = {
  id: string;
  type: "decision" | "convention" | "risk" | "workflow" | "knowledge";
  scope: "personal" | "team" | "org";
  project?: string;

  subject: string;
  content: string;

  created_at: string;
  observed_at: string;
  valid_at: string;
  invalid_at?: string;
  expired_at?: string;

  status: "active" | "superseded" | "expired" | "deleted" | "conflict_pending";

  confidence: number;
  importance: 1 | 2 | 3 | 4 | 5;

  source: {
    channel: "feishu" | "cli" | "openclaw" | "manual";
    source_type: string;
    excerpt: string;
    chunk_ids?: string[];
  };

  tags: string[];
  supersedes?: string[];
  superseded_by?: string;
  metadata?: Record<string, unknown>;
};
```

设计重点：

- 用 `status` 和 `superseded_by` 表示记忆是否仍有效；
- 用 `source.excerpt` 和 `chunk_ids` 保留证据；
- 用 `metadata` 保存决策理由、反对意见、别名、反向检索 key 等结构化信息。

---

## 5. 决策记忆结构

一条项目决策不应只是摘要，而应包含：

```ts
type DecisionCandidate = {
  kind: "decision";
  topic: string;
  decision: string;
  options_considered: string[];
  reasons: string[];
  rejected_options: { option: string; reason: string }[];
  opposition: { speaker?: string; content: string }[];
  conclusion: string;
  stage?: string;
  evidence_message_ids: string[];
  aliases: string[];
  negative_keys: string[];
  confidence: number;
};
```

例如“为什么不用 PostgreSQL？”能够命中这条记忆，是因为系统不仅保存“使用 SQLite”，还保存：

- `aliases`: SQLite、PostgreSQL、本地存储、Store 层；
- `negative_keys`: 为什么不用 PostgreSQL、PostgreSQL 被否定原因；
- `rejected_options`: PostgreSQL，原因是复赛 demo 部署成本高。

---

## 6. 当前已实现

截至 2026-04-28，Kairos 已实现并可运行：

- CLI：`memoryops`；
- MemoryAtom 类型与 Zod Schema；
- SQLite Store；
- JSONL Event Log；
- `add / search / recall / list / history`；
- `supersede` 非损失效覆盖；
- 飞书会话导出解析：`normalize-chat-export`；
- 候选片段 baseline：`segment-chat-export`；
- 结构化决策抽取 baseline：`extract-decision`；
- LLMDecisionExtractor 可选路径：`extract-decision --llm --fallback`，支持 OpenAI-compatible 接口；
- DecisionCandidate → MemoryAtom 写入；
- Recall 确定性格式化回答：能把最相关记忆整理为历史决策 / 风险 / 流程回答；
- Decision Card 文本版：`decision-card <memory_id>`；
- 飞书 Decision Card payload 预览：`decision-card <memory_id> --feishu-json`，以及显式 webhook 发送路径：`--send-feishu-webhook`；
- Remind 本地 MVP：按 `review_at <= --now` 查询到期风险记忆；
- 一键本地端到端演示：`npm run demo:e2e`；
- 核心评测：decision-extraction / conflict-update / recall / anti-interference / remind；
- LLM 抽取显式评测：`eval --suite llm-decision-extraction`，不进入 core eval；
- Vitest 单元测试与 TypeScript build。

---

## 7. 当前边界

必须明确：Kairos 目前仍是 MVP，不是成熟产品。

当前真实边界：

1. 默认 Decision Extractor 仍是规则 baseline；LLMDecisionExtractor 已有可选路径，但小型显式评测当前观测为 3/4 通过，存在超时样本，不能宣传为生产级抽取效果；
2. Candidate Segment Pipeline 仍是输入清洗 baseline，不是核心智能算法；
3. `recall` 是检索 + 确定性格式化回答，不是完整自然语言问答生成；
4. `remind` 已有本地到期查询、ack、snooze MVP，但尚未实现飞书推送和周期性自动投递；
5. 历史决策卡片已有 CLI 文本版、飞书 payload 生成和 webhook 发送路径，但尚未内置飞书 OAuth；
6. 飞书接入目前依赖 OpenClaw 工具拉取 / 导出文档，Kairos CLI 尚未内置飞书 API OAuth 调用；
7. Benchmark 数据集仍然很小，core eval 只有 26 个最小用例，只能证明最小闭环可跑，不能代表真实生产效果。

---

## 8. 复赛前交付重点

接下来优先做：

1. 修正 LLM 路径稳定性：缩短 prompt、优化 timeout/retry、扩大真实样本评测；
2. 完善 Remind 投递链路：飞书推送、周期性自动投递、提醒策略配置；
3. 完善飞书卡片推送：当前已有 webhook 发送路径，后续可接入 OAuth / OpenClaw 演示流；
4. 扩充 Benchmark：真实飞书导出片段、抗干扰、矛盾更新、召回质量；
5. 稳定飞书会话导出 → CLI → recall / decision-card 的演示链路；
6. 持续写清楚当前能力边界，避免夸大。

---

## 9. 一句话总结

> Kairos 聚焦项目决策记忆：从飞书协作内容中提取决策、理由、反对意见和结论，存成可检索、可更新、可追溯的 MemoryAtom，并通过抗干扰、矛盾更新和效能指标验证价值。
