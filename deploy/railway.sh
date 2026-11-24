#!/usr/bin/env bash
set -euo pipefail
# Deploy to Railway from this folder (uses the proven Dockerfile + Chromium).
# One-time: railway login.   Then: ./deploy/railway.sh
cd "$(dirname "$0")/.."

railway whoami >/dev/null 2>&1 || { echo "Run 'railway login' first (opens a browser once)."; exit 1; }
set -a; [ -f .env ] && . ./.env; set +a
[ -n "${APP_PASSWORD:-}" ] || { echo "APP_PASSWORD missing from .env"; exit 1; }

if ! railway status >/dev/null 2>&1; then
  railway init --name leadme-connectors
fi

railway variables \
  --set "APP_PASSWORD=$APP_PASSWORD" \
  --set "CREDENTIALS_KEY=${CREDENTIALS_KEY:-}" \
  --set "TENANT_SECRET=${TENANT_SECRET:-}" \
  --set "SERVICE_TOKEN=${SERVICE_TOKEN:-}" \
  --set "SESSION_WEBHOOK_SECRET=${SESSION_WEBHOOK_SECRET:-}" \
  --set "AUTH_HEADLESS=1" \
  --set "DATA_DIR=/data"

railway up --detach
railway domain
