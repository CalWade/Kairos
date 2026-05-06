# Kairos 白皮书

> 面向飞书 + OpenClaw 的企业级项目决策记忆引擎。从真实群聊中提取结构化记忆，在后续讨论触及历史决策时主动推送证据卡片。

对应赛题：**飞书 OpenClaw 赛道 · 题二（企业级记忆引擎的构造与应用），方向 B：飞书项目决策与上下文记忆**。

---

## 1. 挑战一：重新定义"记忆"（Define it）

### 1.1 问题定义

AI Agent 和团队都面临同一个现象——**群聊失忆**：

- "之前是不是讨论过 PostgreSQL？最终决定用哪个？" — 翻聊天记录半小时找不到
- 三天前讨论好的决策今天又被同事重新问一遍
- 新同事加入时，过去积累的规则、风险、约定散落无处可查
- AI 助手接入群聊后每次"从零开始"，无法复用历史上下文

### 1.2 Kairos 的记忆定义

不是把所有消息都记下来——**记住的必须是有长期复用价值的结构化信息**。Kairos 定义 4 类 + 1 个拒绝类：

| kind | 含义 | 示例 |
|---|---|---|
| **decision** | 项目决策、理由、反对意见、结论、阶段 | 复赛阶段使用 SQLite，不使用 PostgreSQL |
| **convention** | 团队约定、负责人、周期规则 | 周报以后发给 Bob，每周五 |
| **risk** | 安全 / 稳定性 / 交付风险 | 预览测试需独立 IP，否则中文乱码 |
| **workflow** | 可复用操作步骤和命令序列 | 提交前必须跑 `npm run eval:core` |
| **none** | 未定问题、复议、闲聊、状态同步 | "收到"、"辛苦了" |

这 5 类共同构成**记忆提取的判别空间**。LLM 按这个分类边界做结构化抽取，`reject_reason` 字段记录为什么判为 none，便于审计。

### 1.3 为什么这种记忆对企业有价值

- **结构化而非"文本搜索"**：不是"在 100 条消息里找关键词"，而是直接给出"决策是什么、理由是什么、被否方案是什么、当前是否有效"
- **带证据链**：每条记忆关联原始飞书 `message_id`，可回溯
- **有状态机**：`active / superseded / expired / conflict_pending`，自然表达"这条约定已经过期"
- **可主动激活**：后续讨论触及历史决策时，不是"等人去查"，而是 AI 自动把上下文推回现场

---

## 2. 挑战二：构建记忆引擎（Build it）

### 2.1 架构：飞书群 → Kairos → 飞书群

```
┌─────────────────────────────────────────────────────────────────────┐
│  飞书群聊                                                            │
│  产品："最终决定复赛用 SQLite"    工程B："要不我们还是用 PostgreSQL？"│
└────────────┬────────────────────────────────────┬──────────────────┘
             │                                    │
             ▼                                    ▲
  ┌──────────────────────┐              ┌──────────────────────┐
  │ lark-cli (官方)       │              │ 飞书 Bot Webhook      │
  │ +chat-messages-list   │              │ 决策卡片推送          │
  └──────────┬───────────┘              └──────────▲───────────┘
             │                                      │
             ▼                                      │
  ┌──────────────────────────────────────────────────────────┐
  │ Kairos lark-runtime Worker（常驻）                         │
  │                                                           │
  │  ① NormalizedMessage  ← 适配、去重、过滤撤回占位            │
  │  ② 会话解缠 ← 启发式线程 + LLM thread linker（可降级）     │
  │  ③ 候选窗口 ← 显著性评分、决策 cue 检测                     │
  │  ④ Induction Queue ← 慢归纳队列（并行处理）                │
  │  ⑤ LLM 结构化抽取 ← 5 类 kind 判别 + JSON 输出             │
  │  ⑥ Reconcile ← ADD / DUPLICATE / SUPERSEDE / CONFLICT    │
  │  ⑦ MemoryAtom Store ← JSONL / SQLite 双后端               │
  │  ⑧ Activation ← 历史决策激活 + 频控                        │
  │  ⑨ Decision Card ← 飞书 interactive payload                │
  └──────────────────────────────────────────────────────────┘
             │                                      ▲
             ▼                                      │
  ┌──────────────────────────────────────────────────────────┐
  │ Dashboard（只读旁路）http://127.0.0.1:8787                │
  │ 展示 5 阶段数据流 + 实时指标 + 本地评测结果                │
  └──────────────────────────────────────────────────────────┘
```

### 2.2 MemoryAtom — 基础记忆单元

