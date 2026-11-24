# Selling this as a service

The product is an **agent**: the customer's machine runs every browser, profile and session. Our
cloud is only the control plane — licences, fleet health, config, billing later. That is exactly how
Dolphin Anty is sold, and it removes the three things that make this hard to run centrally: browser
RAM, datacenter CAPTCHAs, and per-account ban risk.

## Why the agent model
| Problem | Central browsers (Unipile/Swarmhit) | Agent on the customer machine (us) |
|---|---|---|
| Chrome cost | we pay ~250 MB per account | customer pays, free for us |
| IP / CAPTCHA | datacenter IP, hCaptcha every time | their residential IP, mostly clean |
| Data residency | messages through our servers | messages stay on their machine |
| Blast radius | our outage = their outage | their agent keeps running offline |
| Scale ceiling | our worker pool | one machine per seat, linear |
| Selling point | "we log in for you" | "your accounts never leave your computer" |

## The flow we sell
1. We issue a **licence key** per customer (today: a signed tenant token; later Stripe → key).
2. They run one command: `install-agent.sh --license <key> --url <artifact>` (or the PowerShell one).
   It installs Node-optional? no — requires Node 22.18+, then a login service (launchd / systemd / Task Scheduler).
3. The agent registers with `POST /api/agents/register`, gets a machine token, and heartbeats every
   minute with counts. We see the fleet; we never see their cookies.
4. They open `http://localhost:4310` and connect Slack/Discord as themselves. Everything after that —
   login, TOTP, session keeping, profiling, alerts — is local.
5. Our console shows **Customer machines**: last seen, OS, version, accounts, monitors, and a Revoke button.

## Packaging & pricing (proposal)
| Plan | Machines | Accounts | Price |
|---|---|---|---|
| Starter | 1 | up to 3 | $49/mo |
| Growth | 2 | up to 10 | $149/mo |
| Agency | 5 | up to 40 | $399/mo |
| Enterprise | custom | custom | talk |

Add-ons that fall out of the architecture: extra machine +$19/mo, extra accounts +$6/account,
managed Dolphin profiles, alert forwarding to their CRM (webhook already exists: `LEADME_WEBHOOK_URL`).

## Build order from here
1. **Licence server** (Stripe webhook → `db.licenses`, key = signed token, trial keys with expiry,
   seat counting). Today the key is a tenant token and revocation is per machine.
2. **Auto-update**: agent polls `/api/agents/latest` and swaps the bundle on version change
   (the installer already keeps everything in one directory, so it is a file swap + restart).
3. **Tray app**: a small menu-bar/Windows-tray wrapper around `http://localhost:4310` with
   "open dashboard / restart / logs / version". Tauri or Electron; the server stays as-is.
4. **Support bundle**: `GET /api/diagnostics` (versions, Chrome path, profile sizes, last 200 log
   lines, sanitised) so support does not need remote access.
5. **Alert forwarding** to the customer's own CRM/Slack, with our cloud as fallback.
6. **Signed installers** (Apple notarisation, Windows code signing) — otherwise every install shows
   a scary warning.
7. **Per-account metering** from the heartbeat (already sent) for usage-based pricing.

## Legal / risk posture to put in the contract
- The customer opts in per account and accepts the platform ToS risk ("self-bot" on Discord is
  stricter than Slack). Our console says so at connect time, and the agent never writes except the
  one manual reply.
- Credentials are AES-256-GCM encrypted on their machine with a key in their own `.env`; we cannot
  decrypt them. Deleting `~/.leadme-agent` is a complete uninstall.
- Revoking a machine stops heartbeats; the local agent keeps working until their licence check fails
  (by design — the product should not brick when our cloud blips).
