#!/usr/bin/env bash
# Waits for the browserless login to complete, then deploys to Railway end to end.
set -uo pipefail
cd /Users/m1pro/Code/leadme-slack-discord
L=/tmp/railway-deploy.log
log() { echo "[$(date +%H:%M:%S)] $*" >> "$L"; }
: > "$L"
log "waiting for auth"

for _ in $(seq 1 480); do
  railway whoami >/dev/null 2>&1 && break
  sleep 5
done
if ! railway whoami >/dev/null 2>&1; then log "auth timeout"; exit 1; fi
log "authed: $(railway whoami 2>/dev/null | tail -1)"

if ! railway status >/dev/null 2>&1; then
  log "creating project"
  railway init --name leadme-connectors >>"$L" 2>&1 || railway init >>"$L" 2>&1
fi

set -a; . ./.env; set +a
log "setting env"
railway variables \
  --set "APP_PASSWORD=$APP_PASSWORD" \
  --set "CREDENTIALS_KEY=$CREDENTIALS_KEY" \
  --set "TENANT_SECRET=$TENANT_SECRET" \
  --set "SERVICE_TOKEN=$SERVICE_TOKEN" \
  --set "SESSION_WEBHOOK_SECRET=$SESSION_WEBHOOK_SECRET" \
  --set "AUTH_HEADLESS=1" \
  --set "DATA_DIR=/tmp/leadme" >>"$L" 2>&1

log "deploying image"
railway up --detach >>"$L" 2>&1

log "waiting for a domain"
DOM=""
for _ in $(seq 1 40); do
  DOM=$(railway domain 2>>"$L" | grep -oE 'https://[a-z0-9.-]+\.up\.railway\.app' | head -1 || true)
  [ -n "$DOM" ] && break
  sleep 5
done
if [ -z "$DOM" ]; then log "no domain"; exit 1; fi
echo "$DOM" > /tmp/railway-url.txt
log "domain=$DOM"
railway variables --set "PUBLIC_URL=$DOM" >>"$L" 2>&1

log "waiting for health"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "$DOM/healthz" >/dev/null 2>&1; then log "healthy: $DOM"; break; fi
  sleep 5
done
log "done"