```typescript
type MemoryAtom = {
  id: string;
  type: "decision" | "convention" | "risk" | "workflow" | "knowledge";
  scope: "personal" | "team" | "org";
  project?: string;
  subject: string;
  content: string;

  // 时间与状态
  created_at: string;
  valid_at: string;
  invalid_at?: string;
  status: "active" | "superseded" | "expired" | "conflict_pending";

  // 置信度与重要性
  confidence: number;
  importance: 1 | 2 | 3 | 4 | 5;

  // 证据链
  source: {
    channel: "feishu" | "cli" | "openclaw" | "manual";
    source_type: string;
    excerpt: string;
    chunk_ids?: string[];      // 原始飞书 message_id，可回溯
  };

  // 关系
  supersedes?: string[];        // 替代哪些旧记忆
  superseded_by?: string;       // 被哪条新记忆替代

  // 结构化元数据（决策理由、反对意见、别名、反向检索 key 等）
  metadata?: { raw_extraction?: unknown };
};
```

### 2.3 决策类记忆的结构化细节

不是简单的一句话摘要，而是完整的"决策证据图"：

```typescript
type DecisionExtraction = {
  kind: "decision";
  topic: string;                                 // 复赛数据库选型
  decision: string;                              // 使用 SQLite
  options_considered: string[];                  // [SQLite, PostgreSQL]
  reasons: string[];                             // [部署轻, 评委易跑]
  rejected_options: { option: string; reason: string }[];  // PostgreSQL / 太重
  opposition: { speaker?: string; content: string }[];     // 谁反对过
  conclusion: string;                            // 复赛阶段先用 SQLite
  stage?: string;                                // 复赛
  aliases: string[];                             // [本地存储, Store 层, 数据库选型]
  negative_keys: string[];                       // [为什么不用 PostgreSQL]
  evidence_message_ids: string[];
  confidence: number;
};
```

**`aliases` + `negative_keys` 是召回的关键设计**：后续有人问"为什么不用 PostgreSQL？"能直接命中这条决策，因为 `negative_keys` 里显式记录了"被否定的 query 形态"。

### 2.4 五大能力闭环

| 能力 | Kairos 实现 | 关键模块 |
|---|---|---|
| **提取** | lark-cli 读真实群消息 → 线程化 → LLM 结构化抽取 | `src/larkRuntime/worker.ts`, `src/extractor/llmDecisionExtractor.ts` |
| **存储** | MemoryAtom JSONL / SQLite 双后端；Event Log 可审计 | `src/memory/store.ts`, `src/memory/jsonlStore.ts`, `src/memory/eventLog.ts` |
| **检索** | 关键词 + alias/negative_keys + 启发式 score | `src/memory/store.ts::search`, `src/workflow/feishuWorkflow.ts` |
| **更新** | Reconcile 区分 ADD / DUPLICATE / SUPERSEDE / CONFLICT_PENDING | `src/memory/reconcile.ts` |
| **遗忘** | 状态机 `active→superseded→expired`；`review_at` 提醒 | `src/memory/atom.ts::transitionStatus` |

### 2.5 CLI + 飞书无缝流转

- **CLI 入口**：`memoryops` 命令支持 `add` / `search` / `recall` / `supersede` / `extract-decision` / `ingest-chat` 等；所有操作对同一 Store 生效
- **飞书入口**：`lark-runtime` 常驻读群；触发激活后通过自定义机器人 webhook 把决策卡片推回群；Dashboard 旁路观察

---

## 3. 挑战三：证明它的价值（Prove it）

### 3.1 端到端真实验证（2026-05-07 凌晨实测）

**场景**：飞书群 3 个机器人角色模拟"产品 / 工程A / 工程B"讨论数据库选型

```
【产品】复赛 demo 的环境要尽量轻，评委最好能一键跑起来。
【工程A】PostgreSQL 会不会太重？本地部署和初始化都麻烦。
【工程B】SQLite + JSONL 更轻，也适合 OpenClaw 插件分发。
【产品】最终决定：复赛阶段先用 SQLite，PostgreSQL 复赛后再评估。
【工程A】收到，下午把 Store 层切到 SQLite。
【工程B】要不我们还是用 PostgreSQL？   ← 复议触发点
```

**Kairos 自动完成**：
1. 6 条消息被 lark-cli 读取（2-3s）
2. heuristic threading 归成 1 个数据库选型话题
3. LLM 结构化抽取产出 decision MemoryAtom（subject: "数据库选型：PostgreSQL vs SQLite"）
4. 第 6 条"要不我们还是用 PostgreSQL？"被 `hasStrongDecisionCue` 识别为**复议触发**
5. 经 ActivationThrottle 冷却检查后，webhook 推历史决策卡片回群
6. 卡片含：当前状态、主题、决策、理由、被否方案、完整证据摘录

