# lark-cli 适配层计划

官方公告建议涉及飞书功能打通或数据获取时优先使用官方 CLI：`https://github.com/larksuite/cli`。Kairos 后续不应重复实现飞书 OAuth 和大量 OpenAPI 封装，而应把 `lark-cli` 作为官方飞书数据获取适配层。

## 定位

```text
OpenClaw hook：实时消息入口 / Agent 编排
lark-cli：官方飞书数据获取与 API 操作
Kairos：记忆引擎 / 筛选 / 存储 / 召回 / 卡片
```

## 为什么使用 lark-cli

- 官方维护，覆盖 IM、Docs、Wiki、Sheets、Calendar、Tasks 等域；
- 自带 OAuth 登录、身份切换和权限管理；
- 输出结构化 JSON，适合 Agent 和 CLI 管道；
- 避免 Kairos 自己实现飞书 OAuth 与大量 API wrapper。

## 当前已做

新增无副作用状态检查：

```bash
memoryops lark-cli status
memoryops lark-cli status --check-auth
```

该命令只检查本机是否安装 `lark-cli`，可选检查 `auth status`，不会发起登录、不会读取飞书数据、不会写入任何外部系统。

## 后续计划

### P0：安装与授权验证

经用户确认后执行：

```bash
npm install -g @larksuite/cli
lark-cli config init --new
lark-cli auth login --recommend
lark-cli auth status
```

### P1：历史消息/文档导入

设计命令：

```bash
memoryops ingest-lark-cli --chat-id <oc_xxx> --since ...
memoryops ingest-lark-cli --doc-url <url>
```

数据流：

```text
lark-cli im/docs/wiki --format json
→ Kairos normalize
→ CandidateWindow
→ extractor
→ MemoryAtom
```

### P2：lark-event 研究

官方 CLI 提供 `lark-event` 能力，可作为 OpenClaw hook 之外的实时事件入口候选。但 Kairos 当前主线仍是 OpenClaw hook，因为更贴合 OpenClaw Memory 赛道。

## 边界

- `lark-cli` 是飞书数据与 API 适配层，不是 Memory Engine；
- Kairos 仍负责筛选、抽取、存储、召回、更新和评测；
- 授权需要用户确认权限范围，不能由 Agent 静默完成。


## 离线导入命令

授权前也可以先用文件模拟 lark-cli JSON 输出：

```bash
memoryops lark-cli ingest-file --file /tmp/lark-output.json --project kairos --write
```

该命令只读取本地 JSON 文件，不调用飞书 API。授权完成后，可以把 `lark-cli im +messages-search --format json` 或 `lark-cli docs +fetch --format json` 的输出保存为文件，再交给 Kairos 入库。


## 授权预检

真实读取前先检查 scope：

```bash
memoryops lark-cli preflight --purpose message_search
memoryops lark-cli preflight --purpose chat_messages
memoryops lark-cli preflight --purpose doc_fetch
```

如果缺少 scope，命令会输出推荐的 `lark-cli auth login --scope ...`。若租户/应用不允许授予对应权限，Kairos 仍可使用离线导入：先通过飞书导出文件或 OpenClaw 飞书工具获取数据，再交给 `memoryops lark-cli ingest-file`。
