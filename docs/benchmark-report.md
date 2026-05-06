# Kairos Benchmark Report

> 对齐赛题三类强制测试：抗干扰、矛盾更新、效能指标；另补充真实飞书群端到端实测和 LLM 质量对比。

## 0. 一眼总结

| 指标 | 数字 |
|---|---|
| 本地 eval 通过率 | **103/103**（30 测试文件 / 8 套 benchmark suite） |
| 端到端真实群单轮延迟 | **17 秒**（6 条消息进 / 1 张决策卡片出） |
| 抗干扰召回 F1 | **1.0** |
| 矛盾更新状态机正确率 | **4/4** |
| LLM thread linking F1 | **1.000**（vs heuristic 0.524） |
| LLM 决策抽取 5 类全覆盖 | **4/4 kind 边界通过** |
| 操作步数节省 | **-71.4%**（7 步 → 2 步） |
| 额外输入字符节省 | **-100%**（42 字 → 0 字） |

## 1. 评测命令

```bash
# 核心 6 套（decision-extraction / conflict-update / recall / anti-interference / remind / feishu-workflow）
npm run eval:core

# LLM 相关 2 套（真实调用模型）
npm run dev -- eval --suite thread-linking
npm run dev -- eval --suite llm-decision-extraction
```

`eval:core` 结果保存到 `runs/latest-eval.json`，自动显示在 Dashboard 的「本地评测结果」区块。

## 2. 核心评测覆盖

| Suite | 用例数 | 通过率 | 目标 |
|---|---:|---:|---|
| decision-extraction | 17 | 17/17 | 结构化抽取决策、风险、约定、工作流和 none |
| conflict-update | 4 | 4/4 | 新旧记忆冲突时保留历史并更新当前值 |
| recall | 5 | 5/5 | 问题能召回正确历史决策和理由 |
| anti-interference | 3 | 3/3 | 多条干扰记忆下仍命中目标记忆 |
| remind | 2 | 2/2 | 风险记忆 review_at 到期提醒 |
| feishu-workflow | 4 | 4/4 | 飞书消息 activation / 误触发控制 / 斜杠命令忽略 |
| thread-linking | 3 | 3/3 | 启发式 vs LLM thread linking F1 对比 |
| llm-decision-extraction | 4 | 4/4 | LLM 结构化抽取全 kind 覆盖 + fallback/degraded |

**Vitest 总计**：30 测试文件 / 103 case 全绿（2026-05-07 最新结果）。

## 3. 比赛要求映射

### 3.1 抗干扰测试

**测试目标**：在注入大量无关/相似记忆后，仍能精准召回目标历史决策。

**测试设计**（`src/eval/runner.ts::runAntiInterferenceEval`）：

1. 向 Store 注入 3+ 条干扰记忆：
   - hooks 路径错误（技术支持类）
   - 周报安排（convention 类）
   - API Key 轮换（risk 类）
2. 注入目标决策："复赛阶段使用 SQLite，不使用 PostgreSQL"
3. 发起查询："为什么不用 PostgreSQL？"

**结果**：

- **F1 = 1.0**：命中目标决策
- 未误命中 hooks / 周报 / API Key 等干扰项
- 召回机制：`aliases: [SQLite, PostgreSQL, Store 层, 本地存储]` + `negative_keys: [为什么不用 PostgreSQL, PostgreSQL 被否定原因]`

### 3.2 矛盾更新测试

**测试目标**：输入冲突指令后，当前记忆被更新，旧记忆进入历史状态，时序可追溯。

**测试设计**：

```text
T1: "以后周报每周五发给 Alice。"          → 写入 MemoryAtom{subject: 周报接收人, value: Alice, status: active}
T2: "不对，周报以后发给 Bob，Alice 不再负责这个了。"  → Reconcile 产出 DIRECT_CONFLICT
```

**结果**：

| 维度 | 值 |
|---|---|
| 当前 active 记忆 | Bob |
| 旧 Alice 记忆 status | superseded |
| conflict_relation | DIRECT_CONFLICT |
| 历史可追溯 | ✅ `memoryops list --with-history` 可见 |
| `superseded_by` 指针 | Bob 记忆 id |

Reconcile 4 个动作全覆盖：ADD / DUPLICATE / SUPERSEDE / CONFLICT_PENDING。

### 3.3 效能指标

历史决策复议场景中，Kairos 对比手工流程：

| 指标 | 手工流程 | Kairos |
|---|---:|---:|
| 找到历史决策所需操作步数 | 约 7 步（切换群 → 搜索 → 翻聊天 → 确认时间 → 复制结论 → 回到讨论 → 粘贴）| **约 2 步**（看卡片 → 确认）|
| 用户额外输入字符 | 约 42 字（搜索关键词 + 格式化结论）| **0 字**（Kairos 自动推送）|
| 是否自动把历史决策推回协作现场 | 否 | **是** |

**操作步数降低 71.4%，额外输入字符降低 100%**。

## 4. 真实飞书群端到端实测（2026-05-07 凌晨）

### 4.1 场景

`demo-inject.mjs` 剧本 `storage-decision` 经 3 个独立机器人 webhook 注入到真实飞书群（chat_id `oc_98ab5a...`），模拟产品 / 工程A / 工程B 三人讨论：

```text
【产品】复赛 demo 的环境要尽量轻，评委最好能一键跑起来。
【工程A】PostgreSQL 会不会太重？本地部署和初始化都麻烦。
【工程B】SQLite + JSONL 更轻，也适合 OpenClaw 插件分发。
【产品】最终决定：复赛阶段先用 SQLite，PostgreSQL 复赛后再评估。
【工程A】收到，下午把 Store 层切到 SQLite。
【工程B】要不我们还是用 PostgreSQL？   ← 复议触发点
```

