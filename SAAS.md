# Selling this as a service

**The product is a link, not an installer.** A customer clicks it, types their Slack/Discord login
once, and we do the rest. Only enterprise/on-prem buyers ever see the agent.

## Two delivery modes, one codebase
| | Hosted (default) | Agent (enterprise / power users) |
|---|---|---|
| Customer does | clicks a link, fills one form | runs one installer, then clicks |
| Browser runs on | our box | their machine |
| Their IP / fingerprint | ours (datacenter) | theirs (residential) |
| CAPTCHA risk | higher; solved in the live view | low |
| Our cost | ~250 MB RAM per active account | zero |
| Best for | speed to first value, demos, most customers | big agencies, ban-sensitive accounts |

Price hosted seats to cover the browser; price agent seats lower (or the same, higher margin).

## The hosted flow we sell
1. We mint a licence: `POST /api/licenses` → `{ license, connectUrl }`.
2. We send `https://<host>/connect?t=<license>&platform=slack`.
3. They type email + password (+ optional 2FA setup key) and press one button.
4. We sign in, capture the session, keep it alive (keeper + retry ladder), and show a live view for
   anything a TOTP secret cannot answer — code, phone approval, CAPTCHA (clickable).
5. Dashboard, alerts, CSV and replies are all behind the same licence cookie. No password, no signup.

## Plans (proposal)
| Plan | Accounts | Mode | Price |
|---|---|---|---|
| Starter | 3 | hosted | $79/mo |
| Growth | 10 | hosted | $199/mo |
| Agency | 40 | hosted | $499/mo |
| On-prem | unlimited | agent | from $999/mo |

Add-ons: extra accounts, managed Dolphin profiles, CRM alert forwarding, per-machine agent seats.

## What is already built
- Licence minting, signed connect links, tenant isolation (another tenant's ids 404).
- Hosted connect page (`/connect.html`): form → progress → checkpoint/live view → done.
- Login drivers for Slack (browser login → token+cookie, in-page API calls so Slack keeps rotating
  for us) and Discord (API login + TOTP, browser fallback for CAPTCHA).
- Persistent per-account profiles with UA/timezone/locale/viewport/proxy, resettable identity.
- Keeper (probes stale sessions), retry ladder, single-flight, clickable live view.
- Fleet endpoints + console view, and the optional agent installers for all three OSes.

## Build order from here
1. **Hosting**: one always-on box for the browser tier (Railway/Hetzner), plus a worker pool at
   ~20 accounts per 4 GB. Keep the control plane on Vercel.
2. **Billing**: Stripe → `POST /api/licenses` on subscription create; seat counting from heartbeats.
3. **Onboarding email**: send the link + a 60-second Loom instead of docs.
4. **Support bundle** endpoint (versions, Chrome path, profile sizes, sanitised logs).
5. **Tray app + auto-update** for the agent tier; code-sign the installers.
6. **Branded connect page** per tenant (logo/colour from the licence) — small change, big perceived polish.

## Legal / risk posture
- The customer opts in per account and accepts the platform ToS risk (Discord "self-bot" is stricter
  than Slack). The connect page says so before they type anything.
- Hosted mode: credentials are AES-256-GCM encrypted with our key; message content is processed, not
  resold. Offer "delete my account" = delete the account row + profile.
- Agent mode: we cannot decrypt their credentials at all; uninstalling wipes everything.
- Revoking a licence/machine stops heartbeats; the local agent keeps running offline until checked
  (by design — don't brick a customer when our cloud blips).

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
