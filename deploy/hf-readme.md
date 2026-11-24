---
title: leadme connectors
emoji: 🎯
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# leadme connectors

Slack + Discord impersonation connector: signs in as the account, keeps the session alive, monitors
channels, raises alerts. Runs headless Chromium inside the container.

Set these Space secrets before first use: `APP_PASSWORD`, `CREDENTIALS_KEY`, `TENANT_SECRET`,
`SERVICE_TOKEN`, `SESSION_WEBHOOK_SECRET`. Optionally `KV_REST_API_URL` + `KV_REST_API_TOKEN`
(Upstash) to keep data across restarts — otherwise `/tmp` is wiped when the Space sleeps.
