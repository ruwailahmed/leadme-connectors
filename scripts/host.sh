#!/usr/bin/env bash
# Overnight host: keeps the Mac awake, keeps the app alive, and publishes it through whichever
# tunnel provider will take us (Cloudflare quick tunnel -> Serveo -> localtunnel).
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-4310}
LOG=/tmp/leadme-host.log
URLFILE=/tmp/leadme-url.txt
HEALTH="http://127.0.0.1:${PORT}/healthz"

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }
kill_quiet() { [ -n "${1:-}" ] && kill "$1" 2>/dev/null || true; }

write_public() {
  local url=$1
  if grep -q '^PUBLIC_URL=' .env 2>/dev/null; then
    sed -i '' "s|^PUBLIC_URL=.*|PUBLIC_URL=${url}|" .env
  else
    echo "PUBLIC_URL=${url}" >> .env
  fi
  echo "$url" > "$URLFILE"
  log "public url ($PROVIDER) -> $url"
}

try_cloudflared() {
  : > "$LOG.cf"
  cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate > "$LOG.cf" 2>&1 &
  local pid=$! url=""
  for _ in $(seq 1 45); do
    url=$(grep -oE 'https://[a-z0-9]+(-[a-z0-9]+){2,}\.trycloudflare\.com' "$LOG.cf" | tail -1 || true)
    [ -n "$url" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if [ -n "$url" ]; then TUNNEL_PID=$pid; PROVIDER=cloudflare; write_public "$url"; return 0; fi
  kill_quiet "$pid"; return 1
}

try_serveo() {
  : > "$LOG.serveo"
  ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -T \
      -R 80:localhost:"${PORT}" serveo.net > "$LOG.serveo" 2>&1 &
  local pid=$! url=""
  for _ in $(seq 1 25); do
    url=$(grep -oE 'https://[a-z0-9.-]+\.serveousercontent\.com' "$LOG.serveo" | tail -1 || true)
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -n "$url" ]; then TUNNEL_PID=$pid; PROVIDER=serveo; write_public "$url"; return 0; fi
  kill_quiet "$pid"; return 1
}

try_localtunnel() {
  : > "$LOG.lt"
  npx -y localtunnel --port "${PORT}" > "$LOG.lt" 2>&1 &
  local pid=$! url=""
  for _ in $(seq 1 60); do
    url=$(grep -oE 'https://[a-z0-9-]+\.loca\.lt' "$LOG.lt" | tail -1 || true)
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -n "$url" ]; then TUNNEL_PID=$pid; PROVIDER=localtunnel; write_public "$url"; return 0; fi
  kill_quiet "$pid"; return 1
}

start_tunnel() {
  try_cloudflared || try_serveo || try_localtunnel
}

start_server() {
  node --env-file-if-exists=.env src/server.ts >> "$LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 30); do
    curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1 && return 0
    sleep 1
  done
  log "server did not become healthy"
  return 1
}

cleanup() { kill_quiet "${SERVER_PID:-}"; kill_quiet "${TUNNEL_PID:-}"; }
trap cleanup EXIT INT TERM

log "=== host starting (port $PORT) ==="
lsof -ti "tcp:${PORT}" 2>/dev/null | xargs kill 2>/dev/null || true
for _ in $(seq 1 10); do lsof -ti "tcp:${PORT}" >/dev/null 2>&1 || break; sleep 1; done

while true; do
  if ! start_tunnel; then log "no tunnel provider available"; sleep 20; continue; fi
  if ! start_server; then cleanup; sleep 5; continue; fi
  log "up: $(cat "$URLFILE" 2>/dev/null)"

  while true; do
    sleep 10
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then log "server exited"; break; fi
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then log "tunnel exited"; break; fi
    if ! curl -fsS --max-time 4 "$HEALTH" >/dev/null 2>&1; then log "health check failed"; break; fi
  done

  cleanup
  sleep 3
done
