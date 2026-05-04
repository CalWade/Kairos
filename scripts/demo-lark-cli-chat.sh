#!/usr/bin/env bash
set -euo pipefail
PROFILE="${KAIROS_LARK_PROFILE:-kairos-alt}"
CHAT_ID="${KAIROS_DEMO_CHAT_ID:-}"
TRIGGER_TEXT="${KAIROS_DEMO_TRIGGER_TEXT:-要不我们还是用 PostgreSQL？}"
if [[ -z "$CHAT_ID" ]]; then
  echo "Missing KAIROS_DEMO_CHAT_ID=oc_xxx" >&2
  echo "Example: KAIROS_DEMO_CHAT_ID=oc_xxx npm run demo:lark-cli-chat" >&2
  exit 2
fi
npm run -s dev -- doctor --profile "$PROFILE" --chat-id "$CHAT_ID" --trigger-text "$TRIGGER_TEXT" --e2e --pretty
