---
name: kairos-feishu-ingress
description: "Route inbound Feishu messages to Kairos workflow without LLM token usage"
metadata:
  { "openclaw": { "emoji": "🧠", "events": ["message:received"], "requires": { "bins": ["node", "npm"] } } }
---

# Kairos Feishu Ingress Hook

Listens for `message:received` events from OpenClaw Gateway and invokes Kairos as an external memory engine.

- OpenClaw handles Feishu receiving.
- Kairos handles memory workflow decisions.
- By default the hook logs workflow output only.
- Set `KAIROS_HOOK_SEND_FEISHU=1` and `KAIROS_FEISHU_WEBHOOK_URL` to allow webhook card sending.
