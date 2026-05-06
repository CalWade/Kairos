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

## 3. 配置 LLM 判断模型

真实群聊会话解缠和慢速归纳依赖 OpenAI-compatible LLM。`.env` 中需要配置：

```bash
KAIROS_LLM_BASE_URL=https://example.com/v1
KAIROS_LLM_API_KEY=sk-xxx
KAIROS_LLM_MODEL=your-model
```

检查：

```bash
npm run dev -- llm:check
```

> 若使用火山方舟 Doubao-Seed-Thinking / 其它 reasoning 模型，建议加一行：
>
> ```bash
> KAIROS_LLM_DISABLE_THINKING=1
> ```
>
> 关闭 CoT 后 thread linking / 决策抽取延迟可从 30–60s 压到 3–5s，对结构化 JSON 输出基本无影响。
> 非 reasoning 模型（OpenAI GPT-4o、Claude 等）忽略未知字段，留空即可。

## 4. 获取目标群 chat_id

```bash
lark-cli im +chat-list --format json --profile kairos-alt
```

或用消息搜索结果里的 `chat_id`。

## 5. 配置目标群机器人 webhook

在目标飞书群添加自定义机器人，复制 webhook：

```text
https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
```

webhook 必须来自同一个目标群。

## 6. 运行接入向导

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

## 7. 启动

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

## 8. 调试

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

## 9. OpenClaw 的角色

OpenClaw 在本项目中体现为：

- Agent 宿主；
- 项目部署和配置控制面；
- Runtime / Dashboard / Benchmark 的运行和排障环境；
- 比赛展示中的自动化运维入口。

飞书数据接入由官方 `lark-cli` 负责。
