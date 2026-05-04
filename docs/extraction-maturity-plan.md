# Kairos 抽取与分段成熟化方案

> 目标：把当前“可跑通 Demo 的 baseline”升级为“复赛可解释、可评测、可迭代的记忆抽取流水线”。

## 0. 问题判断

当前 Kairos 的真实闭环已经跑通：lark-cli 读取真实飞书群消息 → Kairos 入库 → 后续提问触发 `push_decision_card`。

但复赛要求不只看“链路通”，还会看记忆引擎本身是否足够像一个成熟系统。当前最薄弱的三块是：

1. `ruleDecisionExtractor`：规则抽取 baseline；
2. `LLMDecisionExtractor`：可选但不稳定的 LLM 路径；
3. Candidate Segment Pipeline：输入清洗和切分 baseline。

这三块如果不升级，项目会显得像“关键词脚本 + demo wrapper”，而不是“记忆引擎”。

## 1. 成熟化目标

不是立刻做生产级系统，而是在复赛前达到以下标准：

| 能力 | 当前状态 | 复赛成熟标准 |
|---|---|---|
| 抽取 | 单层规则 baseline | 规则候选 + LLM 结构化抽取 + fallback + 置信度/拒识 |
| 分段 | 简单消息切分 | 以主题/时间/参与人/引用线索构建 CandidateWindow，并保留证据链 |
| 召回触发 | 简单关键词 cue | 基于 MemoryAtom metadata 的触发判断，区分提问、复议、确认、噪声 |
| 评测 | 小规模人工用例 | 覆盖真实飞书噪声、误抽、漏抽、冲突、长片段、多轮讨论 |
| 安全 | 默认不外发 | 继续默认 dry-run，所有外部发送显式开启 |

## 2. 新架构：三阶段抽取流水线

建议将当前抽取链路明确为：

```text
Raw Feishu Messages
  ↓
Stage A: Candidate Segment Pipeline
  - 消息标准化
  - 噪声过滤
  - 主题窗口构建
  - salience 打分
  - evidence ids 保留
  ↓
Stage B: Hybrid Extractor
  - Rule pre-classifier：判断候选类型和是否值得抽取
  - LLM structured extractor：对高价值候选做 JSON schema 抽取
  - Deterministic fallback：LLM 失败时回退规则抽取
  - Rejector：疑问句、未定讨论、低价值流程不入库
  ↓
Stage C: Reconcile & Memory Write
  - 查找同 subject / tags / aliases 的旧记忆
  - 判断 ADD / UPDATE / SUPERSEDE / DUPLICATE / CONFLICT_PENDING
  - 写入 MemoryAtom + EventLog
```

## 3. Candidate Segment Pipeline 成熟化

### 当前问题

当前 pipeline 更多是 baseline：按时间、标题、显著性做粗分段。真实飞书群里会有：

- 多人交错讨论；
- 机器人卡片；
- 授权链接；
- “ok / 好了 / 收到”；
- 先争论、后拍板；
- 一个决策横跨多条消息；
- 后续有人复议旧决策。

如果分段不好，抽取器拿到的窗口就会缺关键上下文，或者混入大量噪声。

### 复赛前落地方案

新增 `CandidateWindowV2`，保留当前 CandidateWindow 兼容：

```ts
type CandidateWindowV2 = {
  id: string;
  messages: NormalizedMessage[];
  text: string;
  topic_hint?: string;
  salience_score: number;
  salience_reasons: string[];
  evidence_message_ids: string[];
  noise_message_ids: string[];
  window_kind: 'decision_thread' | 'risk_thread' | 'workflow_thread' | 'low_value';
  has_resolution_cue: boolean;
  has_question_cue: boolean;
  has_conflict_cue: boolean;
}
```

新增窗口构建规则：

1. 时间相近 + 相同 topic token 合并；
2. 出现“最终决定 / 结论 / 先按 / 不用 / 改为”时向前合并 3-5 条上下文；
3. 出现“为什么 / 要不 / 还是 / 是否”时标记为 question，不直接入库，只用于 workflow 触发；
4. app/card/oauth 链接默认归入 noise；
5. 每个窗口必须保留原始 message_id 列表。

## 4. RuleDecisionExtractor 成熟化

### 当前问题

规则抽取现在偏关键词模板，容易有两个问题：

