# Kairos OpenClaw 安装说明

Kairos 以 OpenClaw hook pack 形式分发。压缩包内包含：

- `package.json`：声明 `openclaw.hooks`
- `hooks/kairos-feishu-ingress/`：OpenClaw message:received hook
- `dist/`：已编译的 Kairos JS 代码
- `README.md`：项目说明

## 安装

```bash
openclaw plugins install ./memoryops-0.1.0.tgz
openclaw hooks enable kairos-feishu-ingress
openclaw gateway restart
openclaw hooks check
```

## 使用方式

安装并启用后，OpenClaw Gateway 收到飞书消息时会触发：

```text
message:received -> kairos-feishu-ingress -> Kairos feishu-workflow
```

默认行为是只记录工作流判断结果，不主动发送飞书卡片：

```text
runs/kairos-feishu-ingress.jsonl
```

如果要允许自动发送飞书决策卡片，需要显式配置：

```bash
export KAIROS_HOOK_SEND_FEISHU=1
export KAIROS_FEISHU_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/..."
```

## 验证

1. 写入一条测试决策：

```bash
memoryops extract-decision --project kairos --write \
  --text "张三：最终决定 MVP 阶段使用 SQLite 作为当前状态库，同时保留 JSONL Event Log。王五：PostgreSQL 对复赛 demo 来说部署成本太高。"
```

2. 在飞书中发送：

```text
要不我们还是用 PostgreSQL？
```

3. 查看日志：

```bash
tail -f runs/kairos-feishu-ingress.jsonl
```

期望看到：

```json
{"action":"push_decision_card"}
```

## 当前重要限制

当前 hook 默认使用 JSONL portable store，不依赖 `better-sqlite3` native binding，因此通过 OpenClaw `--ignore-scripts` 安装后也可运行。

如需在本地开发中使用 SQLite 后端，可显式设置：

```bash
KAIROS_STORE=sqlite
```

SQLite 模式依赖 `better-sqlite3` native binding，适合开发仓库环境，不作为 hook pack 默认运行模式。
