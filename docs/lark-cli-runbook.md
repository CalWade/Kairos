# Kairos lark-cli 全流程 Runbook / AI Operator Playbook

本文件给 OpenClaw/Agent 使用。目标：用户只提供 GitHub 链接或压缩包时，Agent 能自动完成安装、依赖检查、lark-cli 授权引导，并跑通真实飞书群消息 → Kairos 记忆 → Decision Card 触发。

## 总原则

- 能自动做的，Agent 直接做：克隆、安装依赖、build、测试、插件安装、doctor、e2e。
- 必须用户确认的，只发链接让用户操作：飞书应用配置、OAuth 授权、提供目标群 `chat_id`、是否开启自动发卡。
- 不要向用户索要密码、验证码、App Secret、OAuth token。
- 主路径是按 `chat_id` 读取群消息，不依赖全局 `search:message`。

## 0. 快速判断流程

如果用户给 GitHub 链接：

```bash
git clone https://github.com/CalWade/Kairos.git kairos
cd kairos
```

如果用户给 `.tgz`：

```bash
openclaw plugins install ./memoryops-0.1.0.tgz
openclaw gateway restart
```

如果已经在仓库目录：直接从第 1 步开始。

## 1. 本地依赖安装

Agent 执行：

```bash
node --version
npm install
npm run build
```

预期：

- Node >= 22
- `npm run build` 成功

失败处理：

- Node 版本低：提示用户需要 Node.js 22+
- npm install 失败：保留完整错误，先不要继续授权

## 2. 安装 OpenClaw 插件

Agent 执行：

```bash
openclaw plugins install .
openclaw gateway restart
```

然后检查：

```bash
openclaw hooks check
openclaw hooks list
```

预期：

- Kairos hook pack 被安装
- `kairos-feishu-ingress` 可被发现

说明：插件包默认 JSONL portable store，不需要 native SQLite 编译。

## 3. 安装官方 lark-cli

Agent 先检查：

```bash
lark-cli --version
```

如果命令不存在，Agent 执行：

```bash
npm install -g @larksuite/cli
lark-cli --version
```

预期示例：

```text
lark-cli version 1.0.23
```

## 4. 创建独立 lark-cli profile

默认 profile 名：

```text
kairos-alt
```

Agent 执行：

```bash
lark-cli profile list
```

如果 `kairos-alt` 已存在且 token valid，可跳到第 6 步。否则执行：

```bash
lark-cli config init --new --name kairos-alt
```

该命令会阻塞并打印类似链接：

```text
https://open.feishu.cn/page/cli?user_code=XXXX-XXXX&...
```

Agent 要把链接发给用户，并说明：

> 请用目标飞书账号打开链接，按页面提示完成应用配置；不要把密码、验证码、App Secret 发给我。完成后回复“好了”。

Agent 等用户回复后，检查命令是否退出 code 0。若超时/被杀，执行：

```bash
lark-cli profile list
```

- 如果 `kairos-alt` 出现：继续第 5 步
- 如果没出现：重新运行 `lark-cli config init --new --name kairos-alt`，生成新链接

## 5. 用户 OAuth 授权

Agent 执行：

```bash
lark-cli auth login --recommend --profile kairos-alt
```

该命令会阻塞并打印类似链接：

```text
https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=...&user_code=XXXX-XXXX
```

Agent 把链接发给用户，并说明：

> 请用目标飞书账号打开链接并确认授权，完成后回复“好了”。

用户回复后，Agent 轮询命令结果。若命令卡住但用户说完成，另开命令验证：

```bash
lark-cli auth status --profile kairos-alt
```

成功标志：

```json
{
  "identity": "user",
  "tokenStatus": "valid"
}
```

如果仍显示：

```text
No user logged in
```

则杀掉旧授权进程，重新执行 `lark-cli auth login --recommend --profile kairos-alt` 发新链接。

## 6. Kairos doctor 预检

Agent 执行：

```bash
memoryops doctor --profile kairos-alt
```

如果本地 `memoryops` 命令不可用，用：

```bash
npm run -s dev -- doctor --profile kairos-alt
```

预期关键检查：

```json
{
  "ok": true,
  "checks": [
    { "name": "node>=22", "ok": true },
    { "name": "lark-cli installed", "ok": true },
    { "name": "lark-cli profile kairos-alt", "ok": true },
    { "name": "chat_messages scope", "ok": true }
  ]
}
```

`message_search scope optional` 失败可以忽略，因为主流程不依赖全局搜索。

## 7. 获取目标群 chat_id

优先问用户提供：

```text
请给我目标飞书群的 chat_id，格式类似 oc_xxx。
```

如果用户不知道，Agent 可尝试按群名搜索：

```bash
lark-cli im +chat-search --query <群名关键词> --format json --profile kairos-alt
```

如果 OpenClaw bot 在群里，用户也可以让群内 bot 返回 chat_id；拿到后继续。

## 8. 真实端到端验收

Agent 执行：

```bash
memoryops doctor   --profile kairos-alt   --chat-id <oc_xxx>   --e2e
```

或者：

```bash
memoryops lark-cli e2e-chat   --chat-id <oc_xxx>   --profile kairos-alt   --project kairos   --trigger-text "要不我们还是用 PostgreSQL？"
```

成功标志：

```json
{
  "ok": true,
  "workflow": {
    "action": "push_decision_card"
  }
}
```

如果 `workflow.action` 不是 `push_decision_card`，检查群里是否存在类似历史决策：

```text
最终决定：MVP 阶段暂时不用 PostgreSQL，先用 SQLite，因为部署成本更低。
```

没有的话，让用户在测试群发一条类似决策，再重跑 e2e。

## 9. 常见失败处理

### 9.1 `memoryops` 命令不存在

用开发命令替代：

```bash
npm run -s dev -- doctor --profile kairos-alt
npm run -s dev -- lark-cli e2e-chat --chat-id <oc_xxx> --profile kairos-alt
```

或确认是否已：

```bash
npm install
npm run build
```

### 9.2 `search:message` 缺失

可忽略。主流程使用：

```bash
lark-cli im +chat-messages-list --chat-id <oc_xxx> --profile kairos-alt
```

### 9.3 能授权但读不到群消息

检查：

- 用户是否在目标群里
- `chat_id` 是否正确
- `kairos-alt` 是否是正确飞书账号
- `memoryops lark-cli preflight --purpose chat_messages --profile kairos-alt` 是否通过

### 9.4 读到消息但没有记忆

说明消息里没有明确决策/规则/风险/流程。让用户发一条明确决策，例如：

```text
最终决定：MVP 阶段暂时不用 PostgreSQL，先用 SQLite，因为部署成本更低。
```

### 9.5 hook 不自动发卡

这是安全默认值。需要用户显式配置：

```bash
KAIROS_HOOK_SEND_FEISHU=1
KAIROS_FEISHU_WEBHOOK_URL=<webhook>
```

不要在未确认的情况下自动发外部消息。

## 10. 最小成功口径

当以下命令成功，即可认为 Kairos lark-cli 主流程安装完成：

```bash
memoryops doctor --profile kairos-alt --chat-id <oc_xxx> --e2e
```

并且输出：

```text
ok: true
read chat messages: true
e2e chat -> memory -> workflow: true
workflow_action: push_decision_card
```


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