- 误抽：把“要不我们还是用 PostgreSQL？”当成决策；
- 漏抽：真实表达不包含固定词时抽不出。

### 复赛前落地方案

把它从“最终抽取器”降级为“规则预分类器 + fallback 抽取器”：

```text
Rule PreClassifier:
  - 判断候选类型
  - 判断是否有拍板信号
  - 判断是否疑问/未定/噪声
  - 给 LLM 提供 type hint

Rule Fallback Extractor:
  - LLM 失败时输出保守结构
  - 宁可 none，不强行抽
```

关键原则：

- 有 question cue 且无 resolution cue → `none`；
- 有方案名但无结论动词 → `none`；
- 有“最终决定/结论/先按/不使用/改为”才允许 decision；
- workflow 需要至少 2 个可执行步骤或明确命令，否则不入库。

## 5. LLMDecisionExtractor 成熟化

### 当前问题

当前 LLM 路径是可选增强，曾出现 timeout / JSON 不稳定。不能让它直接成为不可控主链路。

### 复赛前落地方案

使用“受控 LLM 抽取”：

1. 输入只给 CandidateWindow，不给全量聊天；
2. prompt 明确要求：只能基于 evidence，不得补全；
3. 输出必须匹配 Zod schema；
4. schema 校验失败 → retry 一次；
5. retry 仍失败 → fallback 到规则抽取；
6. LLM 输出必须包含 `should_remember` 和 `reject_reason`；
7. 低置信输出进入 `conflict_pending` 或不写入。

目标不是让 LLM “更聪明地回答”，而是让 LLM 更稳地做结构化抽取。

## 6. Reconcile 成熟化

当前已有 supersede，但自动 reconcile 还不够成熟。复赛前最低目标：

- 新 atom 写入前搜索同 project/type/subject 的 active atom；
- 如果 subject 相同且内容相反，调用 `supersede`；
- 如果内容高度重复，标记 duplicate，不重复写入；
- 如果无法判断，标记 `conflict_pending`，不自动覆盖。

这能解决重复 ingest 造成的重复记忆问题。

## 7. 必须新增评测

### Candidate Pipeline

- 机器人卡片 + 用户决策混合，只抽用户决策；
- 5 条争论 + 1 条最终决定，窗口包含上下文；
- “要不还是用 PostgreSQL？”只作为触发，不入库。

### Rule Extractor

- 决策句：最终决定先用 SQLite；
- 疑问句：要不还是用 PostgreSQL？→ none；
- 未定句：晚上再讨论数据库方案 → none；
- 复议句：为什么不用 PostgreSQL？→ none；
- 风险句：API Key 不允许前端直连 → risk。

### LLM Extractor

- 合法 JSON；
- 非 JSON 自动 retry/fallback；
- timeout fallback；
- LLM 幻觉字段被 schema 拒绝；
- should_remember=false 不写入。

### Reconcile

- 重复 ingest 不重复写；
- SQLite 决策被 PostgreSQL 新决策 supersede；
- 不确定冲突进入 conflict_pending。

## 8. 复赛前优先级

### P0：必须做

1. CandidateWindowV2 或等价字段：question/resolution/conflict/noise cues；
2. Rule extractor 改成保守策略：疑问/未定不入库；
3. LLM extractor 增加 `should_remember/reject_reason` schema + retry/fallback；
4. ingest-chat 加 duplicate 防护；
5. 新增真实飞书噪声评测。

### P1：强烈建议

1. doctor 输出抽取质量摘要：read_total / candidate_total / saved_total / rejected_total；
2. e2e-chat 输出保存的 MemoryAtom 摘要和拒绝原因；
3. Decision Card 增加证据 message_id。

### P2：可后置

1. embedding / hybrid search；
2. 完整人工确认 UI；
3. 多租户权限管理；
4. 文档/Wiki 主线 ingest。

## 9. 对外口径

应该避免说：

> Kairos 已经有生产级通用记忆抽取能力。

可以说：

> Kairos 当前实现了一个可运行的企业决策记忆引擎 MVP。它已经打通真实飞书群消息 → 结构化记忆 → 后续讨论触发历史决策卡片的闭环。复赛前重点升级抽取流水线：从关键词 baseline 演进到 CandidateWindow + 规则预分类 + 受控 LLM 抽取 + fallback + Reconcile 的混合架构，并用真实飞书噪声样本评测其可靠性。
