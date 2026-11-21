# Slack + Discord sources for "leadme" — brief

Source: KodakBlack's 4-min screen recording, 2026-11-21 (transcript: `kodak-walkthrough-2026-11-21.srt`).
Audio was quiet; transcribed after a +12 dB boost. 1:13–1:28 was paused in the recording.

## What exists (his app, "leadme — conversation intelligence")
- **Sources**: connect accounts through a provider auth flow — LinkedIn, WhatsApp, Instagram, Telegram (Unipile-style). One WhatsApp number connected.
- **Monitors**: describe in plain English what to catch; an agent asks clarifying questions, writes the production classifier prompt, tests it against real messages ("Run test", "Replay against your message history"), then deploys.
  Examples on screen: "Email infrastructure interest", "LinkedIn scraping leads", "US ID verified LinkedIn rental requests".
- **Targets**: pick which conversations/groups the monitor listens to (his WhatsApp groups: GTM APAC, SaaS Yacht Club, Tuesday Triggers, War Room, The AI Consortium…).
- **Alerts**: matched messages land in an inbox; also pushed to Discord (#general) and Slack (#lead-me). He can then message the person from the console ("Conversations").

## What he wants from us
> "I need to be able to set up monitors inside of communities that I'm a part of."

Same flow as WhatsApp, for **Slack first, then Discord**:
1. Connect his Slack account → see every workspace he's in (GTMCafe, Unipile community, Clay, TTG Services, Websets…) and their channels.
2. Pick workspace → pick channels → attach a monitor.
3. New messages in those channels flow into his existing classifier → alerts.
4. Reply / DM the person from leadme.
Discord: same — pick server, pick channels, monitor.

## Proposed shape
A standalone connector service with a Unipile-shaped API so his app plugs it in like an existing provider:
- `POST /accounts` (connect), `GET /accounts/:id/workspaces`, `GET /workspaces/:id/channels`
- webhook `message.received` (normalized: source, workspace, channel, author, text, ts, permalink)
- `POST /chats/:id/messages` (reply / DM)
- account health + reconnect events

## The decision that shapes everything
These are communities he's a *member* of, not ones he runs.
- **Official route** (Slack OAuth app with user token / Discord bot) needs the community's admin to install or approve it. Most big communities won't → not viable for his use case.
- **Session route** (use his own logged-in Slack/Discord session, the way Unipile uses LinkedIn cookies) is the only way to read communities he doesn't control. It breaks Slack's and Discord's terms (Discord explicitly bans user-account automation); the risk is his accounts getting banned from those communities.

Our line: read-only listening on accounts the user owns, human-initiated replies, polite rate limits. Not: account pools, rotating proxies, or automated mass DMs.

## Questions for the call
1. Just his accounts, or will leadme customers connect theirs (multi-tenant)?
2. His stack + how the Unipile integration is wired (their webhooks? polling?) — we match it.
3. Latency needed: real-time (websocket) or every few minutes (polling)?
4. Replies: manual from the console only, or any automation?
5. Scale: how many workspaces/servers/channels per account?
6. Hosting, deadline, and pay (fixed for Slack v1, then Discord?).
