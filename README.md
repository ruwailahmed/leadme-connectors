# leadme — Slack & Discord sources

Connector service + console that lets leadme treat Slack and Discord like it treats WhatsApp:
connect accounts → browse workspaces/servers and channels → attach plain-English monitors → live alerts → manual reply.

> **State, architecture, verified behaviour and next steps: [HANDOFF.md](HANDOFF.md).**

```bash
npm start            # http://localhost:4310  (Node >= 22.18, zero dependencies)
npm test
```

## What's in the box
| Area | How it works |
|---|---|
| Connections | Multiple Slack/Discord accounts, health pill (healthy / degraded / disconnected), reconnect, workspace → channel browser |
| Sessions | Per-account stored login (encrypted), automatic re-sign-in when the session ends, TOTP answered in-process, a code/live-view checkpoint for anything else |
| Monitor builder | Describe in English → clarifying questions → "here's what I understood" → test a pasted message (match / no match + reason) → replay against history |
| Targets | One monitor can watch channels across Slack **and** Discord at once; no limits |
| Alerts | Real-time (SSE) inbox: workspace, channel, person, message, why it matched, deep link. Read / Contacted / "shouldn't have passed", CSV export |
| Reply | Manual only, from the alert (DM or channel), max 3 per lead |
| Push-out | `DISCORD_ALERT_WEBHOOK`, `SLACK_ALERT_WEBHOOK`, and `LEADME_WEBHOOK_URL` (normalized `message.received` event for the leadme app) |
| Classifier | Rule engine pre-filters, then Claude judges the candidates through the logged-in Claude Code subscription (`claude -p`, no API key, ~10 s per call, 2 at a time, falls back to rules). `ANTHROPIC_API_KEY` switches to the API; `CLASSIFIER=rules` turns the AI off |

## Modes
- **Demo** — seeded with the workspaces from the walkthrough (GTMCafe, Unipile, Clay, TTG, Websets; Discord servers) and a simulated message stream. Needs nothing.
- **Live** — paste a token. Slack uses the Web API (one token per workspace; add several accounts for several workspaces). Discord uses the REST API with a bot token. Polling every 15 s, 400 ms between channels, `retry-after` honoured, 3 failures → "disconnected".

## Run it on the customer's machine (agent)
Sold as a service, the browser work belongs on the customer's machine: their IP, their fingerprint,
their profiles. Our cloud only holds licences and the fleet view (`SAAS.md` explains the model).

```bash
curl -fsSL https://leadme-connectors.vercel.app/agent/install-agent.sh | bash -s -- \
  --license "<license>" \
  --url https://leadme-connectors.vercel.app/agent/leadme-agent-1.0.0.tgz
```

Installs a login service, binds the console to `127.0.0.1:4310`, then registers with the control
plane (`CONTROL_PLANE_URL` + `LICENSE_KEY`) and heartbeats every minute. Windows uses
`install-agent.ps1`. Build the artifact with `bash scripts/make-agent-bundle.sh`.

## Known limits (be upfront with the client)
- Live mode covers workspaces/servers where the token's owner is allowed to read. Reading communities where you are only a member and cannot install an app means using a personal session token, which breaks Slack's and Discord's terms and can get the account banned. This build stays read-only, rate-limited and manual-reply for that reason; no account pools, proxies, or automated DMs.
- Polling, not websockets: alerts arrive within ~15 s live (~4 s in demo).
- Single-tenant, JSON-file storage (`data/db.json`), no auth on the console. Put it behind a login before exposing it.
- Live adapters are written against the public API docs but have not been exercised against real workspaces.

## One-click connect (official OAuth)
`Continue with Slack` / `Continue with Discord` in the Connect dialog. The user approves on Slack/Discord itself; no token copying. Needs one-time app registration (set env vars, then restart):

| Env | Where from |
|---|---|
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | api.slack.com/apps → your app. Redirect URL `http://localhost:4310/oauth/slack/callback`. User scopes: `channels:read channels:history users:read team:read chat:write im:write` |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | discord.com/developers → your app. Redirect `http://localhost:4310/oauth/discord/callback` |
| `DISCORD_BOT_TOKEN` | same app → Bot. Discord only lets a bot (invited by a server admin) read messages |
| `PUBLIC_URL` | only when hosted somewhere other than localhost |

