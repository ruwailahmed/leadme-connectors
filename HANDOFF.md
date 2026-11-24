# Handoff — what this is, what works, what's next

Written overnight, 2026-11-24. Everything below was run and verified unless it says otherwise.

## TL;DR
You have a working "Dolphin-style" connector: one persistent browser identity per account, a
credential vault, automatic sign-in with TOTP, a clickable live view for CAPTCHA/code steps, an
autonomous keeper that fixes dead sessions on its own, per-user signed connect links, and a
supervisor that keeps it hosted on this Mac with a public URL. A container image runs the same thing
on any Docker host with Chromium.

Live right now: **https://shares-batteries-lived-tribe.trycloudflare.com** — password `leadme-9d388a`
(Vercel is also current at `leadme-connectors.vercel.app`, same password as before; it can't run a
browser, so Slack/Discord impersonation lives on the Mac host / a container).

## How it works
1. **Account = profile.** Every account gets `data/profiles/<accountId>`: its own cookies, storage,
   user agent, timezone, locale, viewport, colour scheme and proxy. Reset wipes the identity.
   The same account can instead borrow a Dolphin/AdsPower/GoLogin profile (`mode: dolphin`) or any
   browser-level CDP websocket (`mode: ws`), so the fingerprint and IP are the customer's.
2. **Login** (`src/auth/browser.ts`): Slack — email → password → TOTP, then read the `xoxc` token +
   `d` cookie out of the page; Discord — `/auth/login` + `/auth/mfa/totp`, browser fallback for
   CAPTCHA. The account row stores the session; the password lives only in the vault.
3. **Staying alive** (`src/adapters/slack.ts` + `src/auth/session.ts`): Slack API calls are made
   **from inside the account's page** (`SLACK_TRANSPORT=browser`, default). Slack rotates token and
   cookie as its web client uses them, so a copied pair dies in minutes — calling from the page means
   we are the client, not a second one.
4. **Recovery** (`src/auth/reconnect.ts`): 3 failed polls or a signed webhook queue a sign-in.
   Single-flight per account, retries at 2/5/15/30/60/120/240/360 min, cancelled by success.
   A profile that is still logged in is re-harvested without the password.
5. **Human steps** (checkpoints): email/SMS code, phone approval, CAPTCHA become a checkpoint with a
   code box and a live JPEG of the browser. The image is **clickable** — clicks are replayed via CDP,
   so a headless host is still usable.
6. **Keeper** (`src/auth/keeper.ts`): every 60 s, accounts whose last sync is older than 6 h (or that
   are unhealthy) are probed; a dead session goes through the same reconnect ladder.
7. **Tenancy** (`src/tenant.ts`): `POST /api/connect-link` mints a signed per-user link. Accounts,
   monitors, alerts, profiles and stats are scoped to it; another tenant's ids 404.

## Verified
- 28 unit tests (`npm test`): RFC 6238 vectors, vault tamper detection, single-flight/backoff/
  checkpoints, webhook signature + dedupe + ordering, tenant isolation, fingerprint merge.
- Live: Slack sign-in page detected and filled; Discord login reached a CAPTCHA checkpoint in ~20 s;
  live frame 28 KB JPEG; click replay `{ok:true}`; browser-level CDP attach (Dolphin shape) drove a
  page and screenshot it.
- Docker image with Chromium built and exercised: launch 630 ms, page render, screenshot, login flow.
- Tenant isolation smoke: 401 without service token, 400 on a tampered link, cross-tenant fetch 404.

## Hosting
- **Here (free, no account):** `scripts/host-cli.sh` → `caffeinate` + `scripts/host.sh`, which tries
  Cloudflare quick tunnel → Serveo → localtunnel, rewrites `PUBLIC_URL`, restarts the pair on crash
  or failed health check. Stop with `kill $(cat /tmp/leadme-host.pid)`; URL: `cat /tmp/leadme-url.txt`.
  Caveat: dies if the Mac sleeps/lid closes or the tunnel rate-limits; URL changes on restart.
- **Railway (stable, ~$5 trial):** `railway login`, then `./deploy/railway.sh`.
- **Hugging Face Space (free, 16 GB):** free account + write token, then
  `HF_TOKEN=… OWNER=your-hf-username ./deploy/huggingface.sh`. Sleeps after ~48 h idle.
- **Render free:** `render.yaml` ready; 512 MB may OOM on Slack, fine for Discord API + demo.
- Vercel: `vercel --prod` (done). Serverless has no Chromium; the Slack driver reports `ok:false`
  and the UI says so.