### 4.2 Runtime cycle 指标（实测）

| 阶段 | 数值 | 说明 |
|---|---:|---|
| `fetched` | 6 | lark-cli 读回的消息数 |
| `new_messages` | 6 | 去重后的新消息 |
| `enqueued` | 3 | 进入 induction queue 的候选窗口 |
| `induction_processed` | 1 | 成功完成 LLM 抽取的 job |
| `activations.push_decision_card` | 4 | 激活命中"历史决策复议"的次数 |
| `sent_total` | 1 | 经 throttle 冷却后实际推卡次数 |
| `errors` | 0 | 零错误 |
| **单轮总延迟** | **17 秒** | 含所有 LLM 调用、网络 IO、store 写入 |

### 4.3 生成的 MemoryAtom

```json
{
  "id": "mem_27bdeb757fdf5310",
  "type": "decision",
  "subject": "数据库选型：PostgreSQL vs SQLite",
  "content": "复赛阶段使用 SQLite...",
  "status": "active",
  "confidence": 0.89,
  "source": {
    "channel": "feishu",
    "source_type": "feishu_message",
    "excerpt": "产品：复赛 demo 的环境要尽量轻...\n工程A：PostgreSQL 会不会太重？本地部署和初始化都麻烦。\n工程B：SQLite + JSONL 更轻...\n产品：最终决定：复赛阶段先用 SQLite...",
    "chunk_ids": ["om_x100b50829d5e88a0b321eced4016d91", "om_x100b50829c18c130b39cedd489ab51f", ...]
  },
  "metadata": {
    "raw_extraction": {
      "rejected_options": [{ "option": "PostgreSQL", "reason": "部署成本较高，复赛环境要轻量" }],
      "aliases": ["SQLite", "PostgreSQL", "本地存储", "Store 层"],
      "negative_keys": ["为什么不用 PostgreSQL"]
    }
  }
}
```

### 4.4 推回群的决策卡片

```
[历史决策卡片：数据库选型：PostgreSQL vs SQLite]

状态：当前有效
主题：数据库选型：PostgreSQL vs SQLite
阶段：复赛

决策
复赛阶段使用 SQLite，不使用 PostgreSQL

理由
- PostgreSQL 部署成本较高，复赛环境要轻量
- 评委最好能一键跑起来
- SQLite + JSONL 适合 OpenClaw 插件分发

被否方案
- PostgreSQL：部署成本较高，复赛环境要轻量

证据
来源：feishu/feishu_message
摘录：产品：复赛 demo 的环境要尽量轻... / 工程A：PostgreSQL 会不会太重？...

[确认有效] [忽略] [请求更新]
Memory ID: mem_27bdeb757fdf5310
```

## 5. LLM 质量对比

### 5.1 Thread linking

8 条交错消息的三种形态（穿插主题、显式 reply、非连续话题回归）：

| 方法 | 平均 F1 | 单次耗时 | 备注 |
|---|---:|---:|---|
| heuristic（时间窗 + 显式 reply）| 0.524 | <100ms | 对非连续话题回归 F1=0.0 |
| LLM thread linking | **1.000** | 3-8s | 覆盖所有 3 种场景 |

收益：**+47.6 pp**，适合用在 induction queue 慢归纳路径。

### 5.2 LLM 决策抽取

4 套代表性用例，全过：

| 用例 | 期望 kind | 实际 kind | 正确 |
|---|---|---|---|
| `llm_decision_storage_natural_001` | decision | decision | ✅ |
| `llm_risk_api_key_001` | risk | risk | ✅ |
| `llm_workflow_export_001` | workflow | workflow | ✅ |
| `llm_none_unresolved_001` | none | none | ✅ |

每 case `attempts=1 truncated=False degraded=False`，无需 fallback，无 timeout。

## 6. 性能演进

| 版本 | 单轮 runtime 延迟 | 关键改动 |
|---|---:|---|
| v0 (ark thinking model, 串行, 1507 char prompt) | **93s** | 初始版本 |
| v1 (换 deepseek-v4-flash) | **47s** | 换 endpoint |
| v2 (瘦身 prompt -43% + induction 并行 + thinking.disabled 开关) | **17s** | 本版本（2026-05-07） |

单轮性能**提升 5.5 倍**。

## 7. 结果解释边界

- 本地 benchmark 是可复现自测，不等同于生产大规模线上评测
- `thread-linking` 中的 silver set 不等同于人工 gold label
- LLM 路径全部保留 timeout / fallback / degraded 记录，可审计
- 飞书群端到端以真实 `lark-cli +chat-messages-list` 读取和真实 webhook 推卡为准
- 3 个 webhook 机器人共享同一 `app_id`，故用【角色】前缀承载 sender 信号；真实用户不受影响，走飞书 API 的 `sender.name`

## 8. 重现实验

```bash
# 1. 配置 LLM
cat > .env <<EOF
KAIROS_PROJECT=kairos
KAIROS_LARK_PROFILE=kairos-alt
KAIROS_CHAT_ID=oc_xxx
KAIROS_FEISHU_WEBHOOK_URL=https://...
KAIROS_LLM_BASE_URL=https://...openai-compatible.../v1
KAIROS_LLM_API_KEY=sk-xxx
KAIROS_LLM_MODEL=...
EOF

# 2. 装依赖、构建
npm install && npm run build

# 3. 跑所有 eval
npm run eval:core
npm run dev -- eval --suite thread-linking
npm run dev -- eval --suite llm-decision-extraction

# 4. 启动 Dashboard + runtime（双端演示）
npm run dashboard        # 终端 1
npm run lark-runtime     # 终端 2

# 5. 注入 demo 消息
npm run demo:inject -- --script storage-decision
```
