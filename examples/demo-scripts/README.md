# Kairos Demo Scripts

用于比赛/演示场景的预制剧本。`scripts/demo-inject.mjs` 读取这些 JSONL 文件，
按顺序通过多个飞书自定义机器人 webhook 向目标群发送消息，模拟多人讨论。

## 剧本格式

每行一个 JSON：

```json
{"role": "product", "text": "消息内容", "pause_ms": 1500}
```

字段：

- `role`：角色名，需要在 `data/demo-webhooks.json` 的 `roles` 里有对应 webhook
- `text`：消息纯文本
- `pause_ms`：**发送该条消息后**的等待时间（毫秒），模拟自然打字间隔

## Webhook 映射

新建 `data/demo-webhooks.json`（不进 git）：

```json
{
  "roles": {
    "product": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx-product",
    "engA":    "https://open.feishu.cn/open-apis/bot/v2/hook/xxx-engA",
    "engB":    "https://open.feishu.cn/open-apis/bot/v2/hook/xxx-engB"
  }
}
```

每个 role 对应一个目标群里的自定义机器人。群里看起来像多个机器人轮流发言。

## 内置剧本

| 文件 | 场景 | 验证点 |
|---|---|---|
| `storage-decision.jsonl` | SQLite vs PostgreSQL 决策形成 + 复议 | 长期记忆生成、历史记忆激活 |
| `weekly-report-owner.jsonl` | 周报负责人从 Alice 换到 Bob | 冲突更新、SUPERSEDE |
| `interleaved-noise.jsonl` | hooks 讨论和 API Key 讨论穿插 | 会话解缠（heuristic vs LLM）|

## 使用

```bash
# 列出可用剧本
node scripts/demo-inject.mjs --list

# dry-run（只打印不发送）
node scripts/demo-inject.mjs --script storage-decision --dry-run

# 真发
node scripts/demo-inject.mjs --script storage-decision
```
