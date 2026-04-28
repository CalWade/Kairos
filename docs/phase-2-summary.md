# Kairos 第二阶段个人小结

> 时间：2026-04-28  
> 主题：从“本地记忆引擎 MVP”推进到“依托 OpenClaw 的飞书工作流记忆系统”

## 1. 这一阶段解决了什么问题

第一阶段的 Kairos 已经跑通了 MemoryAtom、SQLite Store、JSONL Event Log、基础 recall 和 supersede，但它更像一个本地 CLI 原型。第二阶段的核心目标，是把项目从“能存、能查”推进到更接近赛题要求的三件事：

1. 让项目决策记忆的结构更完整；
2. 让系统能在 CLI 与飞书之间流转；
3. 用评测与演示证明这个闭环不是口头方案。

这一阶段最大的认知变化是：Kairos 不应该把所有飞书能力都塞进自己体内。更合理的定位是：

```text
OpenClaw 负责飞书入口和编排
Kairos 负责记忆提取、存储、召回、更新、提醒和卡片生成
```

这使得项目更贴合 OpenClaw Memory 赛道，也避免了过早陷入公网回调、飞书 OAuth、事件订阅和权限配置的复杂性。

## 2. 主要完成项

### 2.1 核心评测扩展

核心评测从最初的 5 个用例扩展到 26 个最小用例，覆盖：

- decision-extraction：12 / 12
- conflict-update：4 / 4
- recall：5 / 5
- anti-interference：3 / 3
- remind：2 / 2

命令：

```bash
npm run dev -- eval --core
```

这证明了最小闭环可跑，但仍然只是小规模人工构造数据集，不能代表生产效果。

### 2.2 LLMDecisionExtractor 可选路径

接入了主办方提供的 OpenAI-compatible 模型，支持：

```bash
npm run dev -- extract-decision --llm --fallback --text "..."
```

配置通过本地 `.env` 读取，不写入代码、不提交密钥。实际连通性已验证。

同时新增显式 LLM 评测：

```bash
npm run dev -- eval --suite llm-decision-extraction
```

当前观测结果为 3 / 4：

```text
PASS llm_decision_storage_natural_001 decision
FAIL llm_risk_api_key_001 timeout / AbortError
PASS llm_workflow_export_001 workflow
PASS llm_none_unresolved_001 none
```

这个结果很有价值：LLM 路径可用，但不稳定，尤其存在超时问题。因此 Kairos 必须保留规则 baseline 和 fallback，而不能把 LLM 当成唯一可靠路径。

### 2.3 Recall 输出升级

`recall` 不再只是返回原始 content，而是会将最相关记忆整理成可读回答：

```text
历史决策：...
理由：...
被否方案：...
状态：当前有效
记忆 ID：...
可运行：memoryops decision-card <id>
```

这让 recall 从“检索结果”更接近“可被飞书用户直接理解的工作流回答”。

### 2.4 Decision Card 文本版与飞书卡片

新增：

```bash
memoryops decision-card <memory_id>
memoryops decision-card <memory_id> --json
memoryops decision-card <memory_id> --feishu-json
```

卡片内容包括：

- 决策
- 结论
- 理由
- 被否方案
- 反对 / 顾虑
- 证据摘录
- 当前状态
- Memory ID

随后实现了真实飞书机器人 webhook 发送路径：

```bash
memoryops decision-card <memory_id> --send-feishu-webhook --feishu-webhook <url>
```

测试机器人已真实发送成功，飞书返回：

```text
status 200 / code 0 / msg success
```

这一步把“卡片 payload 预览”推进到了“真实飞书发送”，避免停留在虚假对接。

### 2.5 Remind / Forgetting 本地生命周期

新增本地提醒生命周期：

```bash
memoryops remind --project kairos --now 2026-05-30T00:00:00.000Z
memoryops remind snooze <memory_id> --until 2026-06-01T00:00:00.000Z
memoryops remind ack <memory_id>
```

能力包括：

- 风险记忆生成 `review_at`
- 查询到期提醒
- snooze 延后提醒
- ack 清除 `review_at` 并记录处理状态

当前仍未实现周期性自动投递和飞书提醒交互，但本地生命周期已经完整。

### 2.6 端到端演示脚本

新增：

```bash
npm run demo:e2e
```

流程包括：

1. 抽取并写入项目决策；
2. 召回“为什么不用 PostgreSQL？”；
3. 输出历史决策卡片；
4. 演示周报接收人 Alice → Bob 的 supersede；
5. 写入风险记忆并演示 remind / snooze / ack；
6. 运行核心评测。

