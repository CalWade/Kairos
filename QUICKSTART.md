# Kairos OpenClaw 快速接入提示词

把下面这段直接发给 OpenClaw Agent：

```text
https://github.com/CalWade/Kairos；请按 lark-cli Runtime 模式接入飞书群。

要求：
1. 拉取仓库并安装依赖。
2. 按 lark-cli 官方授权流程配置 profile，不要反复运行 lark-cli config init --new。
3. 检查 LLM 配置：`.env` 需要包含 KAIROS_LLM_BASE_URL / KAIROS_LLM_API_KEY / KAIROS_LLM_MODEL；真实群聊解缠和慢速归纳依赖该配置。
4. 向我索取要监听的飞书群 chat_id，以及该群自定义机器人的 webhook。
5. 运行 Kairos 接入向导，测试能否读取目标群消息、发送测试卡片，并可选测试 LLM 连通性。
6. 启动 Kairos Dashboard。
7. 启动 lark-runtime 监听群消息。
8. 如果缺权限、chat_id、webhook、LLM 配置或授权失败，停下来问我，不要自行创建多个飞书 CLI 应用。
```

## OpenClaw Agent 执行参考

```bash
git clone https://github.com/CalWade/Kairos.git
cd Kairos
npm install
npm run build

npm install -g @larksuite/cli
lark-cli auth login --recommend --profile kairos-alt

npm run dev -- llm:check

npm run setup:lark-runtime -- \
  --profile kairos-alt \
  --chat-id <oc_xxx> \
  --feishu-webhook "<目标群机器人 webhook>" \
  --test-read \
  --test-webhook \
  --test-llm

# setup 会写入 .env；后续 runtime 自动读取，不需要手动 export。
npm run dashboard
npm run lark-runtime
```

## 授权注意事项

- 使用 lark-cli 官方 `auth login --recommend` 流程。
- 授权命令需要保持运行，直到浏览器授权完成并返回成功。
- 不要反复运行 `lark-cli config init --new`。
- 目标群 `chat_id` 和 webhook 必须对应同一个飞书群。
- `setup:lark-runtime` 写入 `.env` 后，`npm run lark-runtime` / `npm run lark-runtime:once` 会自动读取配置。
