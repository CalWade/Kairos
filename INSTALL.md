# Kairos 安装与接入

运行方式：**lark-cli Runtime 模式**。

## 1. 安装项目

```bash
git clone https://github.com/CalWade/Kairos.git
cd Kairos
npm install
npm run build
```

## 2. 安装并授权 lark-cli

```bash
npm install -g @larksuite/cli
lark-cli auth login --recommend --profile kairos-alt
```

授权注意事项：

- 按 lark-cli 官方页面完成授权；
- `auth login` 命令需要保持运行，直到浏览器授权完成并返回成功；
- 不要反复运行 `lark-cli config init --new`，避免创建多个 CLI 应用。

## 3. 获取目标群 chat_id

```bash
lark-cli im +chat-list --format json --profile kairos-alt
```

或用消息搜索结果里的 `chat_id`。

## 4. 配置目标群机器人 webhook

在目标飞书群添加自定义机器人，复制 webhook：

```text
https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
```

webhook 必须来自同一个目标群。

## 5. 运行接入向导

```bash
npm run setup:lark-runtime -- \
  --profile kairos-alt \
  --chat-id oc_xxx \
  --feishu-webhook "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" \
  --test-read \
  --test-webhook
```

该命令会检查 lark-cli、profile、chat_id、webhook，并写入 `.env`。

写入后，`npm run lark-runtime` 和 `npm run lark-runtime:once` 会自动读取 `.env`，不需要手动 `export KAIROS_CHAT_ID`。

## 6. 启动

终端 1：

```bash
npm run dashboard
```

终端 2：

```bash
npm run lark-runtime
```

浏览器打开：

```text
http://127.0.0.1:8787
```

## 7. 调试

只跑一轮 runtime：

```bash
npm run lark-runtime:once
```

如果需要临时覆盖配置，可以直接使用 CLI 参数：

```bash
npm run dev -- lark-cli runtime --chat-id oc_xxx --profile kairos-alt --once
```

运行核心评测：

```bash
npm run eval:core
```

## 8. OpenClaw 的角色

OpenClaw 在本项目中体现为：

- Agent 宿主；
- 项目部署和配置控制面；
- Runtime / Dashboard / Benchmark 的运行和排障环境；
- 比赛展示中的自动化运维入口。

飞书数据接入由官方 `lark-cli` 负责。
