#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kairos-demo.XXXXXX")"
DB="$TMP_DIR/memory.db"
EVENTS="$TMP_DIR/events.jsonl"
PROJECT="kairos"

cleanup() {
  if [[ "${KEEP_DEMO_DATA:-0}" != "1" ]]; then
    rm -rf "$TMP_DIR"
  else
    echo "保留 demo 数据：$TMP_DIR"
  fi
}
trap cleanup EXIT
mkdir -p "$TMP_DIR"

run_json() {
  (cd "$ROOT" && npm run -s dev -- "$@")
}

section() {
  printf '\n\033[1;36m## %s\033[0m\n' "$1"
}

extract_json_field() {
  node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { const j = JSON.parse(s); const path = process.argv[1].split("."); let v = j; for (const key of path) v = v?.[key]; if (v === undefined || v === null) process.exit(2); process.stdout.write(String(v)); });' "$1"
}

DECISION_TEXT="张三：最终决定 MVP 阶段使用 SQLite 作为当前状态库，同时保留 JSONL Event Log。王五：PostgreSQL 对复赛 demo 来说部署成本太高，容易让评委跑不起来。"
RISK_TEXT="生产环境不允许前端直连 API Key，必须走服务端代理，否则密钥泄露风险太高。"

section "1. 抽取并写入项目决策"
DECISION_JSON="$(run_json extract-decision --project "$PROJECT" --write --db "$DB" --events "$EVENTS" --text "$DECISION_TEXT")"
DECISION_ID="$(printf '%s' "$DECISION_JSON" | extract_json_field saved.id)"
printf '写入决策记忆：%s\n' "$DECISION_ID"

section "2. 反向召回：为什么不用 PostgreSQL？"
run_json recall --project "$PROJECT" --db "$DB" --events "$EVENTS" "为什么不用 PostgreSQL？" \
  | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => console.log(JSON.parse(s).answer));'

section "3. 历史决策卡片"
run_json decision-card "$DECISION_ID" --db "$DB" --events "$EVENTS"

section "4. 矛盾更新：周报接收人 Alice → Bob"
run_json ingest --project "$PROJECT" --db "$DB" --events "$EVENTS" --text "以后周报每周五发给 Alice。" >/dev/null
run_json ingest --project "$PROJECT" --db "$DB" --events "$EVENTS" --text "不对，周报以后发给 Bob，Alice 不再负责这个了。" >/dev/null
run_json search "周报" --project "$PROJECT" --include-history --db "$DB" --events "$EVENTS" \
  | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { const j = JSON.parse(s); for (const m of j.results) console.log(`${m.status}\t${m.content}`); });'

section "5. 到期提醒：风险记忆 review_at"
RISK_JSON="$(run_json extract-decision --project "$PROJECT" --write --db "$DB" --events "$EVENTS" --text "$RISK_TEXT")"
RISK_ID="$(printf '%s' "$RISK_JSON" | extract_json_field saved.id)"
printf '写入风险记忆：%s\n' "$RISK_ID"
run_json remind --project "$PROJECT" --now "2099-01-01T00:00:00.000Z" --db "$DB" --events "$EVENTS" \
  | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { const j = JSON.parse(s); console.log(`到期提醒数：${j.total}`); for (const r of j.reminders) console.log(`${r.id}\t${r.subject}\t${r.review_at}`); });'

section "6. 核心评测"
run_json eval --core \
  | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { const j = JSON.parse(s); for (const r of j.results) console.log(`${r.suite}: ${r.passed}/${r.total} passed`); });'

section "Demo 完成"
echo "说明：这是本地 CLI 可运行闭环；飞书交互式卡片和提醒推送尚未实现。"
