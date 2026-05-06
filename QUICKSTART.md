# Kairos OpenClaw 快速接入提示词

把下面这段直接发给 OpenClaw Agent：

```text
https://github.com/CalWade/Kairos；请按 lark-cli Runtime 模式接入飞书群。

要求：
1. 拉取仓库并安装依赖。
2. 按 lark-cli 官方授权流程配置 profile，不要反复运行 lark-cli config init --new。
3. 向我索取要监听的飞书群 chat_id，以及该群自定义机器人的 webhook。
4. 运行 Kairos 接入向导，测试能否读取目标群消息和发送测试卡片。
5. 启动 Kairos Dashboard。
6. 启动 lark-runtime 监听群消息。
7. 如果缺权限、chat_id、webhook 或授权失败，停下来问我，不要自行创建多个飞书 CLI 应用。
```

## OpenClaw Agent 执行参考

```bash
git clone https://github.com/CalWade/Kairos.git
cd Kairos
npm install
npm run build

npm install -g @larksuite/cli
lark-cli auth login --recommend --profile kairos-alt

npm run setup:lark-runtime -- \
  --profile kairos-alt \
  --chat-id <oc_xxx> \
  --feishu-webhook "<目标群机器人 webhook>" \
  --test-read \
  --test-webhook

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
