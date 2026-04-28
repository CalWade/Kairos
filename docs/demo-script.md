# Kairos Demo Script

## Demo 1：项目决策召回

### 输入讨论

```text
张三：最终决定 MVP 阶段使用 SQLite 作为当前状态库，同时保留 JSONL Event Log。
王五：PostgreSQL 对复赛 demo 来说部署成本太高，容易让评委跑不起来。
```

### 操作

```bash
npm run dev -- extract-decision \
  --project kairos \
  --write \
  --text "张三：最终决定 MVP 阶段使用 SQLite 作为当前状态库，同时保留 JSONL Event Log。王五：PostgreSQL 对复赛 demo 来说部署成本太高，容易让评委跑不起来。"

npm run dev -- recall \
  --project kairos \
  "为什么不用 PostgreSQL？" \
  --evidence
```

### 预期

返回 SQLite + JSONL 决策，并说明 PostgreSQL 被否定的原因是复赛 demo 部署成本高。

---

## Demo 2：矛盾更新

### 操作

```bash
npm run dev -- ingest --project kairos --text "以后周报每周五发给 Alice。"
npm run dev -- ingest --project kairos --text "不对，周报以后发给 Bob，Alice 不再负责这个了。"
npm run dev -- search "周报" --project kairos --include-history
```

### 预期

- Bob 版本 active；
- Alice 版本 superseded；
- 历史可追溯。

---

## Demo 3：飞书会话导出解析

### 操作

```bash
npm run dev -- normalize-chat-export --file /tmp/feishu-chat-export.md --doc-token <doc_token>
npm run dev -- segment-chat-export --file /tmp/feishu-chat-export.md --doc-token <doc_token>
```

### 预期

飞书会话导出文档被解析为逐条 NormalizedMessage，并生成候选片段。当前该能力是输入适配 baseline，不作为核心智能卖点。

---

## Demo 4：核心评测

```bash
npm run dev -- eval --core
```

预期输出：

```text
decision-extraction: pass
conflict-update: pass
recall: pass
```


## 可选：LLM 抽取演示

如果本地 `.env` 已配置主办方提供的 OpenAI-compatible 接口，可以演示 LLMDecisionExtractor：

```bash
npm run dev -- extract-decision \
  --llm \
  --fallback \
  --project kairos \
  --text "张三：最终决定 MVP 阶段使用 SQLite 作为当前状态库，同时保留 JSONL Event Log。王五：PostgreSQL 对复赛 demo 来说部署成本太高，容易让评委跑不起来。"
```

说明：`--fallback` 表示 LLM 请求失败时回退到规则 baseline。当前这只是可选抽取路径，不代表已经完成生产级抽取效果。


## 历史决策卡片演示

先通过 `extract-decision --write` 写入一条决策记忆，记录返回的 `saved.id`，再运行：

```bash
npm run dev -- decision-card <memory_id>
```

输出会包含：

- 当前状态
- 决策与结论
- 决策理由
- 被否方案
- 反对 / 顾虑
- 证据摘录

说明：当前是 CLI Markdown 文本版，适合作为飞书交互式卡片的稳定内容层；飞书卡片推送尚未实现。
