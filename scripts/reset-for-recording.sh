#!/usr/bin/env bash
# 录屏前一键重置：停旧进程 → 清 state → 启动 Dashboard + runtime
# 跑完后，直接开始录屏即可。

set -uo pipefail  # 不用 -e，避免 pkill / ps 非零退出把脚本打断

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "━━━ Kairos 录屏环境重置 ━━━"
echo

# 1. kill 旧进程（Dashboard + lark-runtime）
echo "[1/4] 停止旧进程..."
kill_by_pattern() {
  local pattern="$1"
  local pids
  pids=$(ps ax | grep -E "$pattern" | grep -v grep | awk '{print $1}')
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill 2>/dev/null
  fi
}
kill_by_pattern "lark-cli runtime"
kill_by_pattern "tsx src/cli.ts dashboard"
sleep 1
remaining=$(ps ax | grep -E "lark-cli runtime|tsx src/cli.ts dashboard" | grep -v grep | wc -l | tr -d ' ')
if [[ "$remaining" == "0" ]]; then
  echo "  ✓ 旧进程全部清除"
else
  echo "  ⚠ 还有 $remaining 个残留进程，可能需要手动 kill"
fi
echo

# 2. 备份并清空 state / 队列 / 日志
echo "[2/4] 备份并清空 state..."
stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="runs/archive/demo-state-$stamp"
mkdir -p "$backup_dir"

files=(
  data/memory.jsonl
  data/memory_events.jsonl
  data/induction_queue.jsonl
  data/refine_queue.jsonl
  data/activation_throttle.jsonl
  data/lark_runtime_state.json
  runs/lark-runtime.jsonl
)

moved=0
for file in "${files[@]}"; do
  if [[ -f "$file" ]]; then
    mkdir -p "$backup_dir/$(dirname "$file")"
    mv "$file" "$backup_dir/$file"
    moved=$((moved + 1))
  fi
done

mkdir -p data runs
echo "  ✓ 备份 $moved 个 state 文件到 $backup_dir"
echo

# 3. 检查必要配置
echo "[3/4] 检查必要配置..."
ok=true
if [[ ! -f .env ]]; then echo "  ✗ 缺 .env"; ok=false; fi
if [[ ! -f data/demo-webhooks.json ]]; then echo "  ✗ 缺 data/demo-webhooks.json"; ok=false; fi
if $ok; then
  echo "  ✓ .env 和 data/demo-webhooks.json 都在"
fi
echo

# 4. 提示下一步
echo "[4/4] 启动建议（分两个终端跑）"
echo
echo "  终端 A (Dashboard):"
echo "    npm run dashboard"
echo
echo "  终端 B (Runtime 常驻):"
echo "    npm run lark-runtime"
echo
echo "  终端 C (录屏时现场用):"
echo "    npm run demo:inject -- --script storage-decision"
echo "    npm run demo:anti-interference"
echo
echo "━━━ 重置完成，可以开始录屏 ━━━"
