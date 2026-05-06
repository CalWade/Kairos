# Kairos

> 面向飞书协作场景的长期项目记忆引擎。Kairos 读取飞书群聊中的真实协作消息，自动沉淀项目决策、风险和团队约定，并在后续讨论触及历史上下文时主动推送决策卡片。

## 一句话说明

Kairos 解决的是团队协作中的“群聊失忆”问题：已经讨论清楚的决策，几天后又被重新争论；关键理由散落在群聊里，没人能快速找到；新旧规则混在一起，容易把过期信息当成当前事实。

Kairos 把这些群聊信息转化为有状态、有证据链、可更新的长期记忆。

## 用 OpenClaw 接入

把下面这句话发给 OpenClaw Agent：

```text
https://github.com/CalWade/Kairos；请按 QUICKSTART.md 的 lark-cli Runtime 模式接入飞书群。
```

`QUICKSTART.md` 专门给 OpenClaw Agent 使用，包含完整部署、授权、接入、启动步骤。

## 本地运行

### 1. 安装

```bash
git clone https://github.com/CalWade/Kairos.git
cd Kairos
npm install
npm run build
```

### 2. 授权 lark-cli

```bash
npm install -g @larksuite/cli
lark-cli auth login --recommend --profile kairos-alt
```

授权命令需要保持运行，直到浏览器授权完成并返回成功。不要反复运行 `lark-cli config init --new`。

### 3. 接入飞书群

准备：

```text
chat_id：要监听的飞书群，例如 oc_xxx
webhook：该群自定义机器人 webhook
```

运行：

```bash
npm run setup:lark-runtime -- \
  --profile kairos-alt \
  --chat-id oc_xxx \
  --feishu-webhook "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" \
  --test-read \
  --test-webhook
```

### 4. 启动 Dashboard

```bash
npm run dashboard
```

打开：

```text
http://127.0.0.1:8787
```

### 5. 启动 Runtime

```bash
npm run lark-runtime
```

调试只跑一轮：

```bash
npm run lark-runtime:once
```

## 工作流

```text
飞书群聊
  ↓ 官方 lark-cli 读取消息
Kairos lark-cli Runtime
  ↓
会话解缠 / LLM 慢速归纳
  ↓
MemoryAtom 长期记忆
  ↓
历史决策激活
  ↓
飞书决策卡片 + Dashboard 可视化
```

## 典型演示场景

团队先在飞书群里做出决策：

```text
最终决定：复赛阶段先用 SQLite，PostgreSQL 复赛后再评估。
```

几天后有人重新提出：

```text
要不我们还是用 PostgreSQL？
```

Kairos 会自动召回此前决策，推送飞书决策卡片：

```text
历史决策：复赛阶段先使用 SQLite
当时理由：PostgreSQL 部署成本较高，可能影响评委快速运行
证据：来自此前群聊讨论
操作：确认有效 / 忽略 / 请求更新
```

## 核心能力

| 能力 | 说明 |
|---|---|
| 飞书群消息接入 | 使用官方 lark-cli 读取目标群消息 |
| 后台运行时 | `lark-runtime` 轮询新消息、去重、归纳、激活 |
| 会话理解 | 显式 thread/reply + LLM thread linking 处理交错群聊 |
| 慢速归纳 | induction queue 后台形成长期记忆，不打断群聊 |
| 结构化记忆 | MemoryAtom 保存决策、风险、约定、证据链和状态 |
| 冲突更新 | 支持 DUPLICATE / SUPERSEDE / CONFLICT_PENDING |
| 主动激活 | 后续消息触及历史决策时推送飞书卡片 |
| 反馈修正 | 支持确认、忽略、请求更新和 refine queue |
| 可视化 | Dashboard 以中文数据流展示引擎工作过程 |
| 自证评测 | 内置抗干扰、矛盾更新、召回、线程链接等评测 |

## Dashboard 展示

Dashboard 是旁路观察页面，不向群聊发送调试消息。它展示 Kairos 的真实数据流：

```text
飞书消息进入
→ 会话解缠与归纳
→ 长期记忆生成
→ 历史记忆激活
→ 反馈与修正
→ 本地评测结果
```

比赛录屏建议：左侧飞书群，右侧 Dashboard。

## 项目结构

```text
src/larkRuntime/       lark-cli Runtime Worker
src/candidate/         消息标准化、线程恢复、候选窗口、LLM thread linker
src/induction/         慢速归纳队列
src/extractor/         结构化抽取器
src/memory/            MemoryAtom、Store、Reconcile、Decision Card
src/workflow/          历史记忆 activation 和频控
src/refine/            用户反馈后的修正队列和补丁应用
src/visualization/     Dashboard
src/eval/              Benchmark runner
```

## 评测

```bash
npm run eval:core
npm run dev -- eval --suite thread-linking
npm run dev -- eval --suite llm-decision-extraction
```

评测结果会保存到 `runs/latest-eval.json`，并自动显示在 Dashboard。

## 主要文档

| 文档 | 说明 |
|---|---|
| [`docs/whitepaper.md`](./docs/whitepaper.md) | Memory 定义与架构白皮书（复赛交付物）|
| [`docs/benchmark-report.md`](./docs/benchmark-report.md) | 自证评测报告（复赛交付物）|
| [`docs/demo-script.md`](./docs/demo-script.md) | 复赛演示脚本 |
| [`QUICKSTART.md`](./QUICKSTART.md) | OpenClaw Agent 快速接入提示词 |
| [`docs/lark-cli-runbook.md`](./docs/lark-cli-runbook.md) | lark-cli 授权、群接入和排障 |
