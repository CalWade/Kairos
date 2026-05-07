# Kairos 录屏命令速查表

> 录屏时打开这份文档在旁边屏幕，逐段复制。所有命令已经实测过，可直接粘贴。

## 阶段 0：录屏前 5 分钟（准备环境）

### 0.1 一键重置

```bash
npm run demo:reset-recording
```

预期输出包含：
- `[1/4] ✓ 旧进程全部清除`
- `[2/4] ✓ 备份 N 个 state 文件`
- `[3/4] ✓ .env 和 data/demo-webhooks.json 都在`
- `━━━ 重置完成，可以开始录屏 ━━━`

### 0.2 飞书群准备

- 打开目标群：`oc_98ab5a7423027c683076e929949dfe06`
- **撤回上轮 demo 留下的机器人消息**（卡片 + 带【角色】前缀的 6 条）；如果忘了也没事，runtime 有去重，但画面会有历史噪声
- 滚到群底部最新消息处

### 0.3 4 个终端 tab 预敲（**不回车**）

| Tab | 命令 | 用途 |
|---|---|---|
| A | `npm run dashboard` | 启动 Dashboard 在 http://127.0.0.1:8787 |
| B | `npm run lark-runtime` | 常驻读群 + LLM 归纳 + 推卡 |
| C | `npm run demo:inject -- --script storage-decision` | 注入 6 条讨论 |
| D | `npm run demo:anti-interference` | 镜头 3.4 现场跑抗干扰 |

### 0.4 浏览器

- 打开 http://127.0.0.1:8787（Dashboard），先放着

---

## 阶段 1：录屏正式开始

### 1.1 先启动 Dashboard 和 runtime（镜头 1 之前就启）

Tab A：
```bash
npm run dashboard
```

等约 5 秒，终端输出 `"url": "http://127.0.0.1:8787"`，刷新浏览器看到页面。

Tab B：
```bash
npm run lark-runtime
```

等约 15-30 秒，看到第一个 `lark-runtime cycle` JSON 输出（通常 `new_messages: 0`），说明 runtime 已经就位。

### 1.2 录镜头 1（问题定义，30s）

按讲稿旁白。画面：飞书群 + 滚动聊天记录。

### 1.3 录镜头 2.1（启动，10s）

画面切 Tab A 和 Tab B 已经跑着的 terminal，顺带展示 Dashboard 页面。

### 1.4 录镜头 2.2（注入，40s）

Tab C 回车：
```bash
npm run demo:inject -- --script storage-decision
```

画面：飞书群 6 条消息陆续冒出来，共约 12 秒发完。**按下回车后即可开始念旁白**。

最后一条"要不我们还是用 PostgreSQL？"出现后，**等 15-25 秒**（让 runtime 完成下一轮 + LLM 抽取）。

### 1.5 录镜头 2.3（Kairos 反应，40s）

**切 Dashboard** 指着中文数据流可视化说：
- 飞书消息进入：看到 6 条新消息
- 会话解缠：1 个话题
- 长期记忆生成：decision 类型、主题数据库选型
- 历史记忆激活：命中

**查看 runtime JSONL 数字**（如果 Dashboard 更新太慢）：
```bash
tail -1 runs/lark-runtime.jsonl | python3 -m json.tool
```

### 1.6 录镜头 2.4（决策卡片，30s）

**切回飞书群**，找到 runtime 刚推的新卡片。按讲稿念卡片内容。

**兜底**：如果群里没看到新卡片（可能 activation 被 throttle 冷却），手动再发一条触发：
```bash
npm run demo:inject -- --script storage-decision --start 6 --end 6
```

等 10-20 秒再看群。

### 1.7 录镜头 3.1-3.3（创新点，1 分钟）

画面：Dashboard 或白皮书架构图。纯讲稿。

### 1.8 录镜头 3.4（现场跑抗干扰，30s）

Tab D 回车：
```bash
npm run demo:anti-interference
```

画面：0.5 秒内出结果。指着屏幕讲"101 输入 → 97 噪声被抛 → 目标 top-1"。

### 1.9 录镜头 4（技术深度，1 分钟）

画面建议：
```bash
# 快速展示代码结构
ls src/
wc -l src/**/*.ts | tail -1

# 展示 prompt 长度
wc -c < <(awk '/SYSTEM_PROMPT = /,/^\`;/' src/extractor/llmDecisionExtractor.ts)
```

或者直接把 Dashboard "本地评测结果" 区域放大。

### 1.10 录镜头 5（收尾，20s）

回到 Dashboard 首页。按讲稿念完一句话总结。

---

## 录屏后清理

### 停所有后台进程

```bash
# 停 runtime（Ctrl+C 在 Tab B）
# 停 dashboard（Ctrl+C 在 Tab A）

# 或者一键
pkill -f "lark-cli runtime"
pkill -f "tsx src/cli.ts dashboard"
```

### 验证录屏成果

录屏文件：
- 格式 mp4 / mov
- 分辨率 1080p 或更高
- 时长 4-6 分钟
- 大小最好 ≤ 10MB（便于附件直传；大文件上云盘后贴链接）

---

## 常见故障排除

| 现象 | 原因 | 解决 |
|---|---|---|
| `npm run lark-runtime` 启动后卡住无输出 | lark-cli 拉消息等待中（正常）| 等 10-30 秒看第一个 cycle |
| Dashboard 页面空白 | eval:core 还在跑 | 等 `dashboard` 脚本打出 url 再刷新 |
| 群里没有新卡片 | activation throttle 冷却 | 删 `data/activation_throttle.jsonl`，或用 `--start 6 --end 6` 重发 |
| `demo:inject` 报缺角色 webhook | `data/demo-webhooks.json` 里 key 不对 | 检查 key 是中文 `产品 / 工程A / 工程B` |
| 卡片 sender 显示 `cli_xxx` | 消息文本缺【角色】前缀 | 确认 `demo:inject` 没用 `--no-role-prefix` |
| LLM 调用超时 | 网络或 API Key | `npm run dev -- llm:check --test` 诊断 |

## 关键文件路径

- 演示讲稿：`docs/demo-rehearsal.md`
- 白皮书：`docs/whitepaper.md`
- Benchmark 报告：`docs/benchmark-report.md`
- 效能指标推导：`docs/efficiency-measurement.md`
- 提交模板草稿：`docs/submission-draft.md`
- 剧本：`examples/demo-scripts/`