**端到端单轮总耗时：17 秒**（含 2 次 LLM 调用）

### 3.2 自证评测（8 套 suite，103 测试全绿）

| Suite | 用例数 | 覆盖维度 |
|---|---:|---|
| decision-extraction | 17 | decision/convention/risk/workflow/none 5 类边界 |
| conflict-update | 4 | SUPERSEDE / CONFLICT_PENDING 状态机 |
| recall | 5 | 决策召回、理由召回、alias 召回 |
| anti-interference | 3 | 多干扰记忆中精准命中目标决策 |
| remind | 2 | 风险记忆 review_at 到期提醒 |
| feishu-workflow | 4 | activation / 噪声忽略 / 斜杠命令跳过 |
| thread-linking | 3 | 启发式 vs LLM thread linking 对比 F1 |
| llm-decision-extraction | 4 | LLM 结构化抽取全 kind 覆盖 |

### 3.3 关键数字（对齐复赛 3 类测试）

#### 抗干扰测试

向 Store 注入 hooks 错误、API Key 轮换、周报安排等干扰记忆后，查询"为什么不用 PostgreSQL？"

- **F1 = 1.0**（命中目标决策，不误命中干扰项）
- 召回机制：alias `PostgreSQL` + negative_key `为什么不用 PostgreSQL`

#### 矛盾更新测试

```
输入 1：以后周报每周五发给 Alice。
输入 2：不对，周报以后发给 Bob，Alice 不再负责这个了。
```

Reconcile 自动产生：
- 当前 active = Bob
- 旧记忆 status = superseded
- conflict_relation = DIRECT_CONFLICT
- 历史仍可追溯（`list --with-history`）

#### 效能指标验证

历史决策复议场景中，Kairos 对比手工流程：

| 指标 | 手工流程 | Kairos |
|---|---:|---:|
| 找到历史决策所需操作步数 | 约 7 步 | **约 2 步** |
| 用户额外输入字符 | 约 42 字 | **0 字** |
| 是否自动把上下文推回现场 | 否 | **是** |

**操作步数降低 71.4%，额外输入降低 100%**。

#### Thread Linking 质量

在同一批飞书消息上对比：

| 方法 | 平均 F1 | 耗时 |
|---|---:|---:|
| heuristic（时间窗 + 显式 reply）| 0.524 | <100ms |
| LLM thread linking | **1.000** | 3-8s/次 |

收益：+47.6 个百分点。

---

## 4. 创新亮点

### 4.1 慢归纳（Slow Induction）而非实时抽取

消息进入 → 写入 induction queue → **异步**做 LLM 抽取。不阻塞群聊、不挤占实时流量、对 LLM 延迟容忍。Queue 里的 job 状态可见、可重试、可审计。

### 4.2 双阶段判断（heuristic + LLM）

- **启发式**：便宜、确定性、秒内完成。处理 80% 的"明显不需要记忆"场景（闲聊、确认语、斜杠命令）
- **LLM**：只在 heuristic 信号不足但 salience 够高的候选窗口上调用。平均一次 cycle 只需 1-3 次 LLM 调用

### 4.3 召回结构化而非向量检索

不依赖 embedding 服务。用：
- `alias[]` 记录"同一事物的不同称呼"
- `negative_keys[]` 记录"这个决策会被以什么形式的反向 query 触发"
- `hasStrongDecisionCue` 门槛函数防止误激活

好处：**可解释、可回归测试、无外部依赖、无 token 成本**。

### 4.4 ActivationThrottle 频控

同一 memory 在同一群的推送有冷却（默认 15 分钟），避免重复打扰。冷却记录 JSONL 持久化，Dashboard 可见。

### 4.5 OpenClaw 原生接入

- `openclaw.setup.json` 描述完整安装流程
- `hooks/` 目录下有 OpenClaw hook pack
- Agent 宿主只需 `git clone` + `npm install` + `npm run build` + 授权 `lark-cli` 即可运行

### 4.6 白皮书 + Dashboard + Benchmark 三位一体可证明

评委不需要读完全部代码。三层视图：
- **白皮书** 讲设计
- **Dashboard** 讲运行中状态
- **Benchmark Report** 讲数字

---

## 5. AI 工程化深度

### 5.1 模型选型

- **主路径**：OpenAI-compatible API，默认接入 DeepSeek-v4-Flash（延迟稳定、结构化输出可靠）
- **兼容**：任何 OpenAI-compatible endpoint，包括火山方舟 Doubao 系列
- **reasoning 模型适配**：`KAIROS_LLM_DISABLE_THINKING=1` 开关，对 Doubao-Thinking 等 reasoning 模型能把单次延迟从 30-60s 压到 3-5s