Honest limits: Slack workspaces that restrict app installs need an admin to approve the app once (one click per workspace for him otherwise). Discord sign-in lists his servers, but reading a server's channels needs the bot invited to it by someone with Manage Server.

## Discord: your own account, no bot
## Persistent sessions & automatic sign-in
The pattern from the "infinite login" docs: connect once, keep the login, and sign back in whenever the provider ends the session — no human unless a step a TOTP secret cannot answer comes up.

- **Stored per account** — `username`, `password`, optional `totp_secret` (the setup key behind the QR code, or the whole `otpauth://` link), optional proxy. Sealed with AES-256-GCM under `CREDENTIALS_KEY`; the API only ever returns `hasPassword`, `hasTotp` and a 4+4 preview.
- **Slack** — a real Chrome/Chromium signs in (email → password → TOTP) inside a persistent per-account profile (`data/profiles/<accountId>`), then the console reads the `xoxc` token + `d` cookie out of the page. The profile keeps the same device identity between reconnects.
- **Discord** — `POST /auth/login`, then `/auth/mfa/totp` with a generated code; the returned token is verified with `/users/@me` before it is stored.
- **When it fires** — the poller's third consecutive failure, or a signed provider webhook. One sign-in per account, retries at 2/5/15/30/60/120/240/360 min, cancelled by success.
- **Checkpoints** — email/SMS codes, phone registration, in-app approval and CAPTCHAs pause the loop: status `waiting_human`, a code box, and (Slack) a live screenshot of the browser. Ten minutes, then the retry ladder resumes. A rejected code keeps the same sign-in alive instead of starting a new one.

| Env | Use |
|---|---|
| `CREDENTIALS_KEY` | real vault key (32+ random bytes). Falls back to `APP_PASSWORD`, then a dev string the console flags. |
| `AUTH_HEADLESS=1` | force headless. Default is headful on a desktop (so a person can clear a CAPTCHA), headless on Linux without `DISPLAY`. |
| `CHROME_BIN` | path to Chrome/Chromium; otherwise auto-detected (macOS, common Linux paths, `PATH`). |
| `BROWSER_URL` | attach to an existing CDP endpoint instead of launching — a fingerprint browser or a remote box. |
| `AUTH_TIMEZONE`, `AUTH_USER_AGENT` | pin the browser timezone / Discord's user agent. |
| `SESSION_WEBHOOK_SECRET` | HMAC key for `POST /api/hooks/session`; when set, unsigned calls get 401. |

Webhook contract: `{ event_id, emitted_at, AccountStatus: { account_id, message } }` with `X-LG-Signature: base64url(HMAC-SHA256(raw body))`. `CREDENTIALS` queues a reconnect, `OK` marks healthy, `STOPPED` parks the account. Retries reuse `event_id` (deduped) and an older `emitted_at` never wins.

API: `GET /api/accounts/:id/autoauth`, `PUT` (save + enable), `DELETE` (forget), `POST .../run`, `POST .../stop`, `POST .../code`, `GET .../frame` (PNG live view), `GET /api/autoauth/drivers`.

## Impersonation mode (default)
Goal: read every community the user belongs to with **no app install, no bot invite, no admin approval**. That means acting as the user's own session.

- **Slack** — sign in with the account's email/password + TOTP inside a persistent Chrome profile, then make the API calls **from inside that page** (`SLACK_TRANSPORT=browser`, default). This is the important part: Slack rotates the `xoxc` token and the `d` cookie while the web client uses them, so a copied pair dies within minutes (the "connected, then invalid after ~2 minutes" symptom). Calling from the page means we *are* the client instead of a second one.
- **Discord** — token from `/auth/login` + `/auth/mfa/totp`, or the profile's own `localStorage` token when a profile already exists. Discord tokens do not rotate, so the REST copy stays valid; the profile is what keeps the device trusted and gets past CAPTCHAs.
- **No admin anywhere.** The official app flow is still in the console but marked as needing workspace admin approval — useless for communities the user does not own.
- `SLACK_TRANSPORT=token` forces the old copied-token mode; browser is the default for session accounts. `SESSION_MODE` is reported in `/api/stats`.

