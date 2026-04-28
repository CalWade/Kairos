#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kairos-feishu-workflow.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
DB="$TMP_DIR/memory.db"
EVENTS="$TMP_DIR/events.jsonl"
TEXT_DECISION="张三：最终决定 MVP 阶段使用 SQLite 作为当前状态库，同时保留 JSONL Event Log。王五：PostgreSQL 对复赛 demo 来说部署成本太高，容易让评委跑不起来。"
TEXT_MESSAGE="要不我们还是用 PostgreSQL？"
cd "$ROOT"
npm run -s dev -- extract-decision --project kairos --write --db "$DB" --events "$EVENTS" --text "$TEXT_DECISION" >/dev/null
echo "## 模拟飞书入站消息"
echo "$TEXT_MESSAGE"
echo
npm run -s dev -- feishu-workflow --project kairos --db "$DB" --events "$EVENTS" --text "$TEXT_MESSAGE" \
  | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { const j = JSON.parse(s); console.log(`action: ${j.action}`); console.log(`reason: ${j.reason}`); console.log(`memory_id: ${j.memory_id}`); console.log(`has_card: ${Boolean(j.card)}`); });'
