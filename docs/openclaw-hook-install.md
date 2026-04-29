# Kairos OpenClaw Hook 安装方案

Kairos 的飞书入口采用 OpenClaw hook / 外挂 Agent 模式，不自建飞书事件服务器。

## 架构职责

```text
飞书消息
  ↓
OpenClaw Gateway message:received
  ↓
kairos-feishu-ingress hook（只转发）
  ↓
memoryops feishu-workflow
  ↓
Kairos 四级漏斗：规则过滤 / salience / rule extractor / LLM extractor
  ↓
MemoryAtom / Recall / Decision Card
```

设计原则：**筛选能力不外包**。OpenClaw 只负责 IO，Kairos 负责所有记忆判断。

## 推荐安装：本地 link hook pack

在开发或比赛演示机器上：

```bash
cd /home/ecs-user/.openclaw/workspace/memoryops
openclaw plugins install -l .
openclaw hooks enable kairos-feishu-ingress
openclaw gateway restart
openclaw hooks check
```

`package.json` 中声明：

```json
{
  "openclaw": {
    "hooks": {
      "kairos-feishu-ingress": "hooks/kairos-feishu-ingress"
    }
  }
}
```

OpenClaw 会把 hook pack 作为 managed hook 发现。

## 生产/分发安装：压缩包

```bash
npm pack
openclaw plugins install ./memoryops-0.1.0.tgz
openclaw hooks enable kairos-feishu-ingress
openclaw gateway restart
```

`package.json` 中配置了 `prepack: npm run build` 和 `files: ["dist", "hooks", ...]`，因此发布/打包产物会包含已编译的 `dist/`。用户通过 `.tgz` 安装时不需要再手动运行 `npm run build`。

开发机使用 `openclaw plugins install -l .` 时，仍建议在改动源码后先运行：

```bash
npm run build
```

否则 linked hook 会明确报错：`Kairos dist/ is missing required files`。

## 环境变量

默认只记录 workflow 输出，不自动发飞书卡片：

```text
runs/kairos-feishu-ingress.jsonl
```

如需自动通过飞书机器人 webhook 发送卡片：

```bash
export KAIROS_HOOK_SEND_FEISHU=1
export KAIROS_FEISHU_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/..."
```

可选：显式指定 Kairos 仓库路径，避免 Gateway 进程 cwd 不确定：

```bash
export KAIROS_REPO_DIR="/home/ecs-user/.openclaw/workspace/memoryops"
```

## 验证

1. 写入一条历史决策：

```bash
npm run dev -- extract-decision --project kairos --write \
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

期望：

```json
{"action":"push_decision_card"}
```

## 当前边界

- Hook 已能接收 OpenClaw 的 `message:received` 事件并调用 Kairos。
- 打包分发包包含 `dist/`，避免用户安装后再手动 build。
- 默认不发送，避免刷群；发送必须显式开启环境变量。
- 该方案不内置飞书 OAuth，不自建公网事件服务器。