Honest risk: this is impersonation, and both platforms forbid it. Slack enforces loosely, Discord enforces harder (sometimes device-level). Mitigations baked in: one stable IP + profile per account, read-only, 350 ms between channels, provider `retry-after` honoured, three failures before a re-sign-in, no mass DMs. Budget for some account attrition.

## Run the browser on the user's machine (Dolphin / anti-detect)
Dolphin Anty, AdsPower, GoLogin, Multilogin all work the same way: each profile is a persistent Chromium identity (fingerprint + cookies + proxy) running on the customer's machine, driven over CDP. That is the same shape as this service, so we can borrow their browser instead of hosting one:

| Env | Effect |
|---|---|
| `BROWSER_WS` | Attach to any browser-level CDP websocket and drive it (a `wsEndpoint` from a Local API). |
| `DOLPHIN_API` + `DOLPHIN_PROFILE_ID` | Call Dolphin's Local API to start that profile and attach to it. `DOLPHIN_TOKEN` if your Local API requires one. |
| `BROWSER_URL` | Attach to an HTTP debug endpoint (`http://host:port`) instead. |

The endpoint must be reachable from the app: run the app on the same machine as the browser, or expose the Local API through a tunnel. In this mode the browser keeps its own fingerprint, IP and cookies, so there is no CAPTCHA from a datacenter IP, no RAM bill, and the reconnect is a re-read of the same profile. Verified: attaching to a browser-level websocket, selecting the page, navigating and screenshotting all work.

This is also the honest answer to "why a browser": Slack and Discord have no admin-free message API, and both bind auth to a browser session. Competitors do not avoid the browser — the hosted ones (Unipile, Swarmhit) run the devices themselves, the anti-detect ones (Dolphin) run them on the customer's machine. We support both: our own container, or their profile.

## Per-user connect links (no shared console login)
For a multi-user product, nobody should paste tokens or share one console password. Your backend mints one signed link per end user:

```
POST /api/connect-link          Authorization: Bearer $SERVICE_TOKEN
{ "tenantId": "agency_42", "platform": "slack" }
→ { "tenantId": "agency_42", "url": "https://…/connect?t=…", "cookie": "agency_42.…" }
```

- The link sets an HttpOnly `lm_t` cookie (one year, signed) and, when `platform` is given, goes straight to that provider's consent screen — one click, no password, no 2FA.
- Accounts, workspaces/channels, monitors, alerts, auto-sign-in status and stats are all scoped to the cookie's tenant. Another tenant's ids return 404.
- `TENANT_SECRET` signs these links: rotate it and every outstanding link dies at once. `DEFAULT_TENANT` owns rows that predate tenants.
- `SERVICE_TOKEN` guards link minting. With it set, minting without the bearer header is 401.
- A valid `lm_t` also satisfies the console password gate, so the same link works when `APP_PASSWORD` is enabled.

What that means for the login strategy: Slack should be the **OAuth** path (one click, user token, no stored password, no re-auth, no ban risk). The password+TOTP vault is the fallback for workspaces that block app installs. Discord has no message-reading OAuth — it is either a bot per server (admin) or the user's own token, so Discord is password+TOTP here, read-only and rate-limited.

Honest limits: the Slack flow drives an undocumented page, so a Slack redesign can break it (the manual paste paths remain). Discord's `/auth/login` is unofficial and still self-bot territory. A CAPTCHA needs a human looking at a headful browser or a real fingerprint browser via `BROWSER_URL`. The Vercel deployment cannot launch a browser (30 s functions) — run the always-on host, with a volume if profiles should survive redeploys. Stored passwords are the highest-value secret in this app: set `CREDENTIALS_KEY` and keep the data directory private.

`Use your Discord account directly` on the Discord setup panel — reads (and can post as) your own account, no bot, no server admin. Same shape as the Slack session path: you paste your own token, copied by you from your own browser's Network tab. Real ToS violation on Discord's side, enforced harder than Slack's equivalent (sometimes device-level bans) — account-owner's call, own risk.