### 5.2 Prompt 工程

- System prompt 从 1507 字符瘦身到 861 字符（-43%），保证类型边界 + 字段枚举完整
- 字段名约束显式化（`message_ids` 而非 `messages`），对齐 JSON Schema
- normalizer 兼容常见别名字段（messages / theme / msg_ids），防 silent degrade

### 5.3 错误处理与降级

- **LLM timeout**：90s abort，走 heuristic 兜底
- **LLM 响应非 JSON**：记录 `degraded: true`，保留 error，不影响主流程
- **Fallback 链**：LLM thread link → heuristic thread → 单消息窗口

### 5.4 并发与性能

- Induction queue 内部并行：3 个 pending job 的 LLM 调用 `Promise.all`
- Reconcile / 写 store 仍串行，避免 JSONL 文件并发撕裂
- 单轮 runtime cycle 从 93s 优化到 17s（瘦身 prompt + 并行 + 换 endpoint）

### 5.5 可观测性

- `runs/lark-runtime.jsonl` 每轮 cycle 记录 fetched/new/enqueued/induction/activations/sent/errors
- `data/memory_events.jsonl` 记录 ADD / SUPERSEDE / CONFLICT 全部状态变更
- `data/induction_queue.jsonl` 记录 enqueue / done / failed 事件
- `data/activation_throttle.jsonl` 记录每次卡片推送和冷却判定
- Dashboard 聚合以上 5 类数据，中文数据流可视化

---

## 6. 当前边界（诚实披露）

| 能力 | 当前状态 | 下一步 |
|---|---|---|
| LLM 决策抽取 | 主路径，4/4 LLM eval 通过 | 扩大评测集到 50+ case |
| 飞书卡片按钮回传 | 卡片已推送，按钮静态 | 接 Feishu 事件回调服务，打通 RefineQueue |
| Dashboard 实时推送 | meta-refresh 2s 刷新 | 升级 SSE |
| 全局消息搜索 | 未接入（`search:message` scope 可选）| 主 demo 按 chat_id 读群，不阻塞 |
| 记忆遗忘曲线 | `review_at` + 状态机 | Ebbinghaus 复习提醒 |
| 多群路由 | 单群 `KAIROS_CHAT_ID` | 多 chat_id 并发监听 |

---

## 7. 交付物清单（对齐赛题要求）

| 要求 | 位置 |
|---|---|
| Memory 定义与架构白皮书 | 本文档 `docs/whitepaper.md` |
| 可运行 Demo | `npm run dashboard` + `npm run lark-runtime` + `npm run demo:inject` |
| 自证评测报告 | `docs/benchmark-report.md` + `runs/latest-eval.json` |
| 抗干扰测试 | `eval --suite anti-interference` |
| 矛盾更新测试 | `eval --suite conflict-update` |
| 效能指标 | 本文档 §3.3 + `docs/benchmark-report.md` §2.3 |

---

## 8. 一句话总结

> **Kairos = 结构化记忆 + 慢归纳 + 主动激活**：把飞书群聊里的项目决策沉淀为带证据链、带状态、可召回、可更新的 MemoryAtom，在团队重新讨论已决事项时，把历史决策卡片自动推回协作现场。

---

## 附录：关键源码导航

| 组件 | 位置 | 行数 |
|---|---|---:|
| lark-runtime 主 worker | `src/larkRuntime/worker.ts` | 246 |
| 官方 lark-cli 适配器 | `src/larkCliAdapter.ts` | 396 |
| LLM 决策抽取器 | `src/extractor/llmDecisionExtractor.ts` | 369 |
| LLM thread linker | `src/candidate/llmThreadLinker.ts` | 144 |
| MemoryAtom Store | `src/memory/store.ts` | 365 |
| Reconcile 逻辑 | `src/memory/reconcile.ts` | 129 |
| 飞书决策卡片渲染 | `src/memory/decisionCard.ts` | 231 |
| 飞书工作流（激活判断）| `src/workflow/feishuWorkflow.ts` | 145 |
| ActivationThrottle | `src/workflow/activationThrottle.ts` | 77 |
| Dashboard 可视化 | `src/visualization/dashboard.ts` | 321 |
| 评测 runner | `src/eval/runner.ts` | 284 |
| CLI 入口 | `src/cli.ts` | 1525 |

Kairos 总 src ~7000 行 TypeScript + 测试 ~1900 行 Vitest，共 ~9000 行，103 case 全绿。