## Selling it: the agent runs on the customer's machine
Our cloud is a control plane only. Each customer installs an agent; all browsers, profiles and
sessions live with them. Full rationale, pricing and roadmap: **[SAAS.md](SAAS.md)**.

One command (macOS/Linux), after minting a licence with `POST /api/licenses`:

```bash
curl -fsSL https://leadme-connectors.vercel.app/agent/install-agent.sh | bash -s -- \
  --license "<license>" \
  --url https://leadme-connectors.vercel.app/agent/leadme-agent-1.0.0.tgz
```

Windows: download `install-agent.ps1` and run
`powershell -ExecutionPolicy Bypass -File install-agent.ps1 -License <key> -Url <tgz>`.

It installs a login service (launchd / systemd user unit / Task Scheduler), binds the console to
`127.0.0.1:4310`, writes an encrypted-vault key locally, registers with the cloud and heartbeats every
minute. The cloud sees machine name, OS, version and counts — never cookies or message content.

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/licenses` | our backend (`SERVICE_TOKEN`) | mint a tenant's licence key + connect link |
| `POST /api/agents/register` | agent (licence) | exchange a licence for a machine id + token |
| `POST /api/agents/heartbeat` | agent (`x-agent-token`) | last-seen + accounts/monitors/alerts counts |
| `GET /api/agents` | console | fleet view, tenant-scoped |
| `DELETE /api/agents/:id` | console | revoke a machine (heartbeats start failing with 403) |

Build the artifact to publish: `bash scripts/make-agent-bundle.sh` (prints the sha256). The copy in
`public/agent/` is what the one-liner serves; bump the version in `package.json` when you ship.

## Known gaps (deliberate, next)
1. **Scale.** One Chromium per active account (~250 MB). For 100+ accounts: a job queue plus a pool
   of workers, capped concurrency, profiles on a volume. Today the keeper is in-process.
2. **Discord CAPTCHA.** A fresh datacenter IP gets hCaptcha on first login. Solved by the clickable
   live view or by pasting a token. With a Dolphin profile (residential IP) it mostly disappears.
3. **Backfill/storage.** Polling only covers channels a monitor watches. "Pull every channel once,
   then only new" needs a store + cursor per channel.
4. **Cookie export/import**, proxy pools, and a backup-code fallback are planned but unused.
5. **Browser flows have no automated tests** (they need real accounts); everything around them is tested.
6. **Free tunnels are not production.** For a client-facing demo, Railway/HF plus a real domain.

## Files
| Path | What |
|---|---|
| `src/server.ts` | routes, tick loop, OAuth, tenants, browser-identity API, webhook |
| `src/auth/cdp.ts` | zero-dependency CDP client: launch, attach (browser/page), emulate, click, screenshot |
| `src/auth/session.ts` | profile dirs, fingerprint resolution, launchFor(), in-page Slack API |
| `src/auth/browser.ts` | Slack + Discord login drivers, checkpoints, live view, click |
| `src/auth/reconnect.ts` | vault, retry ladder, single-flight, checkpoints, signed events |
| `src/auth/keeper.ts` | autonomous session probing |
| `src/vault.ts`, `src/totp.ts`, `src/tenant.ts` | AES-GCM vault, RFC 6238, signed tenant links |
| `public/index.html` | whole console (no build step) |
| `scripts/host.sh`, `scripts/host-cli.sh` | overnight hosting supervisor |
| `deploy/huggingface.sh`, `deploy/railway.sh`, `Dockerfile`, `render.yaml` | deploy paths |

## Env (all in `.env`, gitignored)
`CREDENTIALS_KEY` (vault), `TENANT_SECRET` (connect links), `SERVICE_TOKEN` (link minting),
`APP_PASSWORD` (console), `SESSION_WEBHOOK_SECRET` (status webhooks), `PUBLIC_URL` (set by the host),
`AUTH_HEADLESS`, `CHROME_BIN`, `BROWSER_WS`/`BROWSER_URL`, `DOLPHIN_API`/`DOLPHIN_PROFILE_ID`/`DOLPHIN_TOKEN`,
`KV_REST_API_URL`/`KV_REST_API_TOKEN` (optional Redis), `KEEPER_STALE_MS`, `SLACK_TRANSPORT`.

## Commands
```bash
npm start                 # local, reads .env
npm test                  # 28 tests, no network needed
bash scripts/host-cli.sh  # keep it hosted + awake (this is what is running now)
kill $(cat /tmp/leadme-host.pid)   # stop hosting
docker build -t leadme . && docker run -p 7860:7860 -e APP_PASSWORD=test leadme
vercel --prod             # control plane only
```
