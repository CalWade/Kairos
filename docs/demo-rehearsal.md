# Kairos 复赛演示录屏讲稿

> 目标：4-6 分钟 mp4，清楚呈现"问题 → 技术方案 → 实际效果 → 价值证明"。
> 评分维度映射：完整性与价值 50%（镜头 2+3）、创新性 25%（镜头 3）、技术实现 25%（镜头 4）。

## 录屏前清单

- [ ] 录屏工具准备好（QuickTime / OBS / Xnip 都行）
- [ ] 飞书客户端打开，目标群在前台
- [ ] 清空 Kairos 数据，保证干净演示：
  ```bash
  rm -f data/lark_runtime_state.json data/induction_queue.jsonl data/memory.jsonl data/memory_events.jsonl data/activation_throttle.jsonl
  ```
- [ ] 撤回群里上次 demo 留下的消息（保留带【角色】前缀的那 6 条若还在也无所谓，runtime 会去重）
- [ ] 终端字体放大到清晰可读（建议 16-18pt）
- [ ] 分屏：左 2/3 飞书群 + 右 1/3 Dashboard + 底部小窗终端；或按自己习惯布局
- [ ] 额外终端 tab 预敲好 `npm run demo:anti-interference`（镜头 3.4 用，回车即出结果）

## 镜头 1：问题定义（30s）

**画面**：打开飞书群，滚动一段真实感的历史聊天记录

**旁白**：

> 每个人都经历过这个场景——团队群里认真讨论了半天，得出决策"就用 SQLite 不要 PostgreSQL"。三天后，有人重新问一遍"咦我们最终用啥？要不换 PostgreSQL？"。人被迫再翻一次聊天记录；AI agent 接入群聊后更糟，每次对话都从零开始。
>
> 我们做的是 Kairos——一个专门解决飞书群聊失忆的长期项目记忆引擎。

**关键词**：群聊失忆 / 重复争论 / AI 每次从零

## 镜头 2：端到端 demo（2 分钟）

**画面**：分屏——左边飞书群、右边 Dashboard

### 2.1 启动（10s）

终端 A：
```bash
npm run dashboard
```

终端 B：
```bash
npm run lark-runtime
```

**旁白**：

> Kairos 常驻读群，完全不依赖飞书 API 权限申请——走官方 lark-cli。Dashboard 是只读旁路，不向群里发任何调试消息。

### 2.2 注入一场真实讨论（40s）

终端 C：
```bash
npm run demo:inject -- --script storage-decision
```

**旁白**（配合飞书群画面一条条消息弹出）：

> 我用三个不同身份的机器人模拟产品、工程A、工程B 的真实讨论。
> 【产品】说复赛 demo 环境要尽量轻...
> 【工程A】提出 PostgreSQL 会不会太重...
> 【工程B】推荐 SQLite...
> 【产品】最终拍板——复赛用 SQLite。

（等一两秒让最后的"要不我们还是用 PostgreSQL？"也发出去）

### 2.3 Kairos 的反应（40s）

**画面**：切到 Dashboard

**旁白**（对着 Dashboard 不同区块讲）：

> 看右边 Dashboard——我们设计的是"中文数据流可视化"，不是一堆 JSON 的开发者视图。
>
> - "飞书消息进入"区域显示刚才 6 条消息已经被 lark-cli 读取
> - "会话解缠"说明 heuristic 已经把 6 条归成一个话题
> - "长期记忆生成"显示刚刚产出的 MemoryAtom——类型 decision，主题数据库选型
> - 再看"历史记忆激活"—— Kairos 检测到最后一条"要不我们还是用 PostgreSQL？"是在复议一个已经拍板的决策
>
> **整轮 17 秒，就这一次真实演示**。

### 2.4 决策卡片推回现场（30s）

**画面**：切回飞书群，把刚收到的决策卡片滚到视野中心

**旁白**：

> 看飞书群——Kairos 不是把历史藏在数据库里等人查，而是把决策卡片主动推回协作现场。
>
> - 当前有效、主题、阶段
> - 决策结论
> - 理由：评委要能一键跑、SQLite 更轻
> - 被否方案：PostgreSQL，理由是部署成本高
> - 完整证据摘录：真实四条讨论原文，发言人是产品 / 工程A / 工程B，而不是某个难懂的机器人 ID
> - 确认有效 / 忽略 / 请求更新 三个反馈按钮
>
> 这张卡片不需要任何人点开聊天记录去翻，团队决策能直接复用。

## 镜头 3：创新点（1.5 分钟）

**画面**：回到 Dashboard 或显示白皮书架构图

**分 4 点讲，每点 20 秒：**

### 3.1 结构化记忆 vs 关键词搜索

> Kairos 不是"把群聊存 embedding 然后相似度搜索"。每条 decision 记忆里，我们存 decision / reasons / rejected_options / opposition / aliases / negative_keys 这些**结构化字段**。用户问"为什么不用 PostgreSQL？"能命中，不是因为"PostgreSQL"作为关键词存在，而是因为我们在抽取时就显式记录了"PostgreSQL 被否定原因"这个反向检索 key。

### 3.2 慢归纳 + 异步

> 消息进来不阻塞群聊——先进 induction queue。后台 LLM 抽取完再入库。这让 Kairos 可以容忍 LLM 延迟，群聊体验不受影响。

