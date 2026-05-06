#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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
  runs/kairos-feishu-ingress.jsonl
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
: > runs/lark-runtime.jsonl

cat <<EOF
Kairos demo state reset.
Moved $moved file(s) to: $backup_dir
Kept .env untouched.
Next:
  npm run lark-runtime:once
  npm run dashboard
EOF
