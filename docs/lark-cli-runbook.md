# Kairos lark-cli 全流程 Runbook

目标：用官方 `lark-cli` 作为飞书数据入口，让用户从安装到真实群消息跑通尽量少踩坑。

## 1. 安装

```bash
npm install -g @larksuite/cli
lark-cli --version
```

## 2. 创建独立 profile

```bash
lark-cli config init --new --name kairos-alt
lark-cli auth login --recommend --profile kairos-alt
lark-cli auth status --profile kairos-alt
```

不要把密码、验证码、App Secret 发给 Agent。CLI 会给浏览器链接，用户自己确认即可。

## 3. 预检权限

```bash
memoryops lark-cli status --check-auth --profile kairos-alt
memoryops lark-cli preflight --purpose chat_messages --profile kairos-alt
```

`chat_messages` 需要 `im:message.group_msg:get_as_user`。全局搜索 `message_search` 还需要 `search:message`，不是主路径。

## 4. 找群或直接使用 chat_id

有 chat_id 时直接用：

```bash
memoryops lark-cli ingest-chat   --chat-id oc_xxx   --profile kairos-alt   --project kairos   --write
```

没有 chat_id 时用群名搜索：

```bash
lark-cli im +chat-search --query <群名关键词> --format json --profile kairos-alt
```

## 5. 一键端到端验证

```bash
memoryops lark-cli e2e-chat   --chat-id oc_xxx   --profile kairos-alt   --project kairos   --trigger-text "要不我们还是用 PostgreSQL？"
```

预期：

```json
{
  "ok": true,
  "read_total": 14,
  "saved_total": 1,
  "workflow": {
    "action": "push_decision_card"
  }
}
```

## 6. 降级方案

- 如果缺少 `search:message`：不用全局搜索，按群 `chat_id` 读取。
- 如果无法授权群消息读取：使用飞书导出文件或 OpenClaw 飞书工具获取 JSON/Markdown，再走 `ingest-file` 或 `segment-chat-export`。
- 如果卡片发送不可用：先输出 card payload，不自动发送。