### 3.3 冲突更新而非覆盖

> Kairos 的记忆有状态机。"周报发给 Alice" 被 "周报发给 Bob" 覆盖时，旧记忆不是删除，是标记 superseded，历史仍可追溯。同时 Reconcile 输出 DIRECT_CONFLICT 信号，让评审人员可以复查。

### 3.4 可证明（30 秒，含现场跑一条命令）

**画面**：切到一个干净终端

**旁白**：

> 不是让评委相信"我们系统很强"——所有数字当场可跑。Kairos 带 8 套评测、36 个 benchmark case、103 个单测，全绿。

**命令**（现场敲或用预敲好的终端 tab）：

```bash
npm run demo:anti-interference
```

**画面**（0.5 秒内出结果）：

```
输入记忆候选数 : 101 条
Step 1/3  规则抽取器过滤 101 条输入 ...
          └─ 4 条 被抽取为 MemoryAtom 进入 Store
          └─ 97 条 被规则抽取器识别为噪声直接丢弃
Step 3/3  在 Store 内搜索 "为什么不用 PostgreSQL？" ...
Top-5 召回结果：  #1 🎯 目标  decision  MVP 阶段使用 SQLite...
✅ PASS  目标决策定位到 top-1
```

**旁白**（指屏幕讲）：

> 看这里——输入 101 条记忆候选。其中 97 条噪声在抽取阶段就被规则 Extractor 丢弃，根本没进 Store；剩下 4 条 MemoryAtom 里，目标决策被精准定位到第一位。这是两阶段抗干扰：不是侥幸命中，是机制兜底。
>
> 矛盾更新 4 种状态全过、操作步数从 7 步降到 2 步，这些数字在 `docs/benchmark-report.md` §7 有完整样本披露，评委可以一键 `npm run eval:core` 自己验证。

## 镜头 4：技术深度闪一下（1 分钟）

**画面**：快速切几个代码文件 + 架构图 + Dashboard 性能数字

**旁白**：

> 简单说三个工程点：
>
> 1. **双阶段判断**：80% 的噪声由启发式秒级过滤掉，只有有显著性的候选窗口才调 LLM。
> 2. **结构化抽取 prompt**：5 类 kind 边界 + 公共字段 + 专属字段，总共 861 字符系统 prompt，兼容 DeepSeek / OpenAI / 火山方舟多种 OpenAI-compatible endpoint。对 reasoning 模型还有 `thinking.disabled` 开关，延迟从 30-60 秒压到 3-5 秒。
> 3. **完整可观测**：每轮 runtime / 每条 memory / 每次 activation 都有 JSONL 事件日志，Dashboard 实时聚合展示。
>
> 总源码 7000 行 TypeScript，TypeScript strict 模式，103 测试全绿。一个人独立完成。

## 镜头 5：收尾（20s）

**画面**：回到 Dashboard 首页，让"生成时间"和评测结果区可见

**旁白**：

> 一句话——Kairos = 结构化记忆 + 慢归纳 + 主动激活。把飞书群里的项目决策沉淀成带证据、带状态、能召回、能更新的长期记忆，在团队重新讨论已决事项时，把历史决策卡片自动推回协作现场。
>
> 完整代码和文档在 GitHub： github.com/CalWade/Kairos。谢谢。

## 录制小贴士

- **不追求一镜到底**：每个镜头分段录，后期剪接
- **Dashboard 刷新停顿一秒**：Dashboard 是 2 秒 meta-refresh，等数据更新完再切镜头
- **终端命令先敲好**：用多个终端 tab，不要在录制时现场输入
- **声音**：用稿子控制节奏，避免"嗯"、"然后"、长停顿
- **时长控制**：4-6 分钟最好；超 8 分钟评委容易走神
- **格式**：1080p mp4，H.264 编码，最好 10MB 以内便于附件提交

## 演示中可能被问到的问题（留意多准备两句话）

| 问题 | 回答要点 |
|---|---|
| 这个 LLM 换成开源模型行吗？| 是 OpenAI-compatible，任何兼容 endpoint 都行，已测 DeepSeek / 火山方舟 |
| 真实用户和 bot 混着发怎么办？| 真实用户走 lark-cli 返回的 `sender.name`，bot 走【角色】前缀解析，不冲突 |
| 记忆多了怎么处理？| `review_at` 字段 + 状态机 `superseded / expired`；已实现下一步加 Ebbinghaus 复习曲线 |
| 为什么不用向量检索？| 当前优先结构化召回是因为决策类记忆要可解释、可回归测试、可审计；后续会叠加 embedding 作为二级召回层兜住 query 表述差异场景 |
| 和飞书官方智能问答有什么差异？| Kairos 是"主动激活 + 结构化决策状态管理"，不是通用问答 |
| 评测数据多少？谁标的？| 自建小样本 benchmark ~50 条，作者本人标注；不是生产级数据。硬核抗干扰的 100 条噪声也是人工构造仿真。边界披露写在 benchmark-report §7，提交时已经明确 |
| OpenClaw 在这里扮演什么角色？| Agent 宿主 + 部署控制面——负责拉仓库、构建、配 .env、运行 Dashboard 和 runtime。飞书消息接入用的是官方 lark-cli，不是 OpenClaw hook |
