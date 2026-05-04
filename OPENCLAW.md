# Kairos OpenClaw 自动安装说明

当用户把这个 GitHub 仓库链接发给 OpenClaw/Agent 时，请按本文件执行。目标是让用户尽量只参与必要授权，不手动拼命令。详细逐步手册见 `docs/lark-cli-runbook.md`，快速核对清单见 `docs/openclaw-agent-checklist.md`。

## 0. 安全边界

不要向用户索要：

- 飞书密码
- 手机验证码
- App Secret
- OAuth token
- webhook 完整 URL，除非用户明确要配置自动发送

涉及外部写操作或全局安装时，先说明将执行什么；涉及飞书授权时，给用户浏览器链接，由用户自己确认。

## 1. 安装策略

OpenClaw 插件安装器不应直接吃 Git URL。拿到 GitHub 链接后，Agent 应该：

```bash
git clone https://github.com/CalWade/Kairos.git kairos
cd kairos
npm install
npm run build
openclaw plugins install .
openclaw gateway restart
```

如果要生成免编译分发包：

```bash
npm pack
openclaw plugins install ./memoryops-0.1.0.tgz
openclaw gateway restart
```

Kairos hook 默认使用 JSONL portable store，不依赖 native SQLite 编译。

## 2. 必要依赖

Node.js 22+；OpenClaw；官方 lark-cli：

```bash
npm install -g @larksuite/cli
lark-cli --version
```

如果 `lark-cli` 已安装，跳过全局安装。

## 3. 飞书授权交互

创建独立 profile，避免污染用户现有 lark-cli 账号：

```bash
lark-cli config init --new --name kairos-alt
lark-cli auth login --recommend --profile kairos-alt
lark-cli auth status --profile kairos-alt
```

上述命令会输出浏览器链接。把链接发给用户，让用户用目标飞书账号完成确认。不要代替用户输入凭据。

## 4. 权限预检

```bash
memoryops lark-cli status --check-auth --profile kairos-alt
memoryops lark-cli preflight --purpose chat_messages --profile kairos-alt
```

主路径需要 `im:message.group_msg:get_as_user`。缺 `search:message` 不阻塞主路径；按群 `chat_id` 读取即可。

## 5. 获取 chat_id

优先让用户提供群 `chat_id`。如果没有，尝试：

```bash
lark-cli im +chat-search --query <群名关键词> --format json --profile kairos-alt
```

## 6. 跑通端到端

```bash
memoryops lark-cli e2e-chat   --chat-id <oc_xxx>   --profile kairos-alt   --project kairos   --trigger-text "要不我们还是用 PostgreSQL？"
```

成功标志：输出 JSON 中 `workflow.action` 为 `push_decision_card`。

## 7. OpenClaw hook

插件包内含：

```text
hooks/kairos-feishu-ingress
```

安装插件后，OpenClaw 会管理插件 hook。若是 workspace hook，则可用：

```bash
openclaw hooks check
openclaw hooks list
```

默认安全模式不自动发飞书卡片。自动发送需用户显式配置：

```bash
KAIROS_HOOK_SEND_FEISHU=1
KAIROS_FEISHU_WEBHOOK_URL=<webhook>
```

## 8. 验证命令

优先用一条 doctor：

```bash
memoryops doctor --profile kairos-alt
memoryops doctor --profile kairos-alt --chat-id <oc_xxx> --e2e
```

也可手动验证：

```bash
npm run build
npm test -- --run
npm run dev -- eval --core
memoryops lark-cli preflight --purpose chat_messages --profile kairos-alt
```

## 9. 降级方案

- lark-cli scope 不足：用飞书导出文件或 OpenClaw 飞书工具获取数据，再 `memoryops lark-cli ingest-file`。
- 不能全局搜索：不用 `+messages-search`，按 `chat_id` 读取。
- webhook 不可用：只生成 Decision Card JSON，不自动发送。


## Setup Wizard / Pretty Doctor

```bash
memoryops setup-wizard --profile kairos-alt
memoryops doctor --profile kairos-alt --pretty
memoryops doctor --profile kairos-alt --chat-id <oc_xxx> --e2e --pretty
```

录屏或评审 demo 可用：

```bash
KAIROS_DEMO_CHAT_ID=<oc_xxx> npm run demo:lark-cli-chat
```
