# lark-cli Runtime Runbook

## 运行方式

Kairos 使用官方 `lark-cli` 读取飞书群消息，使用目标群自定义机器人 webhook 发送决策卡片。

```text
lark-cli Runtime
→ Induction Queue
→ MemoryAtom
→ Activation
→ Feishu Decision Card
→ Dashboard
```

## 1. 安装 lark-cli

```bash
npm install -g @larksuite/cli
lark-cli --version
```

## 2. 授权 profile

推荐 profile：

```text
kairos-alt
```

按官方流程运行：

```bash
lark-cli auth login --recommend --profile kairos-alt
```

注意：

- 保持该命令运行，直到浏览器授权完成；
- 不要反复运行 `lark-cli config init --new`；
- 如果授权失败，先检查：

```bash
lark-cli auth status --profile kairos-alt
```

## 3. 配置 LLM 判断模型

真实群聊会话解缠和慢速归纳依赖 OpenAI-compatible LLM。`.env` 中需要包含：

```bash
KAIROS_LLM_BASE_URL=https://example.com/v1
KAIROS_LLM_API_KEY=sk-xxx
KAIROS_LLM_MODEL=your-model
```

检查配置：

```bash
npm run dev -- llm:check
```

需要实际连通性测试时运行：

```bash
npm run dev -- llm:check --test
```

## 4. 获取 chat_id

```bash
lark-cli im +chat-list --format json --profile kairos-alt
```

或者：

```bash
lark-cli im +messages-search --query "群里最近一条独特消息" --format json --profile kairos-alt
```

找到 `oc_xxx` 形式的 `chat_id`。

## 5. 配置 webhook

在目标飞书群添加自定义机器人，复制 webhook。

要求：webhook 必须来自被监听的同一个群。

## 6. 接入向导

```bash
npm run setup:lark-runtime -- \
  --profile kairos-alt \
  --chat-id oc_xxx \
  --feishu-webhook "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" \
  --test-read \
  --test-webhook \
  --test-llm
```

如果不想在 setup 阶段实际请求模型，可以去掉 `--test-llm`；setup 仍会检查 LLM 配置项是否完整。

该命令会检查权限、测试读取消息、测试发卡，并写入 `.env`。

写入时会尽量通过 `lark-cli im +chat-list` 自动解析群名称，保存为 `KAIROS_CHAT_NAME`，Dashboard 会显示「群名称 + chat_id」。如果自动解析不到，可以手动传：

```bash
npm run setup:lark-runtime -- --chat-id oc_xxx --chat-name "Kairos Demo 群" --profile kairos-alt
```

写入后，runtime 会自动读取 `.env`；不需要在每个终端里手动 `export KAIROS_CHAT_ID`。

## 7. 启动

```bash
npm run dashboard
npm run lark-runtime
```

调试一轮：

```bash
npm run lark-runtime:once
```

## 8. 排障

### 授权反复不生效

原因通常是 `auth login` 进程被超时杀掉，或者反复 `config init --new` 创建了多个应用。

处理：

```bash
lark-cli auth status --profile kairos-alt
lark-cli auth login --recommend --profile kairos-alt
```

保持第二条命令运行直到授权成功。

### 能读消息但不发卡

检查：

```bash
grep KAIROS_FEISHU_WEBHOOK_URL .env
```

并确认 webhook 属于目标群。

### Dashboard 无数据或停留在旧记忆

Dashboard 默认读取 `runs/lark-runtime.jsonl`、`data/memory.jsonl` 和队列文件。如果页面还显示旧的测试记忆，先把 demo 状态归档重置：

```bash
npm run demo:reset-state
```

该命令只移动本地 demo 数据文件到 `runs/archive/`，不会修改 `.env`。

然后确认 `.env` 已写入目标群配置：

```bash
grep -E 'KAIROS_CHAT_ID|KAIROS_CHAT_NAME|KAIROS_LARK_PROFILE|KAIROS_FEISHU_WEBHOOK_URL' .env
```

然后运行：

```bash
npm run lark-runtime:once
npm run eval:core
```

刷新：

```text
http://127.0.0.1:8787
```

### 没有 push_decision_card

说明最近群消息没有触及已存在历史记忆。可以先在群里形成决策，再发送复议问题：

```text
要不我们还是用 PostgreSQL？
```

## 9. 运行数据文件

```text
data/memory.jsonl                 MemoryAtom snapshot
data/memory_events.jsonl          Memory event log
data/induction_queue.jsonl        归纳队列
data/refine_queue.jsonl           修正队列
data/activation_throttle.jsonl    推卡频控
runs/lark-runtime.jsonl           runtime 日志（Dashboard 默认读取）
runs/latest-eval.json             本地评测结果
```
