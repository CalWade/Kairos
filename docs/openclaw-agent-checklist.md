# OpenClaw Agent Checklist for Kairos

Use this checklist when a user sends the Kairos GitHub link and asks you to install/configure it.

1. Read `OPENCLAW.md`, `openclaw.setup.json`, and `docs/lark-cli-runbook.md`.
2. Clone repo if needed, then run `npm install` and `npm run build`.
3. Install plugin: `openclaw plugins install .`; restart gateway.
4. Check/install lark-cli: `lark-cli --version` or `npm install -g @larksuite/cli`.
5. Create profile: `lark-cli config init --new --name kairos-alt`.
   - Send printed URL to user.
   - Wait for user confirmation.
6. Authorize profile: `lark-cli auth login --recommend --profile kairos-alt`.
   - Send printed OAuth URL to user.
   - Wait for user confirmation.
7. Run `memoryops doctor --profile kairos-alt`.
8. Ask user for target `chat_id` or search group with `lark-cli im +chat-search`.
9. Run `memoryops doctor --profile kairos-alt --chat-id <oc_xxx> --e2e`.
10. If successful, report `read_total`, `saved_total`, and `workflow_action`.

Never ask for passwords, SMS codes, App Secret, or OAuth tokens.


Shortcut commands:

```bash
memoryops setup-wizard --profile kairos-alt
memoryops doctor --profile kairos-alt --pretty
memoryops doctor --profile kairos-alt --chat-id <oc_xxx> --e2e --pretty
```