脚本使用临时 SQLite / JSONL，不污染默认 `data/`。

### 2.7 OpenClaw 飞书入口工作流

根据赛题目标重新判断后，确定 Kairos 的飞书入口不走自建飞书事件服务器，而走 OpenClaw hook / 外挂 Agent 模式。

新增：

```bash
memoryops feishu-workflow --project kairos --text "要不我们还是用 PostgreSQL？"
```

它会判断飞书消息是否触及历史记忆，并输出：

- action
- reason
- answer
- memory_id
- card payload

新增 OpenClaw hook：

```text
hooks/kairos-feishu-ingress/
  HOOK.md
  handler.ts
```

监听：

```text
message:received
```

默认只记录 workflow 输出到：

```text
runs/kairos-feishu-ingress.jsonl
```

设置以下环境变量后才会自动发卡片：

```bash
KAIROS_HOOK_SEND_FEISHU=1
KAIROS_FEISHU_WEBHOOK_URL=...
```

本地模拟：

```bash
npm run demo:feishu-workflow
```

已验证能从模拟飞书消息“要不我们还是用 PostgreSQL？”触发 `push_decision_card`。

## 3. 当前真实边界

必须继续实事求是：

1. Kairos 默认抽取仍是规则 baseline；LLM 可选但不稳定。
2. Candidate Segment Pipeline 只是输入适配 baseline，不是核心智能算法。
3. Recall 是检索 + 确定性格式化，不是完整生成式问答。
4. Remind 有本地生命周期，但没有周期性自动投递。
5. 飞书发送已通过 webhook 打通，但 Kairos 本体没有内置飞书 OAuth。
6. 飞书接收采用 OpenClaw hook 模式，不自建公网事件服务器。
7. Benchmark 仍小，缺真实飞书导出大样本和效能指标。

这些边界不能被包装掉。当前项目能展示 MVP 价值，但不能宣称生产级。

## 4. 我对项目方向的判断

这阶段最大的收获是：Kairos 的核心卖点不应该是“我做了很多工具命令”，而应该是：

> 在 OpenClaw + 飞书环境中，把项目讨论中的决策、理由、反对意见和结论沉淀为可更新、可召回、可推送、可评测的长期团队记忆。

因此，真正重要的工作流是：

```text
飞书消息 / 文档
→ OpenClaw 接收
→ Kairos 判断是否触及历史记忆
→ Recall / Decision Card
→ 飞书卡片推送
→ Benchmark 证明减少重复争论
```

这比自建一个飞书事件服务器更贴合赛题，也更容易演示。

## 5. 下一阶段建议

### P0：把 OpenClaw Hook 跑成真实飞书流

当前 hook 已写好，但还需要在实际 OpenClaw Gateway 中启用和测试：

```bash
openclaw hooks enable kairos-feishu-ingress
openclaw hooks check
```

然后在飞书测试群中发送触发消息，确认：

- hook 能收到消息；
- Kairos workflow 能判断 action；
- 日志写入 `runs/kairos-feishu-ingress.jsonl`；
- 开启 `KAIROS_HOOK_SEND_FEISHU=1` 后能发卡片。

### P0：补真实工作流 Benchmark

当前评测还偏“算法用例”。需要增加工作流指标：

- 手动翻聊天找到决策需要多少步；
- Kairos recall/card 需要多少步；
- 是否减少重复争论；
- 在噪声消息中是否仍能触发正确历史卡片。

### P1：优化 LLM 路径

- 缩短 prompt；
- 降低 max_tokens；
- 对风险类样本做稳定性优化；
- 继续保留 fallback；
- 不让 LLM eval 进入 core。

### P1：打磨参赛材料

- 白皮书保留当前边界；
- Demo 脚本聚焦飞书工作流；
- Benchmark 报告强调最小闭环和真实不足；
- 录屏重点展示“重复讨论 PostgreSQL → Kairos 推历史决策卡”。

## 6. 小结

第二阶段把 Kairos 从一个本地 MemoryOps 原型，推进成了一个更贴近 OpenClaw 赛题的工作流型记忆系统：

- 有结构化记忆；
- 有更新和遗忘；
- 有 recall 和卡片；
- 有飞书 webhook 输出；
- 有 OpenClaw hook 入口；
- 有端到端演示；
- 有最小 Benchmark；
- 也清楚知道自己还不是生产级系统。

下一阶段最关键的不是继续堆功能，而是把 OpenClaw hook 真实跑起来，并用真实飞书项目讨论证明：Kairos 能在关键时刻把历史决策推回到团队面前。
