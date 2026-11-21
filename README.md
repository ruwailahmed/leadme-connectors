# leadme — Slack & Discord sources

Connector service + console that lets leadme treat Slack and Discord like it treats WhatsApp:
connect accounts → browse workspaces/servers and channels → attach plain-English monitors → live alerts → manual reply.

```bash
npm start            # http://localhost:4310  (Node >= 22.18, zero dependencies)
npm test
```

## What's in the box
| Area | How it works |
|---|---|
| Connections | Multiple Slack/Discord accounts, health pill (healthy / degraded / disconnected), reconnect, workspace → channel browser |
| Monitor builder | Describe in English → clarifying questions → "here's what I understood" → test a pasted message (match / no match + reason) → replay against history |
| Targets | One monitor can watch channels across Slack **and** Discord at once; no limits |
| Alerts | Real-time (SSE) inbox: workspace, channel, person, message, why it matched, deep link. Read / Contacted / "shouldn't have passed", CSV export |
| Reply | Manual only, from the alert (DM or channel), max 3 per lead |
| Push-out | `DISCORD_ALERT_WEBHOOK`, `SLACK_ALERT_WEBHOOK`, and `LEADME_WEBHOOK_URL` (normalized `message.received` event for the leadme app) |
| Classifier | Rule engine pre-filters, then Claude judges the candidates through the logged-in Claude Code subscription (`claude -p`, no API key, ~10 s per call, 2 at a time, falls back to rules). `ANTHROPIC_API_KEY` switches to the API; `CLASSIFIER=rules` turns the AI off |

## Modes
- **Demo** — seeded with the workspaces from the walkthrough (GTMCafe, Unipile, Clay, TTG, Websets; Discord servers) and a simulated message stream. Needs nothing.
- **Live** — paste a token. Slack uses the Web API (one token per workspace; add several accounts for several workspaces). Discord uses the REST API with a bot token. Polling every 15 s, 400 ms between channels, `retry-after` honoured, 3 failures → "disconnected".

## Known limits (be upfront with the client)
- Live mode covers workspaces/servers where the token's owner is allowed to read. Reading communities where you are only a member and cannot install an app means using a personal session token, which breaks Slack's and Discord's terms and can get the account banned. This build stays read-only, rate-limited and manual-reply for that reason; no account pools, proxies, or automated DMs.
- Polling, not websockets: alerts arrive within ~15 s live (~4 s in demo).
- Single-tenant, JSON-file storage (`data/db.json`), no auth on the console. Put it behind a login before exposing it.
- Live adapters are written against the public API docs but have not been exercised against real workspaces.
